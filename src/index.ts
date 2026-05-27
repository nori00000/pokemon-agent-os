import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent, type SessionHandle } from "@minpeter/pss-runtime";
import { env } from "./env";
import { startMetricsServer } from "./metrics-server";
import { MgbaHttpClient } from "./mgba-http";
import {
  captureMgbaObservation,
  createObservedInput,
  type MgbaObservation,
} from "./observation";
import { ObservationBookkeeping } from "./observation-bookkeeping";
import { PokemonMilestoneTracker } from "./pokemon-milestones";
import { createPrettyLogger } from "./pretty-log";
import { RunMetricsTracker } from "./run-metrics";
import {
  createOptimizedFreshRunTrace,
  updateRunTraceMetadata,
} from "./run-trace";
import { createTurnPrompt, streamSupervisedRun } from "./runner";
import { StuckMemory } from "./stuck-memory";
import {
  createSupervisorEvent,
  type SupervisorIntervention,
  waitThroughBlackFrames,
} from "./supervisor";
import { createTrackedModel, TokenUsageTracker } from "./token-usage";
import { createMgbaControlPlane, describeMgbaControlPlane } from "./tools";
import { createViewerEventRecorder } from "./viewer-recorder";

const provider = createOpenAICompatible({
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
  name: "pokemon",
});

const instructions = [
  "You are a concise Pokemon-playing control agent.",
  describeMgbaControlPlane(),
  "When playing autonomously, use a loop of injected observation -> decide -> one action -> brief summary.",
  "Use red movement guide lines to distinguish blocked cells, open walkable cells, and interactable-looking objects. Prefer exploring open unseen space or facing likely objects and pressing A.",
  "Movement duration calibration: 10=1 red cell, 20=2 cells, 45=3 cells, 60=4 cells, 75=5 cells, 90=6 cells. Longer movement is possible with larger duration on clearly open straight paths; near obstacles, move one cell and re-observe.",
  "Track recent action context and avoid repeating actions that did not visibly change progress.",
  "Before any tool call, output exactly one <action_plan>...</action_plan> block containing the medium-term goal, visible blocked/open/object assessment, intended target, next action, and recent repetition to avoid.",
  "Keep final user-facing answers under 3 lines, but use tools whenever game control is requested.",
].join("\n\n");
const mgbaClient = new MgbaHttpClient({ baseUrl: env.MGBA_HTTP_BASE_URL });
const tools = createMgbaControlPlane({
  client: mgbaClient,
  onSupervisorIntervention: recordSupervisorIntervention,
});
let runTrace = await createOptimizedFreshRunTrace();
const viewerEventRecorder = createViewerEventRecorder({ trace: runTrace });
const prettyLogger = createPrettyLogger();
prettyLogger.runTrace(runTrace);
const runMetricsTracker = new RunMetricsTracker({
  experimentId: runTrace.experimentId,
  iteration: runTrace.iteration,
  mode: runTrace.mode,
  runId: runTrace.runId,
});
const tokenUsageTracker = new TokenUsageTracker({
  iteration: runTrace.iteration,
  metricsDir: runTrace.metricsDir,
  runId: runTrace.runId,
  onMetric: prettyLogger.tokenUsage,
});

startMetricsServer(tokenUsageTracker, runMetricsTracker, {
  host: env.METRICS_HTTP_HOST,
  port: env.METRICS_HTTP_PORT,
});

const recentActions: string[] = [];
const milestoneTracker = new PokemonMilestoneTracker();
const stuckMemory = new StuckMemory();
const observationBookkeeping = new ObservationBookkeeping({
  runMetricsTracker,
  stuckMemory,
});
let session: SessionHandle;
let turnsRun = 0;

const agent = await Agent.create({
  hooks: {
    afterStep: async ({ result, signal, stepIndex }) => {
      if (result !== "continue") {
        return;
      }

      await waitThroughBlackFrames({
        client: mgbaClient,
        onIntervention: recordSupervisorIntervention,
        signal,
      });
      const observation = await captureMgbaObservation(mgbaClient, signal);
      observationBookkeeping.promoteObservation(observation, turnsRun);
      await session.steer(
        createObservedInput({
          observation,
          recentActions,
          stuckMemory: stuckMemory.snapshot(),
          text: `Fresh mGBA observation after continuing step ${stepIndex + 1}.`,
        })
      );
    },
    beforeTurn: async ({ signal }) => {
      const observation = await captureMgbaObservation(mgbaClient, signal);
      await recordTurnObservation(observation);
      await session.steer(
        createObservedInput({
          observation,
          recentActions,
          stuckMemory: stuckMemory.snapshot(),
          text: `Fresh mGBA observation before turn ${turnsRun}. Use it with the current objective prompt to choose the next control action.`,
        })
      );
    },
  },
  instructions,
  model: createTrackedModel({
    model: provider(env.AI_MODEL),
    tracker: tokenUsageTracker,
  }),
  toolChoice: "required",
  tools,
});

session = agent.session("pokemon-run");

while (true) {
  turnsRun += 1;
  tokenUsageTracker.startTurn(turnsRun);
  observationBookkeeping.clearCurrentObservation();

  const run = await session.send(createTurnPrompt(turnsRun));
  await streamSupervisedRun({
    client: mgbaClient,
    onEvent: (event) => {
      runMetricsTracker.recordEvent(event);
      observationBookkeeping.recordEvent(event, turnsRun);
      recordRecentAction(event, recentActions);
      prettyLogger.event(event as never);
      fireAndReportViewerWrite(
        viewerEventRecorder.recordEvent(event, { turn: turnsRun })
      );
    },
    run,
  });
  await tokenUsageTracker.endTurn();
  await persistRunMetricsMetadata();
}

async function recordTurnObservation(
  observation: MgbaObservation
): Promise<void> {
  observationBookkeeping.promoteObservation(observation, turnsRun);
  prettyLogger.observationInjection({
    nextTurn: turnsRun,
    observation,
  });
  await viewerEventRecorder.recordObservation(turnsRun, observation);

  const milestone = milestoneTracker.observe(observation);
  if (milestone.furthest && milestone.furthest !== runTrace.milestoneFurthest) {
    runTrace = await updateRunTraceMetadata(runTrace, {
      milestone: milestone.furthest,
      milestoneCurrent: milestone.current ?? undefined,
      milestoneFurthest: milestone.furthest,
    });
  }
}

function recordRecentAction(event: unknown, recentActions: string[]): void {
  if (!isControlToolCall(event)) {
    return;
  }

  recentActions.push(formatAction(event.toolName, event.input));
  recentActions.splice(0, Math.max(0, recentActions.length - 10));
}

function isControlToolCall(
  event: unknown
): event is { input: unknown; toolName: string; type: "tool-call" } {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "tool-call" &&
    "toolName" in event &&
    typeof event.toolName === "string" &&
    [
      "mgba_tap",
      "mgba_tap_many",
      "mgba_hold",
      "mgba_hold_many",
      "mgba_release",
    ].includes(event.toolName)
  );
}

function formatAction(toolName: string, input: unknown): string {
  return `${toolName.replace("mgba_", "")}: ${JSON.stringify(input)}`;
}

function recordSupervisorIntervention(
  intervention: SupervisorIntervention
): void {
  runMetricsTracker.recordSupervisorIntervention(intervention.reason);
  const event = createSupervisorEvent(intervention);
  prettyLogger.event(event as never);
  fireAndReportViewerWrite(
    viewerEventRecorder.recordEvent(event, { turn: turnsRun })
  );
}

async function persistRunMetricsMetadata(): Promise<void> {
  const snapshot = runMetricsTracker.snapshot();
  if (
    snapshot.stuckEvents === runTrace.stuckEvents &&
    snapshot.supervisorInterventions === runTrace.supervisorInterventions
  ) {
    return;
  }

  runTrace = await updateRunTraceMetadata(runTrace, {
    stuckEvents: snapshot.stuckEvents,
    supervisorInterventions: snapshot.supervisorInterventions,
  });
}

function fireAndReportViewerWrite(write: Promise<void>): void {
  write.catch((error: unknown) => {
    console.dir({
      message: error instanceof Error ? error.message : String(error),
      type: "viewer-recorder-error",
    });
  });
}
