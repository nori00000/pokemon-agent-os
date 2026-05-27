import type { AgentEvent } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";
import type { MgbaObservation } from "../src/observation";
import { ObservationBookkeeping } from "../src/observation-bookkeeping";
import type { PokemonStateObservation } from "../src/pokemon-state";
import { RunMetricsTracker } from "../src/run-metrics";
import { StuckMemory } from "../src/stuck-memory";

const baseState: PokemonStateObservation = {
  battle: false,
  battleResult: 0,
  battleType: 0,
  dialogueLike: "visual-fallback",
  direction: "up",
  mapId: 12,
  menuLike: "visual-fallback",
  position: {
    x: 10,
    y: 14,
  },
  readStatus: "available",
};

function observation(position: { x: number; y: number }): MgbaObservation {
  return {
    screenshot: {
      data: `screen-${position.x}-${position.y}`,
      mediaType: "image/png",
      path: `/tmp/screen-${position.x}-${position.y}.png`,
    },
    state: {
      ...baseState,
      position,
    },
    status: {
      activeButtons: [],
      frame: 2817,
      gameCode: "DMG-AR",
      gameTitle: "PKMN RED ST",
    },
  };
}

function holdUp(
  toolCallId: string
): Extract<AgentEvent, { type: "tool-call" }> {
  return {
    input: { button: "Up", duration: 12 },
    toolCallId,
    toolName: "mgba_hold",
    type: "tool-call",
  };
}

function createBookkeeping(): {
  bookkeeping: ObservationBookkeeping;
  metrics: RunMetricsTracker;
  memory: StuckMemory;
} {
  const memory = new StuckMemory();
  const metrics = new RunMetricsTracker({ runId: "bookkeeping-test" });
  return {
    bookkeeping: new ObservationBookkeeping({
      runMetricsTracker: metrics,
      stuckMemory: memory,
    }),
    memory,
    metrics,
  };
}

describe("ObservationBookkeeping", () => {
  it("attributes same-turn movement after an after-step observation to the fresh position", () => {
    const { bookkeeping, memory } = createBookkeeping();
    const beforeTurnObservation = observation({ x: 10, y: 14 });
    const afterStepObservation = observation({ x: 11, y: 14 });

    bookkeeping.promoteObservation(beforeTurnObservation, 1);
    bookkeeping.recordEvent(holdUp("first-move"), 1);
    bookkeeping.promoteObservation(afterStepObservation, 1);
    bookkeeping.recordEvent(holdUp("second-move"), 1);
    bookkeeping.promoteObservation(afterStepObservation, 1);

    expect(memory.snapshot().failedMovementEdges).toEqual([
      {
        action: "hold:Up",
        attempts: 1,
        context: "map=12 x=11 y=14 facing=up",
        lastSeenTurn: 1,
      },
    ]);
  });

  it("does not double-count stuck events or metrics when promotion has no pending movement", () => {
    const { bookkeeping, memory, metrics } = createBookkeeping();
    const stationaryObservation = observation({ x: 10, y: 14 });

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      bookkeeping.promoteObservation(stationaryObservation, attempt);
      bookkeeping.recordEvent(holdUp(`hold-${attempt}`), attempt);
    }
    bookkeeping.promoteObservation(stationaryObservation, 9);

    expect(memory.snapshot().stuckEvents).toBe(1);
    expect(metrics.snapshot().stuckEvents).toBe(1);

    bookkeeping.promoteObservation(stationaryObservation, 10);
    bookkeeping.promoteObservation(stationaryObservation, 11);

    expect(memory.snapshot().stuckEvents).toBe(1);
    expect(metrics.snapshot().stuckEvents).toBe(1);
  });
});
