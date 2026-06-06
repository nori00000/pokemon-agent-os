import { describe, expect, it } from "vitest";
import { decide } from "../../src/agent-os/brain";
import type { GameState, StepRecord } from "../../src/agent-os/game-state";
import {
  classifyFailure,
  computeStuckScore,
  normalizeGameState,
  STUCK_THRESHOLD,
} from "../../src/agent-os/game-state";
import {
  computeProgressScore,
  renderEvaluationReport,
  stepLogRecord,
} from "../../src/agent-os/io";
import {
  directionToTarget,
  findMapRoute,
  loadFailureDex,
  loadMissionGraph,
  loadSpatialGraph,
  nextExitToward,
  resolveMapKey,
  selectMission,
} from "../../src/agent-os/knowledge";
import { nextStepToward, OccupancyGrid } from "../../src/agent-os/pathfinder";
import type { PokemonStateObservation } from "../../src/pokemon-state";

const KNOWLEDGE = "knowledge";

function navState(overrides: Partial<GameState> = {}): GameState {
  return {
    direction: "up",
    inBattle: false,
    inDialog: false,
    inMenu: false,
    lastAction: "Up",
    mapId: 0,
    mapKey: "PALLET_TOWN",
    mode: "navigation",
    screenHash: null,
    step: 1,
    timestamp: "2026-06-06T00:00:00.000Z",
    x: 5,
    y: 6,
    ...overrides,
  };
}

function stepRecord(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    action: "Up",
    failureType: null,
    goalDistance: 9,
    mapId: 0,
    mode: "navigation",
    recoveryTriggered: false,
    screenHash: null,
    step: 1,
    stuckScore: 0,
    x: 5,
    y: 6,
    ...overrides,
  };
}

describe("knowledge graph", () => {
  it("loads the real spatial graph and resolves confirmed map ids", () => {
    const graph = loadSpatialGraph(KNOWLEDGE);
    expect(resolveMapKey(graph, 0)).toBe("PALLET_TOWN");
    expect(resolveMapKey(graph, 1)).toBe("VIRIDIAN_CITY");
    expect(resolveMapKey(graph, 999)).toBeNull();
  });

  it("finds a route from Pallet Town to Viridian City", () => {
    const graph = loadSpatialGraph(KNOWLEDGE);
    expect(findMapRoute(graph, "PALLET_TOWN", "VIRIDIAN_CITY")).toEqual([
      "PALLET_TOWN",
      "ROUTE_1",
      "VIRIDIAN_CITY",
    ]);
  });

  it("returns the first-hop exit toward the target", () => {
    const graph = loadSpatialGraph(KNOWLEDGE);
    const exit = nextExitToward(graph, "PALLET_TOWN", "VIRIDIAN_CITY");
    expect(exit?.to).toBe("ROUTE_1");
  });

  it("computes axis-priority direction toward a target tile", () => {
    expect(directionToTarget({ x: 5, y: 6 }, { x: 8, y: 0 })).toBe("Up");
    expect(directionToTarget({ x: 5, y: 6 }, { x: 9, y: 6 })).toBe("Right");
    expect(directionToTarget({ x: 5, y: 6 }, { x: 5, y: 6 })).toBeNull();
  });

  it("selects the mission whose start map matches the live map", () => {
    const missions = loadMissionGraph(KNOWLEDGE);
    const mission = selectMission(missions, new Set(), "ROUTE_1");
    expect(mission?.successMap).toBe("VIRIDIAN_CITY");
  });

  it("loads failure-dex recovery sequences", () => {
    const dex = loadFailureDex(KNOWLEDGE);
    expect(dex.failures.wall_loop?.recoveries[0]).toBe(
      "forbid_repeated_direction"
    );
  });
});

describe("game state + stuck score", () => {
  it("normalizes a battle observation into battle mode", () => {
    const obs: PokemonStateObservation = {
      battle: true,
      battleResult: 0,
      battleType: 1,
      dialogueLike: "visual-fallback",
      direction: "down",
      mapId: 12,
      menuLike: "visual-fallback",
      position: { x: 3, y: 4 },
      readStatus: "available",
    };
    const state = normalizeGameState(obs, {
      lastAction: null,
      mapKey: "ROUTE_1",
      screenHash: null,
      step: 2,
      timestamp: "t",
    });
    expect(state.mode).toBe("battle");
    expect(state.inBattle).toBe(true);
  });

  it("returns zero stuck score with no history", () => {
    expect(computeStuckScore(navState(), 9, []).score).toBe(0);
  });

  it("raises stuck score above threshold when pinned in place", () => {
    const window = Array.from({ length: 10 }, () => stepRecord());
    const result = computeStuckScore(navState(), 9, window);
    expect(result.score).toBeGreaterThan(STUCK_THRESHOLD);
    expect(result.failureType).toBe("wall_loop");
  });

  it("classifies a menu loop", () => {
    const state = navState({ inMenu: true, mode: "menu" });
    expect(
      classifyFailure(state, {
        battleLoop: 0,
        dialogLoop: 0,
        failedMapTransition: 0,
        menuLoop: 1,
        noPositionChange: 0,
        noProgressDelta: 0,
        repeatedAction: 0,
        sameScreenHash: 0,
      })
    ).toBe("menu_loop");
  });
});

describe("brain decisions", () => {
  const spatial = loadSpatialGraph(KNOWLEDGE);
  const missions = loadMissionGraph(KNOWLEDGE);

  it("mashes A in battle", () => {
    const decision = decide({
      failureType: null,
      forbidden: [],
      mission: null,
      recoveries: [],
      recoveryStepIndex: 0,
      spatial,
      state: navState({ inBattle: true, mode: "battle" }),
      stuckScore: 0,
    });
    expect(decision.agent).toBe("battle");
    expect(decision.button).toBe("A");
  });

  it("closes a menu with B", () => {
    const decision = decide({
      failureType: null,
      forbidden: [],
      mission: null,
      recoveries: [],
      recoveryStepIndex: 0,
      spatial,
      state: navState({ inMenu: true, mode: "menu" }),
      stuckScore: 0,
    });
    expect(decision.button).toBe("B");
  });

  it("navigates toward the Route 1 exit from Pallet Town", () => {
    const mission = selectMission(missions, new Set(), "PALLET_TOWN");
    const decision = decide({
      failureType: null,
      forbidden: [],
      mission,
      recoveries: [],
      recoveryStepIndex: 0,
      spatial,
      state: navState(),
      stuckScore: 0,
    });
    expect(decision.agent).toBe("navigation");
    expect(decision.button).toBe("Up");
    expect(decision.subgoal).toContain("reach_exit:ROUTE_1");
  });

  it("enters recovery with a lateral move when stuck in a wall loop", () => {
    const decision = decide({
      failureType: "wall_loop",
      forbidden: [],
      mission: null,
      recoveries: ["forbid_repeated_direction", "try_lateral_move"],
      recoveryStepIndex: 0,
      spatial,
      state: navState({ lastAction: "Up" }),
      stuckScore: 0.85,
    });
    expect(decision.agent).toBe("recovery");
    expect(decision.recoveryTriggered).toBe(true);
    expect(decision.button).toBe("Left");
  });
});

describe("pathfinder A*", () => {
  it("steps directly toward an unobstructed target", () => {
    const grid = new OccupancyGrid();
    expect(nextStepToward(grid, "M", { x: 5, y: 0 }, { x: 5, y: 3 })).toBe(
      "Down"
    );
  });

  it("routes around a blocked tile", () => {
    const grid = new OccupancyGrid();
    grid.markBlocked("M", 5, 1);
    const step = nextStepToward(grid, "M", { x: 5, y: 0 }, { x: 5, y: 2 });
    expect(["Left", "Right"]).toContain(step);
  });

  it("returns null when already at the target", () => {
    const grid = new OccupancyGrid();
    expect(
      nextStepToward(grid, "M", { x: 2, y: 2 }, { x: 2, y: 2 })
    ).toBeNull();
  });
});

describe("io rendering", () => {
  it("computes the progress score per spec weights", () => {
    expect(
      computeProgressScore({
        mapTransitionCount: 2,
        missionIndex: 3,
        recoveryFailures: 1,
        stuckEvents: 2,
        uniqueCoordinatesSeen: 40,
      })
    ).toBeCloseTo(3 * 100 + 2 * 10 + 40 * 0.1 - 2 * 5 - 1 * 10, 5);
  });

  it("emits snake_case step-log keys", () => {
    const record = stepLogRecord({
      action: "Up",
      currentMission: "m",
      currentSubgoal: "s",
      failureType: null,
      goalDistance: 5,
      mapId: 0,
      mapKey: "PALLET_TOWN",
      mode: "navigation",
      progressScore: 1,
      recoveryTriggered: false,
      repeatedActionCount: 0,
      samePositionCount: 0,
      sameScreenCount: 0,
      screenHash: null,
      step: 1,
      stuckScore: 0,
      timestamp: "t",
      x: 5,
      y: 6,
    });
    expect(record).toHaveProperty("map_id", 0);
    expect(record).toHaveProperty("stuck_score", 0);
    expect(record).toHaveProperty("recovery_triggered", false);
  });

  it("renders an evaluation report with the headline metrics", () => {
    const report = renderEvaluationReport({
      averageStuckScore: 0.2,
      battleCount: 1,
      battleLosses: 0,
      battleWins: 1,
      currentMission: "mission_08_traverse_route_1",
      failedRecoveries: 0,
      failureReason: null,
      highestMissionReached: "mission_08_traverse_route_1",
      mapTransitions: 2,
      maxStuckScore: 0.5,
      missionCompleted: true,
      nextImprovement: "extend missions",
      pathTakenSummary: "PALLET_TOWN -> ROUTE_1 -> VIRIDIAN_CITY",
      runId: "os-test",
      runtimeSeconds: 12.34,
      startedAt: "t",
      stuckEvents: 0,
      successfulRecoveries: 0,
      timeToViridianSeconds: 12.3,
      topFailureModes: [],
      totalSteps: 30,
      uniqueCoordinatesSeen: 25,
      uniqueMapsSeen: 3,
    });
    expect(report).toContain("# Run Evaluation — os-test");
    expect(report).toContain("mission_completed: true");
    expect(report).toContain("PALLET_TOWN -> ROUTE_1 -> VIRIDIAN_CITY");
  });
});
