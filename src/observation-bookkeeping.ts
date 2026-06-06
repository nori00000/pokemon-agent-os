import type { AgentEvent } from "@minpeter/pss-runtime";
import type { MgbaObservation } from "./observation";
import type { RunMetricsTracker } from "./run-metrics";
import type { StuckMemory } from "./stuck-memory";

interface ObservationBookkeepingOptions {
  runMetricsTracker: RunMetricsTracker;
  stuckMemory: StuckMemory;
}

export class ObservationBookkeeping {
  readonly #runMetricsTracker: RunMetricsTracker;
  readonly #stuckMemory: StuckMemory;
  #currentObservation: MgbaObservation | undefined;

  constructor({
    runMetricsTracker,
    stuckMemory,
  }: ObservationBookkeepingOptions) {
    this.#runMetricsTracker = runMetricsTracker;
    this.#stuckMemory = stuckMemory;
  }

  clearCurrentObservation(): void {
    this.#currentObservation = undefined;
  }

  promoteObservation(observation: MgbaObservation, turn: number): void {
    this.#currentObservation = observation;
    this.#stuckMemory.observe(observation, turn);
    this.#runMetricsTracker.recordStuckEvents(
      this.#stuckMemory.snapshot().stuckEvents
    );
  }

  recordEvent(event: unknown, turn: number): void {
    if (!isAgentToolCall(event)) {
      return;
    }

    const observation = this.#currentObservation;
    if (!observation) {
      return;
    }

    this.#stuckMemory.recordEvent(event, observation, turn);
  }
}

function isAgentToolCall(
  event: unknown
): event is Extract<AgentEvent, { type: "tool-call" }> {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "tool-call" &&
    "toolCallId" in event &&
    typeof event.toolCallId === "string" &&
    "toolName" in event &&
    typeof event.toolName === "string" &&
    "input" in event
  );
}
