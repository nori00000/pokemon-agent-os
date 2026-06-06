import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, AgentRun } from "@minpeter/pss-runtime";
import { describe, expect, it, vi } from "vitest";
import type { BuiltObservation } from "../src/agent/observation-builder";
import {
  createEpisodeAgentRunFactory,
  createProductionEpisodeRunner,
} from "../src/episode-main";
import { EpisodeRunner } from "../src/evaluation/episode-runner";
import { EvidenceRecorder } from "../src/evaluation/evidence-recorder";
import { normalizeEpisodeRunConfig } from "../src/evaluation/run-config";
import {
  CommandExecutor,
  type GameCommand,
} from "../src/executor/command-executor";
import type { MgbaStatus } from "../src/mgba-http";
import type { MgbaObservation } from "../src/observation";
import type { PokemonStateObservation } from "../src/pokemon-state";
import { InputGate, type InputResult } from "../src/session/input-gate";
import {
  createSessionState,
  type MiniState,
} from "../src/session/session-state";
import {
  detectTransition,
  type StateTransition,
} from "../src/session/transition-detector";

const runtimeMock = vi.hoisted(() => {
  interface RuntimeHooks {
    beforeTurn?: (context: { signal?: AbortSignal }) => Promise<void> | void;
  }

  class FakeRuntimeSession {
    readonly hooks: RuntimeHooks;
    readonly steeredInputs: unknown[] = [];

    constructor(hooks: RuntimeHooks) {
      this.hooks = hooks;
    }

    send(input: unknown): Promise<AgentRun> {
      if (Array.isArray(input)) {
        return Promise.resolve(new HangingRun());
      }
      return Promise.resolve(new SteeringRequiredRun(this));
    }

    steer(input: unknown): Promise<void> {
      this.steeredInputs.push(input);
      return Promise.resolve();
    }
  }

  class FakeRuntimeAgent {
    readonly hooks: RuntimeHooks;
    readonly sessions: FakeRuntimeSession[] = [];

    constructor({ hooks = {} }: { hooks?: RuntimeHooks }) {
      this.hooks = hooks;
    }

    session(): FakeRuntimeSession {
      const session = new FakeRuntimeSession(this.hooks);
      this.sessions.push(session);
      return session;
    }
  }

  class HangingRun implements AgentRun {
    stream(): AsyncIterable<AgentEvent> {
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          await new Promise(() => undefined);
        },
      };
    }
  }

  class SteeringRequiredRun implements AgentRun {
    readonly #session: FakeRuntimeSession;

    constructor(session: FakeRuntimeSession) {
      this.#session = session;
    }

    stream(): AsyncIterable<AgentEvent> {
      const session = this.#session;
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          yield { type: "turn-start" } as AgentEvent;
          await session.hooks.beforeTurn?.({});
          if (session.steeredInputs.length === 0) {
            await new Promise(() => undefined);
          }
          yield {
            input: session.steeredInputs.at(-1),
            placement: "turn-start",
            type: "runtime-input",
          } as AgentEvent;
          yield toolCall("mgba_hold", { button: "Up", duration: 12 });
          yield { type: "turn-end" } as AgentEvent;
        },
      };
    }
  }

  const agents: FakeRuntimeAgent[] = [];

  return {
    agents,
    createAgent: vi.fn((options: { hooks?: RuntimeHooks }) => {
      const agent = new FakeRuntimeAgent(options);
      agents.push(agent);
      return Promise.resolve(agent);
    }),
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => () => ({}),
}));

vi.mock("@minpeter/pss-runtime", async () => ({
  Agent: { create: runtimeMock.createAgent },
}));

describe("EpisodeRunner", () => {
  it("advances the step loop and stops at max_steps", async () => {
    const runDir = await makeRunDir("advance");
    const policySteps: number[] = [];
    const executorCalls: GameCommand[][] = [];
    try {
      const runner = new EpisodeRunner({
        commandExecutor: {
          executeOne: (commands) => {
            executorCalls.push([...commands]);
            return Promise.resolve({
              ignored: [],
              result: inputResult("Up", movement(1, 5, 4)),
            });
          },
        },
        config: { max_steps: 3 },
        observationBuilder: new FakeObservationBuilder(
          repeatedObservations(8, 5)
        ),
        policy: ({ step }) => {
          policySteps.push(step);
          return [{ button: "Up", intent: "navigation", kind: "press" }];
        },
        runDir,
      });

      const result = await runner.run();

      expect(result).toEqual({ reason: "max-steps", steps: 3 });
      expect(policySteps).toEqual([1, 2, 3]);
      expect(executorCalls).toHaveLength(3);
      await expectJsonlLength(join(runDir, "agent_steps.jsonl"), 6);
      await expectJsonlLength(join(runDir, "reward_logs.jsonl"), 3);
    } finally {
      await rm(runDir, { force: true, recursive: true });
    }
  });

  it("uses CommandAgentRunner to enforce one game action per turn", async () => {
    const runDir = await makeRunDir("one-action");
    const executorCalls: GameCommand[][] = [];
    try {
      const runner = new EpisodeRunner({
        agentRunFactory: () =>
          Promise.resolve(
            new FakeRun([
              toolCall("mgba_hold", { button: "Up", duration: 12 }),
              toolCall("mgba_hold", { button: "Left", duration: 12 }),
            ])
          ),
        commandExecutor: {
          executeOne: (commands) => {
            executorCalls.push([...commands]);
            return Promise.resolve({
              ignored: [],
              result: inputResult("Up", movement(1, 5, 4)),
            });
          },
        },
        config: { max_steps: 1 },
        observationBuilder: new FakeObservationBuilder(
          repeatedObservations(3, 5)
        ),
        runDir,
      });

      await runner.run();

      expect(executorCalls).toEqual([
        [{ button: "Up", frames: 12, intent: "navigation", kind: "press" }],
      ]);
      const agentSteps = await readJsonl(join(runDir, "agent_steps.jsonl"));
      expect(agentSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              reason: "one-game-action-per-turn",
              type: "command-agent-runner-intervention",
            }),
          }),
        ])
      );
    } finally {
      await rm(runDir, { force: true, recursive: true });
    }
  });

  it("logs transition-kind reward from the executed input result", async () => {
    const runDir = await makeRunDir("reward");
    try {
      const runner = new EpisodeRunner({
        commandExecutor: {
          executeOne: () =>
            Promise.resolve({
              ignored: [],
              result: inputResult("Right", movement(3, 2, 3)),
            }),
        },
        config: { max_steps: 1 },
        observationBuilder: new FakeObservationBuilder(
          repeatedObservations(3, 2)
        ),
        policy: () => [
          { button: "Right", intent: "navigation", kind: "press" },
        ],
        runDir,
      });

      await runner.run();

      const rewards = await readJsonl(join(runDir, "reward_logs.jsonl"));
      expect(rewards[0]).toMatchObject({
        reward: {
          components: { navigation_reward: 0.4 },
          reward_total: 0.4,
        },
        transition_kind: "movement",
      });
    } finally {
      await rm(runDir, { force: true, recursive: true });
    }
  });

  it("updates stuck memory for repeated wall-loop transitions", async () => {
    const runDir = await makeRunDir("stuck");
    try {
      const runner = new EpisodeRunner({
        commandExecutor: {
          executeOne: () =>
            Promise.resolve({
              ignored: [],
              result: inputResult("Up", noneTransition(7, 4, 4)),
            }),
        },
        config: { max_steps: 8 },
        isHardFailure: ({ stuck_events }) => stuck_events > 0,
        observationBuilder: new FakeObservationBuilder(
          repeatedObservations(20, 4)
        ),
        policy: () => [{ button: "Up", intent: "navigation", kind: "press" }],
        runDir,
      });

      const result = await runner.run();

      expect(result).toEqual({ reason: "hard-failure", steps: 8 });
      const trace = await readJsonl(join(runDir, "transition_trace.jsonl"));
      expect(trace.at(-1)).toMatchObject({
        stuck: { stuckEvents: 1 },
        transition: { kind: "none" },
      });
    } finally {
      await rm(runDir, { force: true, recursive: true });
    }
  });
});

describe("InputGate evidence wiring", () => {
  it("logs accepted and rejected input_results without live mGBA", async () => {
    const runDir = await makeRunDir("input-gate");
    try {
      const recorder = new EvidenceRecorder(
        runDir,
        normalizeEpisodeRunConfig()
      );
      await recorder.initialize();
      const states: MiniState[] = [
        { frame: 1, mapId: 1, mode: "overworld", x: 4, y: 5 },
        { frame: 2, mapId: 1, mode: "overworld", x: 4, y: 4 },
        { frame: 3, mapId: 1, mode: "dialog", x: 4, y: 4 },
      ];
      let readCount = 0;
      let mode: MiniState["mode"] = "overworld";
      const gate = new InputGate({
        client: fakeClient(),
        readMiniState: async () =>
          states[Math.min(readCount++, states.length - 1)],
        recordInput: (result) => recorder.appendJsonl("input_results", result),
        sessionMode: () => mode,
      });

      const accepted = await gate.press("Up", { intent: "navigation" });
      mode = "dialog";
      const rejected = await gate.press("Left", { intent: "navigation" });

      expect(accepted).toMatchObject({
        button: "Up",
        executed: true,
        transition: { kind: "movement" },
      });
      expect(rejected).toMatchObject({
        button: "Left",
        executed: false,
        reason: "mode-mismatch",
        transition: { kind: "none" },
      });
      const inputResults = await readJsonl(join(runDir, "input_results.jsonl"));
      expect(inputResults).toHaveLength(2);
      expect(inputResults.map((result) => result.executed)).toEqual([
        true,
        false,
      ]);
    } finally {
      await rm(runDir, { force: true, recursive: true });
    }
  });
});

describe("production episode entry wiring", () => {
  it("starts each production model turn by steering the observation before consuming the command stream", async () => {
    const runDir = await makeRunDir("streaming-production-agent");
    const heldButtons: unknown[] = [];
    const miniStates: MiniState[] = [
      { frame: 10, mapId: 1, mode: "overworld", x: 4, y: 5 },
      { frame: 11, mapId: 1, mode: "overworld", x: 4, y: 4 },
      { frame: 20, mapId: 1, mode: "overworld", x: 4, y: 4 },
      { frame: 21, mapId: 1, mode: "overworld", x: 4, y: 3 },
    ];
    let miniStateIndex = 0;
    try {
      const inputGate = new InputGate({
        client: {
          ...fakeClient(),
          hold: (button: string, duration: number) => {
            heldButtons.push({ button, duration });
            return Promise.resolve("ok");
          },
        } as never,
        readMiniState: async () =>
          miniStates[Math.min(miniStateIndex++, miniStates.length - 1)],
        sessionMode: () => "overworld",
      });
      const runner = new EpisodeRunner({
        agentRunFactory: await createEpisodeAgentRunFactory({
          mgbaClient: fakeClient() as never,
          runDir,
        }),
        commandExecutor: new CommandExecutor(inputGate),
        config: { max_steps: 2 },
        observationBuilder: new FakeObservationBuilder(
          repeatedObservations(8, 5)
        ),
        runDir,
      });

      const result = await withTimeout(runner.run(), 150);

      expect(result).toEqual({ reason: "max-steps", steps: 2 });
      expect(runtimeMock.createAgent).toHaveBeenCalled();
      expect(heldButtons).toEqual([
        { button: "Up", duration: 12 },
        { button: "Up", duration: 12 },
      ]);
      const agentSteps = await readJsonl(join(runDir, "agent_steps.jsonl"));
      const runtimeInputs = agentSteps
        .map((step) => step.event)
        .filter(
          (event): event is { input: unknown; type: "runtime-input" } =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "runtime-input" &&
            "input" in event
        )
        .map((event) => event.input);
      expect(runtimeInputs).toHaveLength(2);
      expect(runtimeInputs[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text" }),
          expect.objectContaining({ mediaType: "image/png", type: "image" }),
        ])
      );
      expect(runtimeInputs[1]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("recent actions to avoid"),
            type: "text",
          }),
        ])
      );
      expect(agentSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              placement: "turn-start",
              type: "runtime-input",
            }),
            kind: "agent-event",
            step: 1,
          }),
          expect.objectContaining({
            event: expect.objectContaining({
              toolName: "mgba_hold",
              type: "tool-call",
            }),
            kind: "agent-event",
            step: 1,
          }),
          expect.objectContaining({
            executed: expect.objectContaining({
              button: "Up",
              executed: true,
            }),
            kind: "command-execution",
            step: 1,
          }),
          expect.objectContaining({
            kind: "observation",
            step: 2,
          }),
        ])
      );
      const transitions = await readJsonl(join(runDir, "transitions.jsonl"));
      expect(transitions).toHaveLength(2);
      expect(transitions[0]).toMatchObject({
        transition: { kind: "movement" },
      });
    } finally {
      await rm(runDir, { force: true, recursive: true });
    }
  });

  it("constructs the EpisodeRunner with injected agent factory without network", async () => {
    const runDir = join(tmpdir(), "pss-mgba-episode-entry-test");
    const runner = await createProductionEpisodeRunner({
      agentRunFactory: () => Promise.resolve(new FakeRun([])),
      runDir,
      runtimeEnv: {
        EMULATOR_FPS: "640",
        EPISODE_MAX_STEPS: "17",
      },
    });

    expect(runner).toBeInstanceOf(EpisodeRunner);
    expect(runner.config).toMatchObject({
      emulator_fps: 640,
      goal: "reach_viridian_city",
      llm_supervisor_interval: 100,
      max_steps: 17,
      screenshot_interval: 100,
    });
    expect(runner.evidence.runDir).toBe(runDir);
  });
});

class FakeRun implements AgentRun {
  readonly events: readonly AgentEvent[];

  constructor(events: readonly AgentEvent[]) {
    this.events = events;
  }

  stream(): AsyncIterable<AgentEvent> {
    const events = this.events;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        let index = 0;
        return {
          next: () =>
            Promise.resolve(
              index < events.length
                ? { done: false, value: events[index++] }
                : { done: true, value: undefined }
            ),
        };
      },
    };
  }
}

class FakeObservationBuilder {
  #index = 0;
  readonly #sessionState = createSessionState("overworld");
  readonly observations: readonly MgbaObservation[];

  constructor(observations: readonly MgbaObservation[]) {
    this.observations = observations;
  }

  get sessionState() {
    return this.#sessionState;
  }

  build(): Promise<BuiltObservation> {
    const observation =
      this.observations[Math.min(this.#index++, this.observations.length - 1)];
    return Promise.resolve({ observation, sessionState: this.#sessionState });
  }
}

async function makeRunDir(name: string): Promise<string> {
  const path = join(
    tmpdir(),
    `pss-mgba-episode-${name}-${Date.now()}-${Math.random()}`
  );
  await mkdir(path, { recursive: true });
  return path;
}

function repeatedObservations(count: number, y: number): MgbaObservation[] {
  return Array.from({ length: count }, (_, index) => observation(index + 1, y));
}

function observation(frame: number, y: number): MgbaObservation {
  return {
    screenshot: {
      data: "iVBORw0KGgo=",
      mediaType: "image/png",
      path: `/tmp/fake-${frame}.png`,
    },
    state: state(1, 4, y),
    status: status(frame),
  };
}

function state(mapId: number, x: number, y: number): PokemonStateObservation {
  return {
    battle: false,
    battleResult: null,
    battleType: null,
    dialogueLike: false,
    direction: "up",
    mapId,
    menuLike: false,
    position: { x, y },
    readStatus: "available",
  };
}

function status(frame: number): MgbaStatus {
  return {
    activeButtons: [],
    frame,
    gameCode: "POKE",
    gameTitle: "RED",
  };
}

function movement(frame: number, fromY: number, toY: number): StateTransition {
  return detectTransition(
    { frame, mapId: 1, mode: "overworld", x: 4, y: fromY },
    { frame: frame + 1, mapId: 1, mode: "overworld", x: 4, y: toY }
  );
}

function noneTransition(frame: number, x: number, y: number): StateTransition {
  const mini = { frame, mapId: 1, mode: "overworld" as const, x, y };
  return detectTransition(mini, mini);
}

function inputResult(
  button: InputResult["button"],
  transition: StateTransition
): InputResult {
  return {
    after: transition.to ?? transition.before,
    before: transition.before,
    button,
    executed: true,
    intent: "navigation",
    polls: 1,
    settle_timed_out: false,
    source: "test",
    transition,
  };
}

function toolCall(toolName: string, input: unknown): AgentEvent {
  return {
    input,
    toolCallId: toolName,
    toolName,
    type: "tool-call",
  } as AgentEvent;
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function expectJsonlLength(
  path: string,
  expected: number
): Promise<void> {
  expect(await readJsonl(path)).toHaveLength(expected);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function fakeClient() {
  return {
    clear: async () => "ok",
    clearMany: async () => "ok",
    hold: async () => "ok",
    holdMany: async () => "ok",
    read8: (address: number) => {
      const values = new Map([
        [0xd3_5e, 1],
        [0xd3_61, 5],
        [0xd3_62, 4],
        [0xc1_09, 4],
        [0xd0_57, 0],
        [0xd0_5a, 0],
        [0xcf_0b, 0],
      ]);
      const value = values.get(address);
      if (value === undefined) {
        throw new Error(`unexpected address ${address}`);
      }
      return Promise.resolve(value);
    },
    screenshot: async (targetPath: string) => {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, Buffer.from("iVBORw0KGgo=", "base64"));
      return "ok";
    },
    status: async () => status(1),
    tap: async () => "ok",
    tapMany: async () => "ok",
  };
}
