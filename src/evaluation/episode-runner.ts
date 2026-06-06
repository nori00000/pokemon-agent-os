import type { AgentEvent, AgentRun } from "@minpeter/pss-runtime";
import { CommandAgentRunner } from "../agent/command-agent-runner";
import {
  type BuiltObservation,
  ObservationBuilder,
} from "../agent/observation-builder";
import { env } from "../env";
import {
  type CommandExecutionResult,
  CommandExecutor,
  type GameCommand,
} from "../executor/command-executor";
import { type MgbaButton, MgbaHttpClient } from "../mgba-http";
import type { MgbaObservation } from "../observation";
import { PokemonMilestoneTracker } from "../pokemon-milestones";
import { InputGate, type InputResult } from "../session/input-gate";
import {
  createSessionState,
  type MiniState,
  type SessionState,
} from "../session/session-state";
import { Supervisor, type SupervisorHint } from "../session/supervisor";
import type { StateTransition } from "../session/transition-detector";
import { StuckMemory } from "../stuck-memory";
import { createSupervisedMgbaClient } from "../supervisor";
import { EvidenceRecorder } from "./evidence-recorder";
import { calculateTransitionReward, type RewardBreakdown } from "./reward";
import {
  type EpisodeRunConfig,
  emulatorFpsContractNote,
  normalizeEpisodeRunConfig,
} from "./run-config";

export type EpisodeStopReason = "completed" | "hard-failure" | "max-steps";

export interface EpisodeStepContext {
  observation: MgbaObservation;
  runConfig: EpisodeRunConfig;
  sessionState: SessionState;
  step: number;
}

export interface EpisodeStepRecord {
  action_count: number;
  ignored_count: number;
  input?: InputResult;
  reward: RewardBreakdown;
  session_mode: SessionState["mode"];
  step: number;
  stuck_events: number;
  transition: StateTransition;
}

export interface EpisodeRunResult {
  reason: EpisodeStopReason;
  steps: number;
}

export interface EpisodeClock {
  now(): Date;
}

export interface EpisodeRunnerOptions {
  agentRunFactory?: (context: EpisodeStepContext) => Promise<AgentRun>;
  clock?: EpisodeClock;
  commandExecutor?: Pick<CommandExecutor, "executeOne">;
  config?: Partial<EpisodeRunConfig>;
  evidence?: EvidenceRecorder;
  isHardFailure?: (context: EpisodeStepRecord) => boolean;
  isSuccess?: (context: EpisodeStepRecord) => boolean;
  observationBuilder?: Pick<ObservationBuilder, "build" | "sessionState">;
  policy?: (
    context: EpisodeStepContext
  ) => Promise<readonly GameCommand[]> | readonly GameCommand[];
  recordExecutorInputResults?: boolean;
  runDir: string;
  sessionState?: SessionState;
  supervisor?: Pick<Supervisor, "evaluateInput">;
}

export class EpisodeRunner {
  readonly #agentRunFactory:
    | ((context: EpisodeStepContext) => Promise<AgentRun>)
    | undefined;
  readonly #clock: EpisodeClock;
  readonly #commandExecutor: Pick<CommandExecutor, "executeOne">;
  readonly #isHardFailure: (context: EpisodeStepRecord) => boolean;
  readonly #isSuccess: (context: EpisodeStepRecord) => boolean;
  readonly #observationBuilder: Pick<
    ObservationBuilder,
    "build" | "sessionState"
  >;
  readonly #policy:
    | ((
        context: EpisodeStepContext
      ) => Promise<readonly GameCommand[]> | readonly GameCommand[])
    | undefined;
  readonly #recordExecutorInputResults: boolean;
  readonly #supervisor: Pick<Supervisor, "evaluateInput">;
  readonly config: EpisodeRunConfig;
  readonly evidence: EvidenceRecorder;

  constructor({
    agentRunFactory,
    clock = systemClock,
    commandExecutor,
    config,
    evidence,
    isHardFailure = () => false,
    isSuccess = () => false,
    observationBuilder,
    policy,
    recordExecutorInputResults,
    runDir,
    sessionState = createSessionState(),
    supervisor = new Supervisor(),
  }: EpisodeRunnerOptions) {
    this.config = normalizeEpisodeRunConfig(config);
    this.evidence = evidence ?? new EvidenceRecorder(runDir, this.config);
    this.#agentRunFactory = agentRunFactory;
    this.#clock = clock;
    this.#isHardFailure = isHardFailure;
    this.#isSuccess = isSuccess;
    this.#policy = policy;
    this.#supervisor = supervisor;

    if (observationBuilder && commandExecutor) {
      this.#observationBuilder = observationBuilder;
      this.#commandExecutor = commandExecutor;
      this.#recordExecutorInputResults = recordExecutorInputResults ?? true;
      return;
    }

    const client = new MgbaHttpClient({ baseUrl: env.MGBA_HTTP_BASE_URL });
    const supervisedClient = createSupervisedMgbaClient(client, {
      onIntervention: (intervention) => {
        this.evidence
          .appendJsonl("supervisor_hints", {
            intervention,
            kind: "mgba-supervisor-intervention",
            timestamp: this.#clock.now().toISOString(),
          })
          .catch(() => undefined);
      },
    });
    let liveSessionState = sessionState;
    const readMiniState = async (signal?: AbortSignal): Promise<MiniState> => {
      const observation = await this.#observationBuilder.build(signal);
      liveSessionState = observation.sessionState;
      return miniStateFromObservation(observation);
    };
    this.#observationBuilder =
      observationBuilder ?? new ObservationBuilder(client, liveSessionState);
    const inputGate = new InputGate({
      client: supervisedClient,
      readMiniState,
      recordInput: (result) =>
        this.evidence.appendJsonl("input_results", result),
      sessionMode: () => this.#observationBuilder.sessionState.mode,
    });
    this.#commandExecutor = commandExecutor ?? new CommandExecutor(inputGate);
    this.#recordExecutorInputResults = recordExecutorInputResults ?? false;
  }

  async initializeOnly(): Promise<void> {
    await this.evidence.initialize();
    await this.evidence.appendJsonl("session_events", {
      kind: "episode-config",
      note: emulatorFpsContractNote(this.config),
    });
  }

  async run(signal?: AbortSignal): Promise<EpisodeRunResult> {
    await this.initializeOnly();

    const stuckMemory = new StuckMemory();
    const milestoneTracker = new PokemonMilestoneTracker();
    let repeatedNoneTransitions = 0;

    for (let step = 1; step <= this.config.max_steps; step += 1) {
      signal?.throwIfAborted();
      const built = await this.#observationBuilder.build(signal);
      const stepContext: EpisodeStepContext = {
        observation: built.observation,
        runConfig: this.config,
        sessionState: built.sessionState,
        step,
      };
      await this.#recordSessionEvents(built.sessionState.events, step);
      await this.evidence.appendJsonl("agent_steps", {
        kind: "observation",
        session_mode: built.sessionState.mode,
        step,
        timestamp: this.#clock.now().toISOString(),
      });

      const commands = await this.#chooseCommands(stepContext);
      const execution = await this.#commandExecutor.executeOne(commands);
      await this.#recordCommandExecution(step, commands, execution);

      if (execution.result) {
        if (this.#recordExecutorInputResults) {
          await this.evidence.appendJsonl("input_results", execution.result);
        }
        const event = toolCallEventFromInput(execution.result);
        if (event) {
          stuckMemory.recordEvent(event, built.observation, step);
        }
      }

      const nextBuilt = await this.#observationBuilder.build(signal);
      stuckMemory.observe(nextBuilt.observation, step);
      const milestone = milestoneTracker.observe({
        state: nextBuilt.observation.state,
        status: nextBuilt.observation.status,
      });

      const transition = execution.result?.transition ?? {
        before: miniStateFromObservation(built),
        from: miniStateFromObservation(built),
        kind: "none" as const,
        to: miniStateFromObservation(nextBuilt),
      };
      repeatedNoneTransitions =
        transition.kind === "none" ? repeatedNoneTransitions + 1 : 0;
      const reward = calculateTransitionReward(
        transition,
        repeatedNoneTransitions
      );
      const stuckSnapshot = stuckMemory.snapshot();
      const stepRecord: EpisodeStepRecord = {
        action_count: commands.length,
        ignored_count: execution.ignored.length,
        input: execution.result,
        reward,
        session_mode: built.sessionState.mode,
        step,
        stuck_events: stuckSnapshot.stuckEvents,
        transition,
      };

      await this.evidence.appendJsonl("transitions", {
        milestone,
        step,
        transition,
      });
      await this.evidence.appendJsonl("transition_trace", {
        input: execution.result,
        reward,
        step,
        stuck: stuckSnapshot,
        transition,
      });
      await this.evidence.appendJsonl("reward_logs", {
        reward,
        step,
        transition_kind: transition.kind,
      });

      const hint = execution.result
        ? this.#supervisor.evaluateInput(execution.result, step)
        : undefined;
      await this.#recordSupervisorHint(hint, step);

      if (this.#isSuccess(stepRecord)) {
        await this.#recordStop("completed", step);
        return { reason: "completed", steps: step };
      }
      if (this.#isHardFailure(stepRecord)) {
        await this.#recordStop("hard-failure", step);
        return { reason: "hard-failure", steps: step };
      }
    }

    await this.#recordStop("max-steps", this.config.max_steps);
    return { reason: "max-steps", steps: this.config.max_steps };
  }

  async #chooseCommands(
    context: EpisodeStepContext
  ): Promise<readonly GameCommand[]> {
    if (this.#policy) {
      return await this.#policy(context);
    }
    if (!this.#agentRunFactory) {
      await this.evidence.appendJsonl("session_events", {
        kind: "no-policy",
        note: "No policy or agentRunFactory was configured; using wait command.",
        step: context.step,
      });
      return [{ kind: "wait" }];
    }

    const run = await this.#agentRunFactory(context);
    const events: unknown[] = [];
    await new CommandAgentRunner(run).run({
      onEvent: (event) => {
        events.push(event);
      },
    });
    for (const event of events) {
      await this.evidence.appendJsonl("agent_steps", {
        event,
        kind: "agent-event",
        step: context.step,
      });
    }
    return events.flatMap(commandFromAgentEvent);
  }

  async #recordCommandExecution(
    step: number,
    commands: readonly GameCommand[],
    execution: CommandExecutionResult
  ): Promise<void> {
    await this.evidence.appendJsonl("command_history", {
      commands,
      ignored: execution.ignored,
      result: execution.result,
      step,
    });
    await this.evidence.appendJsonl("agent_steps", {
      executed: execution.result,
      ignored_count: execution.ignored.length,
      kind: "command-execution",
      step,
    });
  }

  async #recordSessionEvents(
    events: readonly SessionState["events"][number][],
    step: number
  ): Promise<void> {
    for (const event of events) {
      await this.evidence.appendJsonl("session_events", { ...event, step });
    }
  }

  async #recordSupervisorHint(
    hint: SupervisorHint | undefined,
    step: number
  ): Promise<void> {
    if (!hint) {
      return;
    }
    await this.evidence.appendJsonl("supervisor_hints", { ...hint, step });
  }

  async #recordStop(reason: EpisodeStopReason, step: number): Promise<void> {
    await this.evidence.appendJsonl("session_events", {
      kind: "episode-stop",
      reason,
      step,
      timestamp: this.#clock.now().toISOString(),
    });
  }
}

const systemClock: EpisodeClock = {
  now: () => new Date(),
};

function miniStateFromObservation({
  observation,
  sessionState,
}: BuiltObservation): MiniState {
  return {
    frame: observation.status.frame,
    mapId: observation.state?.mapId,
    mode: sessionState.mode,
    x: observation.state?.position.x,
    y: observation.state?.position.y,
  };
}

function commandFromAgentEvent(event: unknown): GameCommand[] {
  if (!isToolCallEvent(event)) {
    return [];
  }
  if (event.toolName === "mgba_release") {
    return [{ kind: "release-all" }];
  }
  if (event.toolName === "mgba_tap") {
    const button = buttonFromInput(event.input);
    return button ? [{ button, intent: "dialog", kind: "press" }] : [];
  }
  if (event.toolName === "mgba_hold") {
    const button = buttonFromInput(event.input);
    const frames = framesFromInput(event.input);
    return button
      ? [{ button, frames, intent: "navigation", kind: "press" }]
      : [];
  }
  return [];
}

function toolCallEventFromInput(result: InputResult): AgentEvent | undefined {
  if (result.button === "ALL" || result.button === "WAIT") {
    return;
  }
  const toolName = result.intent === "navigation" ? "mgba_hold" : "mgba_tap";
  return {
    input: { button: result.button, duration: result.frames },
    toolCallId: `episode-step-${result.before.frame ?? "unknown"}`,
    toolName,
    type: "tool-call",
  } as AgentEvent;
}

function isToolCallEvent(
  event: unknown
): event is Extract<AgentEvent, { type: "tool-call" }> {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "tool-call" &&
    "toolName" in event &&
    typeof event.toolName === "string"
  );
}

function buttonFromInput(input: unknown): MgbaButton | undefined {
  if (
    typeof input === "object" &&
    input !== null &&
    "button" in input &&
    typeof input.button === "string"
  ) {
    return input.button as MgbaButton;
  }
  return;
}

function framesFromInput(input: unknown): number | undefined {
  if (
    typeof input === "object" &&
    input !== null &&
    "duration" in input &&
    typeof input.duration === "number"
  ) {
    return input.duration;
  }
  return;
}
