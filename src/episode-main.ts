import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  Agent,
  type AgentEvent,
  type AgentRun,
  type AgentTool,
  type AgentTools,
  type SessionHandle,
} from "@minpeter/pss-runtime";
import { z } from "zod";
import { ObservationBuilder } from "./agent/observation-builder";
import { env } from "./env";
import {
  EpisodeRunner,
  type EpisodeRunnerOptions,
  type EpisodeStepRecord,
} from "./evaluation/episode-runner";
import { EvidenceRecorder } from "./evaluation/evidence-recorder";
import {
  type EmulatorFps,
  type EpisodeRunConfig,
  normalizeEpisodeRunConfig,
  SUPPORTED_EMULATOR_FPS,
} from "./evaluation/run-config";
import { CommandExecutor } from "./executor/command-executor";
import { MgbaHttpClient } from "./mgba-http";
import {
  captureMgbaObservation,
  createObservedInput,
  type MgbaObservation,
  type ObservedAgentInput,
} from "./observation";
import { createTurnPrompt } from "./runner";
import { InputGate } from "./session/input-gate";
import { createSessionState, type MiniState } from "./session/session-state";
import { Supervisor } from "./session/supervisor";
import { StuckMemory } from "./stuck-memory";
import {
  createSupervisedMgbaClient,
  NON_DIRECTIONAL_TAP_DURATION,
  type SupervisorIntervention,
} from "./supervisor";
import { createTrackedModel, TokenUsageTracker } from "./token-usage";
import { describeMgbaControlPlane } from "./tools";
import { buttonSchema, buttonsSchema, durationSchema } from "./tools/schemas";

const VIRIDIAN_CITY_MAP_ID = 1;
const ISO_MILLISECOND_SUFFIX = /\.\d{3}Z$/;

export interface ProductionEpisodeRunnerOptions {
  agentRunFactory?: EpisodeRunnerOptions["agentRunFactory"];
  cwd?: string;
  now?: Date;
  runDir?: string;
  runtimeEnv?: NodeJS.ProcessEnv;
}

interface CreateEpisodeAgentRunFactoryOptions {
  mgbaClient?: MgbaHttpClient;
  runDir: string;
}

export async function createProductionEpisodeRunner({
  agentRunFactory,
  cwd = process.cwd(),
  now = new Date(),
  runDir = createRunDir(cwd, now),
  runtimeEnv = process.env,
}: ProductionEpisodeRunnerOptions = {}): Promise<EpisodeRunner> {
  const config = createEpisodeConfig(runtimeEnv);
  const evidence = new EvidenceRecorder(runDir, config);
  const mgbaClient = new MgbaHttpClient({ baseUrl: env.MGBA_HTTP_BASE_URL });
  const sessionState = createSessionState();
  const observationBuilder = new ObservationBuilder(mgbaClient, sessionState);
  const supervisedClient = createSupervisedMgbaClient(mgbaClient, {
    onIntervention: (intervention) =>
      recordSupervisorIntervention(evidence, intervention),
  });
  const inputGate = new InputGate({
    client: supervisedClient,
    readMiniState: async (signal) => {
      const built = await observationBuilder.build(signal);
      return miniStateFromBuiltObservation(built);
    },
    recordInput: (result) => evidence.appendJsonl("input_results", result),
    sessionMode: () => observationBuilder.sessionState.mode,
  });

  return new EpisodeRunner({
    agentRunFactory:
      agentRunFactory ??
      (await createEpisodeAgentRunFactory({ mgbaClient, runDir })),
    commandExecutor: new CommandExecutor(inputGate),
    config,
    evidence,
    isSuccess: isViridianCitySuccess,
    observationBuilder,
    recordExecutorInputResults: false,
    runDir,
    sessionState,
    supervisor: new Supervisor(),
  });
}

function createEpisodeConfig(runtimeEnv: NodeJS.ProcessEnv): EpisodeRunConfig {
  return normalizeEpisodeRunConfig({
    emulator_fps: parseEmulatorFps(runtimeEnv.EMULATOR_FPS),
    goal: "reach_viridian_city",
    llm_supervisor_interval: 100,
    max_steps: parsePositiveInt(runtimeEnv.EPISODE_MAX_STEPS, 2000),
    screenshot_interval: 100,
  });
}

export async function createEpisodeAgentRunFactory({
  mgbaClient = new MgbaHttpClient({ baseUrl: env.MGBA_HTTP_BASE_URL }),
  runDir,
}: CreateEpisodeAgentRunFactoryOptions): Promise<
  NonNullable<EpisodeRunnerOptions["agentRunFactory"]>
> {
  const provider = createOpenAICompatible({
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
    name: "pokemon",
  });
  const tokenUsageTracker = new TokenUsageTracker({
    metricsDir: join(runDir, "metrics"),
    prometheusPath: join(runDir, "metrics", "token-usage.prom"),
    runId: basename(runDir),
  });
  const recentActions: string[] = [];
  const stuckMemory = new StuckMemory();
  let pendingTurnContext:
    | Parameters<NonNullable<EpisodeRunnerOptions["agentRunFactory"]>>[0]
    | undefined;
  let currentModelObservation: MgbaObservation | undefined;
  let loggedFirstTurnSummary = false;
  let session: SessionHandle;
  const agent = await Agent.create({
    hooks: {
      beforeTurn: async ({ signal }) => {
        const context = pendingTurnContext;
        pendingTurnContext = undefined;
        if (!context) {
          return;
        }
        console.error(`[dbg] beforeTurn:enter step=${context.step}`);
        const observation = await captureMgbaObservation(mgbaClient, signal);
        console.error(`[dbg] beforeTurn:captured step=${context.step}`);
        currentModelObservation = observation;
        stuckMemory.observe(observation, context.step);
        const input = createObservedInput({
          observation,
          recentActions,
          stuckMemory: stuckMemory.snapshot(),
          text: `Fresh mGBA observation before episode step ${context.step}. Use it with the current objective prompt to choose the next control action.`,
        });
        if (!loggedFirstTurnSummary) {
          loggedFirstTurnSummary = true;
          console.error(
            `[episode-main debug] first model steer ${summarizeObservedInput(input)}`
          );
        }
        await session.steer(input);
      },
    },
    instructions: createEpisodeInstructions(),
    model: createTrackedModel({
      model: provider(env.AI_MODEL),
      tracker: tokenUsageTracker,
    }),
    toolChoice: "required",
    tools: createEpisodeCommandTools(),
  });
  session = agent.session("pokemon-episode-run");

  return async (context) => {
    console.error(`[dbg] factory:invoke step=${context.step}`);
    tokenUsageTracker.startTurn(context.step);
    pendingTurnContext = context;
    console.error(`[dbg] factory:before-send step=${context.step}`);
    const run = await session.send(createTurnPrompt(context.step));
    console.error(`[dbg] factory:after-send step=${context.step}`);
    return observeRun(
      run,
      (event) => {
        recordRecentAction(event, recentActions);
        if (currentModelObservation && isControlToolCall(event)) {
          stuckMemory.recordEvent(event, currentModelObservation, context.step);
        }
      },
      async () => {
        pendingTurnContext = undefined;
        currentModelObservation = undefined;
        await tokenUsageTracker.endTurn();
      }
    );
  };
}

function createEpisodeInstructions(): string {
  return [
    "You are a concise Pokemon-playing control agent.",
    describeMgbaControlPlane(),
    "The episode runner injects the latest observation and executes exactly one selected control command through the local InputGate.",
    "Use the tool names to express the intended command only; do not assume direct tool execution has advanced the emulator.",
    "When playing autonomously, use a loop of injected observation -> decide -> one action -> brief summary.",
    "Use red movement guide lines to distinguish blocked cells, open walkable cells, and interactable-looking objects. Prefer exploring open unseen space or facing likely objects and pressing A.",
    "Movement duration calibration: 10=1 red cell, 20=2 cells, 45=3 cells, 60=4 cells, 75=5 cells, 90=6 cells. Near obstacles, move one cell and re-observe.",
    "Track recent action context from the injected observation and avoid repeating actions that did not visibly change progress.",
    "Before any tool call, output exactly one <action_plan>...</action_plan> block containing the medium-term goal, visible blocked/open/object assessment, intended target, next action, and recent repetition to avoid.",
    "Keep final user-facing answers under 3 lines, but use tools whenever game control is requested.",
    ...(env.STRATEGY_PROMPT_FILE
      ? [
          `Strategy directive for this run (follow it while respecting all rules above):\n${readFileSync(
            env.STRATEGY_PROMPT_FILE,
            "utf8"
          ).trim()}`,
        ]
      : []),
  ].join("\n\n");
}

function createEpisodeCommandTools(): AgentTools {
  return {
    mgba_hold: createQueuedHoldTool(),
    mgba_hold_many: createQueuedHoldManyTool(),
    mgba_release: createQueuedReleaseTool(),
    mgba_tap: createQueuedTapTool(),
    mgba_tap_many: createQueuedTapManyTool(),
  } satisfies AgentTools;
}

function createQueuedTapTool(): AgentTool {
  return {
    description:
      "버튼 하나를 짧게 눌렀다 뗍니다. Supervisor가 A/B/Start/Select 같은 비방향 입력은 duration 6으로, 방향 입력은 안전한 단일 이동 duration 12로 실행합니다.",
    inputSchema: z.object({ button: buttonSchema }),
    execute: async ({ button }) => ({
      duration: NON_DIRECTIONAL_TAP_DURATION,
      ok: true,
      queued: true,
      tapped: button,
    }),
  } satisfies AgentTool;
}

function createQueuedTapManyTool(): AgentTool {
  return {
    description:
      "여러 버튼을 동시에 짧게 눌렀다 뗍니다. 조합 입력이 필요할 때만 사용하세요. 일반 이동은 단일 방향 mgba_hold를 사용하세요.",
    inputSchema: z.object({ buttons: buttonsSchema }),
    execute: async ({ buttons }) => ({
      duration: NON_DIRECTIONAL_TAP_DURATION,
      ok: true,
      queued: true,
      tapped: buttons,
    }),
  } satisfies AgentTool;
}

function createQueuedHoldTool(): AgentTool {
  return {
    description:
      "버튼 하나를 지정한 프레임 동안 유지합니다. 이동에는 방향키 hold를 기본으로 사용하세요. Supervisor가 방향키 hold를 duration 12의 단일 타일 이동으로 고정하고, 긴 이동 입력은 안전하게 축소합니다.",
    inputSchema: z.object({ button: buttonSchema, duration: durationSchema }),
    execute: async ({ button, duration }) => ({
      duration,
      held: button,
      ok: true,
      queued: true,
    }),
  } satisfies AgentTool;
}

function createQueuedHoldManyTool(): AgentTool {
  return {
    description:
      "여러 버튼을 지정한 프레임 동안 동시에 유지합니다. 필요한 비방향 조합 입력에만 사용하세요. Supervisor는 방향키 multi-hold 이동을 거부합니다.",
    inputSchema: z.object({ buttons: buttonsSchema, duration: durationSchema }),
    execute: async ({ buttons, duration }) => ({
      duration,
      held: buttons,
      ok: true,
      queued: true,
    }),
  } satisfies AgentTool;
}

function createQueuedReleaseTool(): AgentTool {
  return {
    description:
      "눌린 상태로 남아 있는 버튼을 해제합니다. button을 생략하면 모든 GBA 버튼을 해제합니다.",
    inputSchema: z.object({ button: buttonSchema.optional() }),
    execute: async ({ button }) => ({
      ok: true,
      queued: true,
      released: button ? [button] : "ALL",
    }),
  } satisfies AgentTool;
}

function observeRun(
  run: AgentRun,
  onEvent: (event: AgentEvent) => void,
  finalize: () => Promise<void>
): AgentRun {
  return {
    stream(): AsyncIterable<AgentEvent> {
      const stream = run.stream();
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          try {
            for await (const event of stream) {
              onEvent(event);
              yield event;
            }
          } finally {
            await finalize();
          }
        },
      };
    },
  };
}

function recordRecentAction(event: AgentEvent, recentActions: string[]): void {
  if (!isControlToolCall(event)) {
    return;
  }

  recentActions.push(formatAction(event.toolName, event.input));
  recentActions.splice(0, Math.max(0, recentActions.length - 10));
}

function isControlToolCall(
  event: AgentEvent
): event is Extract<AgentEvent, { type: "tool-call" }> {
  return event.type === "tool-call" && event.toolName.startsWith("mgba_");
}

function formatAction(toolName: string, input: unknown): string {
  return `${toolName.replace("mgba_", "")}: ${JSON.stringify(input)}`;
}

function summarizeObservedInput(input: ObservedAgentInput): string {
  const imageParts = input.filter((part) => part.type === "image");
  const textBytes = input
    .filter((part) => part.type === "text")
    .reduce((bytes, part) => bytes + Buffer.byteLength(part.text), 0);
  const imageBytes = imageParts.reduce((bytes, part) => {
    const base64 = part.image.includes(",")
      ? part.image.slice(part.image.indexOf(",") + 1)
      : part.image;
    return bytes + Buffer.byteLength(base64, "base64");
  }, 0);

  return `parts=${input.length} image=${imageParts.length > 0} text_bytes=${textBytes} image_bytes=${imageBytes} total_bytes=${textBytes + imageBytes}`;
}

function createRunDir(cwd: string, now: Date): string {
  const timestamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(ISO_MILLISECOND_SUFFIX, "Z");
  return join(cwd, "runs", `run_${timestamp}_episode`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function parseEmulatorFps(value: string | undefined): EmulatorFps {
  if (!value) {
    return 240;
  }
  const parsed = Number(value);
  if (!SUPPORTED_EMULATOR_FPS.includes(parsed as EmulatorFps)) {
    throw new Error(
      `Unsupported EMULATOR_FPS ${value}. Supported values: ${SUPPORTED_EMULATOR_FPS.join(", ")}`
    );
  }
  return parsed as EmulatorFps;
}

function miniStateFromBuiltObservation({
  observation,
  sessionState,
}: Awaited<ReturnType<ObservationBuilder["build"]>>): MiniState {
  return {
    frame: observation.status.frame,
    mapId: observation.state?.mapId,
    mode: sessionState.mode,
    x: observation.state?.position.x,
    y: observation.state?.position.y,
  };
}

function isViridianCitySuccess(record: EpisodeStepRecord): boolean {
  return record.transition.to?.mapId === VIRIDIAN_CITY_MAP_ID;
}

function recordSupervisorIntervention(
  evidence: EvidenceRecorder,
  intervention: SupervisorIntervention
): void {
  evidence
    .appendJsonl("supervisor_hints", {
      intervention,
      kind: "mgba-supervisor-intervention",
      timestamp: new Date().toISOString(),
    })
    .catch(() => undefined);
}

async function main(): Promise<void> {
  const episodeRunner = await createProductionEpisodeRunner();
  const result = await episodeRunner.run();
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
