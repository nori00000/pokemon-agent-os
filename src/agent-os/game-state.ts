import type {
  PokemonDirection,
  PokemonStateObservation,
} from "../pokemon-state";

export type GameMode =
  | "battle"
  | "dialog"
  | "menu"
  | "navigation"
  | "recovery"
  | "unknown";

export type FailureType =
  | "battle_loop"
  | "dialog_loop"
  | "failed_map_transition"
  | "menu_loop"
  | "wall_loop";

export interface GameState {
  direction: PokemonDirection;
  inBattle: boolean;
  inDialog: boolean;
  inMenu: boolean;
  lastAction: string | null;
  mapId: number | null;
  mapKey: string | null;
  mode: GameMode;
  screenHash: string | null;
  step: number;
  timestamp: string;
  x: number | null;
  y: number | null;
}

export interface NormalizeContext {
  lastAction: string | null;
  mapKey: string | null;
  screenHash: string | null;
  step: number;
  timestamp: string;
}

export interface StepRecord {
  action: string | null;
  failureType: FailureType | null;
  goalDistance: number | null;
  mapId: number | null;
  mode: GameMode;
  recoveryTriggered: boolean;
  screenHash: string | null;
  step: number;
  stuckScore: number;
  x: number | null;
  y: number | null;
}

export interface StuckSignals {
  battleLoop: number;
  dialogLoop: number;
  failedMapTransition: number;
  menuLoop: number;
  noPositionChange: number;
  noProgressDelta: number;
  repeatedAction: number;
  sameScreenHash: number;
}

export interface StuckResult {
  failureType: FailureType | null;
  score: number;
  signals: StuckSignals;
}

const STUCK_WEIGHTS: StuckSignals = {
  battleLoop: 0.35,
  dialogLoop: 0.3,
  failedMapTransition: 0.4,
  menuLoop: 0.3,
  noPositionChange: 0.3,
  noProgressDelta: 0.35,
  repeatedAction: 0.2,
  sameScreenHash: 0.25,
};

export const STUCK_THRESHOLD = 0.7;

function resolveMode(observation: PokemonStateObservation): GameMode {
  if (observation.battle) {
    return "battle";
  }
  if (observation.menuLike === true) {
    return "menu";
  }
  if (observation.dialogueLike === true) {
    return "dialog";
  }
  if (observation.readStatus === "unavailable") {
    return "unknown";
  }
  return "navigation";
}

export function normalizeGameState(
  observation: PokemonStateObservation,
  context: NormalizeContext
): GameState {
  return {
    direction: observation.direction,
    inBattle: observation.battle,
    inDialog: observation.dialogueLike === true,
    inMenu: observation.menuLike === true,
    lastAction: context.lastAction,
    mapId: observation.mapId,
    mapKey: context.mapKey,
    mode: resolveMode(observation),
    screenHash: context.screenHash,
    step: context.step,
    timestamp: context.timestamp,
    x: observation.position.x,
    y: observation.position.y,
  };
}

function ratio(count: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return count / total;
}

function samePosition(a: StepRecord, b: GameState): boolean {
  return a.mapId === b.mapId && a.x === b.x && a.y === b.y;
}

/**
 * Confidence-based stuck score over a recent window (spec section 12).
 * `failedMapTransition` is supplied by the caller because it depends on
 * spatial-graph exit coordinates that this pure module does not load.
 */
export function computeStuckScore(
  current: GameState,
  goalDistance: number | null,
  window: readonly StepRecord[],
  failedMapTransition = false
): StuckResult {
  const total = window.length;
  if (total === 0) {
    return {
      failureType: null,
      score: 0,
      signals: emptySignals(failedMapTransition),
    };
  }

  let positionRepeat = 0;
  let screenRepeat = 0;
  let actionRepeat = 0;
  let dialogCount = 0;
  let menuCount = 0;
  let battleCount = 0;
  for (const record of window) {
    if (current.x !== null && samePosition(record, current)) {
      positionRepeat += 1;
    }
    if (
      current.screenHash !== null &&
      record.screenHash === current.screenHash
    ) {
      screenRepeat += 1;
    }
    if (current.lastAction !== null && record.action === current.lastAction) {
      actionRepeat += 1;
    }
    if (record.mode === "dialog") {
      dialogCount += 1;
    }
    if (record.mode === "menu") {
      menuCount += 1;
    }
    if (record.mode === "battle") {
      battleCount += 1;
    }
  }

  const noProgressDelta = computeNoProgressDelta(window, goalDistance);
  const signals: StuckSignals = {
    battleLoop: ratio(battleCount, total),
    dialogLoop: ratio(dialogCount, total),
    failedMapTransition: failedMapTransition ? 1 : 0,
    menuLoop: ratio(menuCount, total),
    noPositionChange: ratio(positionRepeat, total),
    noProgressDelta,
    repeatedAction: ratio(actionRepeat, total),
    sameScreenHash: ratio(screenRepeat, total),
  };

  const score = Math.min(1, weightedSum(signals));
  return { failureType: classifyFailure(current, signals), score, signals };
}

function emptySignals(failedMapTransition: boolean): StuckSignals {
  return {
    battleLoop: 0,
    dialogLoop: 0,
    failedMapTransition: failedMapTransition ? 1 : 0,
    menuLoop: 0,
    noPositionChange: 0,
    noProgressDelta: 0,
    repeatedAction: 0,
    sameScreenHash: 0,
  };
}

function computeNoProgressDelta(
  window: readonly StepRecord[],
  goalDistance: number | null
): number {
  if (goalDistance === null) {
    return 0;
  }
  const distances = window
    .map((record) => record.goalDistance)
    .filter((value): value is number => value !== null);
  if (distances.length === 0) {
    return 0;
  }
  const best = Math.min(...distances);
  return goalDistance >= best ? 1 : 0;
}

function weightedSum(signals: StuckSignals): number {
  let sum = 0;
  for (const key of Object.keys(STUCK_WEIGHTS) as (keyof StuckSignals)[]) {
    sum += signals[key] * STUCK_WEIGHTS[key];
  }
  return sum;
}

export function classifyFailure(
  current: GameState,
  signals: StuckSignals
): FailureType | null {
  if (current.mode === "battle" && signals.battleLoop > 0.5) {
    return "battle_loop";
  }
  if (current.mode === "menu") {
    return "menu_loop";
  }
  if (current.mode === "dialog" && signals.dialogLoop > 0.4) {
    return "dialog_loop";
  }
  if (signals.failedMapTransition >= 1) {
    return "failed_map_transition";
  }
  if (signals.noPositionChange > 0 || signals.repeatedAction > 0) {
    return "wall_loop";
  }
  return null;
}
