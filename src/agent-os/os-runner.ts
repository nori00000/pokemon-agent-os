import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MgbaButton } from "../mgba-http";
import { MgbaHttpClient } from "../mgba-http";
import type { PokemonStateObservation } from "../pokemon-state";
import { readPokemonStateObservation } from "../pokemon-state";
import type { Button, Decision } from "./brain";
import { atTrigger, decide } from "./brain";
import type { GameState, StepRecord, StuckResult } from "./game-state";
import {
  computeStuckScore,
  normalizeGameState,
  STUCK_THRESHOLD,
} from "./game-state";
import type { EvaluationInput } from "./io";
import {
  appendStepLog,
  computeProgressScore,
  renderEvaluationReport,
  writeEvaluationReport,
  writeRuntimeState,
} from "./io";
import type {
  FailureDex,
  MapCoord,
  Mission,
  MissionGraph,
  SpatialGraph,
} from "./knowledge";
import {
  loadFailureDex,
  loadMissionGraph,
  loadSpatialGraph,
  manhattan,
  nextExitToward,
  resolveMapKey,
  selectMission,
} from "./knowledge";
import { OccupancyGrid, stepDelta } from "./pathfinder";

const WINDOW = 20;
const RUN_ID_SANITIZE = /[:.]/g;
const OS_PREFIX = /^os-/;
const CALIBRATION_PROBE: readonly MgbaButton[] = [
  "Up",
  "Up",
  "Down",
  "Down",
  "Left",
  "Left",
  "Right",
  "Right",
  "A",
  "B",
];

export interface RunnerOptions {
  baseUrl: string;
  knowledgeDir: string;
  logsDir: string;
  maxSteps: number;
  memoryDir: string;
  reportsDir: string;
  settleMs: number;
  targetMap: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

const DIRECTION_BUTTONS = new Set<string>(["Down", "Left", "Right", "Up"]);

/**
 * Overworld stepping needs a sustained d-pad hold (a bare tap only turns or is
 * dropped — verified live); A/B/Start/Select use a tap.
 */
export async function pressButton(
  client: MgbaHttpClient,
  button: MgbaButton,
  signal?: AbortSignal
): Promise<void> {
  if (DIRECTION_BUTTONS.has(button)) {
    // 10 frames = exactly one tile (verified live); longer overshoots 1-2 tiles
    // and breaks precise warp-trigger landing.
    await client.hold(button, 10, signal);
    return;
  }
  await client.tap(button, signal);
}

interface Aggregates {
  battleCount: number;
  coords: Set<string>;
  failedRecoveries: number;
  maps: Set<string>;
  mapTransitions: number;
  maxStuck: number;
  startMs: number;
  stuckEvents: number;
  stuckSum: number;
  successfulRecoveries: number;
  timeToTargetMs: number | null;
  topFailures: Map<string, number>;
}

function newAggregates(startMs: number): Aggregates {
  return {
    battleCount: 0,
    coords: new Set<string>(),
    failedRecoveries: 0,
    mapTransitions: 0,
    maps: new Set<string>(),
    maxStuck: 0,
    startMs,
    stuckEvents: 0,
    stuckSum: 0,
    successfulRecoveries: 0,
    timeToTargetMs: null,
    topFailures: new Map<string, number>(),
  };
}

interface RecoveryTracker {
  failure: string | null;
  stepIndex: number;
}

interface RunContext {
  agg: Aggregates;
  client: MgbaHttpClient;
  completed: Set<string>;
  failureDex: FailureDex;
  history: StepRecord[];
  missionGraph: MissionGraph;
  occupancy: OccupancyGrid;
  options: RunnerOptions;
  recovery: RecoveryTracker;
  runId: string;
  spatial: SpatialGraph;
}

interface LoopState {
  failureReason: string | null;
  highestMission: string | null;
  lastAction: string | null;
  missionCompleted: boolean;
  prevAtTriggerCross: boolean;
  prevMapId: number | null;
  prevNextHop: string | null;
  prevX: number | null;
  prevY: number | null;
}

interface StepCommit {
  decision: Decision;
  dist: number | null;
  mapKey: string | null;
  mission: Mission | null;
  obs: PokemonStateObservation;
  recoveryActive: boolean;
  state: GameState;
  step: number;
  stuck: StuckResult;
}

function goalDistance(
  spatial: SpatialGraph,
  state: GameState,
  targetMap: string
): number | null {
  if (state.mapKey === null || state.x === null || state.y === null) {
    return null;
  }
  if (state.mapKey === targetMap) {
    return 0;
  }
  const exit = nextExitToward(spatial, state.mapKey, targetMap);
  if (!exit) {
    return null;
  }
  return manhattan({ x: state.x, y: state.y }, exit.trigger);
}

function updateRecovery(
  tracker: RecoveryTracker,
  failureType: string | null,
  active: boolean
): void {
  if (!active || failureType === null) {
    tracker.failure = null;
    tracker.stepIndex = 0;
    return;
  }
  if (tracker.failure === failureType) {
    tracker.stepIndex += 1;
  } else {
    tracker.failure = failureType;
    tracker.stepIndex = 0;
  }
}

function setupContext(options: RunnerOptions): RunContext {
  return {
    agg: newAggregates(Date.now()),
    client: new MgbaHttpClient({ baseUrl: options.baseUrl }),
    completed: new Set<string>(),
    failureDex: loadFailureDex(options.knowledgeDir),
    history: [],
    missionGraph: loadMissionGraph(options.knowledgeDir),
    occupancy: new OccupancyGrid(),
    options,
    recovery: { failure: null, stepIndex: 0 },
    runId: `os-${nowIso().replace(RUN_ID_SANITIZE, "-")}`,
    spatial: loadSpatialGraph(options.knowledgeDir),
  };
}

function tally(
  agg: Aggregates,
  state: GameState,
  obs: PokemonStateObservation,
  prevMapId: number | null,
  mapKey: string | null
): void {
  if (mapKey !== null) {
    agg.maps.add(mapKey);
  }
  if (state.x !== null && state.y !== null) {
    agg.coords.add(`${mapKey}:${state.x}:${state.y}`);
  }
  if (prevMapId !== null && obs.mapId !== null && obs.mapId !== prevMapId) {
    agg.mapTransitions += 1;
  }
  if (state.inBattle) {
    agg.battleCount += 1;
  }
}

function attemptedDelta(action: string): MapCoord | null {
  if (
    action === "Up" ||
    action === "Down" ||
    action === "Left" ||
    action === "Right"
  ) {
    return stepDelta(action);
  }
  return null;
}

/**
 * Empirical collision learning: mark the current tile free, and if the last
 * directional move left the player in place (a bump), mark the tile it tried to
 * enter as blocked so A* routes around it next time.
 */
function learnOccupancy(
  ctx: RunContext,
  ls: LoopState,
  state: GameState,
  mapKey: string | null,
  intendedNextMap: string | null
): void {
  const d = ls.lastAction === null ? null : attemptedDelta(ls.lastAction);
  // unwanted warp: a move that changed the map to something other than the
  // intended next hop -> block the SOURCE tile (in the previous map) so A*
  // routes around it. Runs even when the destination map is unknown (mapKey
  // null), e.g. re-entering a building not yet in the spatial graph.
  if (
    d &&
    ls.prevMapId !== null &&
    ls.prevX !== null &&
    ls.prevY !== null &&
    state.mapId !== ls.prevMapId &&
    intendedNextMap !== null &&
    mapKey !== intendedNextMap
  ) {
    const prevKey = resolveMapKey(ctx.spatial, ls.prevMapId);
    if (prevKey !== null) {
      ctx.occupancy.markBlocked(prevKey, ls.prevX + d.x, ls.prevY + d.y);
    }
  }
  if (mapKey === null || state.x === null || state.y === null) {
    return;
  }
  ctx.occupancy.markFree(mapKey, state.x, state.y);
  // bump: a directional move that left us in place -> target tile is blocked.
  if (
    d &&
    ls.prevMapId === state.mapId &&
    ls.prevX === state.x &&
    ls.prevY === state.y
  ) {
    ctx.occupancy.markBlocked(mapKey, state.x + d.x, state.y + d.y);
  }
}

function assess(
  ctx: RunContext,
  stuck: StuckResult
): { recoveries: readonly string[]; recoveryActive: boolean } {
  const recoveryActive =
    stuck.score > STUCK_THRESHOLD && stuck.failureType !== null;
  updateRecovery(ctx.recovery, stuck.failureType, recoveryActive);
  if (recoveryActive && ctx.recovery.stepIndex === 0) {
    ctx.agg.stuckEvents += 1;
    const failKey = stuck.failureType ?? "unknown";
    ctx.agg.topFailures.set(
      failKey,
      (ctx.agg.topFailures.get(failKey) ?? 0) + 1
    );
  }
  ctx.agg.maxStuck = Math.max(ctx.agg.maxStuck, stuck.score);
  ctx.agg.stuckSum += stuck.score;
  const recoveries = stuck.failureType
    ? (ctx.failureDex.failures[stuck.failureType]?.recoveries ?? [])
    : [];
  return { recoveries, recoveryActive };
}

function buildDecision(
  ctx: RunContext,
  state: GameState,
  mission: Mission | null,
  stuck: StuckResult,
  recoveries: readonly string[]
): Decision {
  return decide({
    failureType: stuck.failureType,
    forbidden: [],
    mission,
    occupancy: ctx.occupancy,
    recoveries,
    recoveryStepIndex: ctx.recovery.stepIndex,
    spatial: ctx.spatial,
    state,
    stuckScore: stuck.score,
  });
}

function persistStep(ctx: RunContext, p: StepCommit): void {
  const progressScore = computeProgressScore({
    mapTransitionCount: ctx.agg.mapTransitions,
    missionIndex: ctx.completed.size,
    recoveryFailures: ctx.agg.failedRecoveries,
    stuckEvents: ctx.agg.stuckEvents,
    uniqueCoordinatesSeen: ctx.agg.coords.size,
  });
  appendStepLog(ctx.options.logsDir, {
    action: p.decision.button,
    currentMission: p.mission?.id ?? null,
    currentSubgoal: p.decision.subgoal,
    failureType: p.stuck.failureType,
    goalDistance: p.dist,
    mapId: p.obs.mapId,
    mapKey: p.mapKey,
    mode: p.decision.agent,
    progressScore,
    recoveryTriggered: p.decision.recoveryTriggered,
    repeatedActionCount: countRepeatedAction(ctx.history, p.decision.button),
    samePositionCount: countSamePosition(ctx.history, p.state),
    sameScreenCount: 0,
    screenHash: null,
    step: p.step,
    stuckScore: p.stuck.score,
    timestamp: p.state.timestamp,
    x: p.state.x,
    y: p.state.y,
  });
  writeRuntimeState(ctx.options.memoryDir, {
    currentMap: p.mapKey,
    currentMission: p.mission?.id ?? null,
    currentSubgoal: p.decision.subgoal,
    forbiddenActions: [],
    inBattle: p.state.inBattle,
    inDialog: p.state.inDialog,
    inMenu: p.state.inMenu,
    lastAction: p.state.lastAction,
    mode: p.decision.agent,
    recoveryMode: p.recoveryActive,
    stuckScore: p.stuck.score,
    x: p.state.x,
    y: p.state.y,
  });
  pushHistory(ctx.history, {
    action: p.decision.button,
    failureType: p.stuck.failureType,
    goalDistance: p.dist,
    mapId: p.obs.mapId,
    mode: p.state.mode,
    recoveryTriggered: p.decision.recoveryTriggered,
    screenHash: null,
    step: p.step,
    stuckScore: p.stuck.score,
    x: p.state.x,
    y: p.state.y,
  });
}

async function runStep(
  ctx: RunContext,
  ls: LoopState,
  step: number,
  signal?: AbortSignal
): Promise<"continue" | "stop"> {
  const obs = await readPokemonStateObservation(ctx.client, signal);
  const mapKey = resolveMapKey(ctx.spatial, obs.mapId);
  const state = normalizeGameState(obs, {
    lastAction: ls.lastAction,
    mapKey,
    screenHash: null,
    step,
    timestamp: nowIso(),
  });
  tally(ctx.agg, state, obs, ls.prevMapId, mapKey);
  learnOccupancy(ctx, ls, state, mapKey, ls.prevNextHop);

  const mission = selectMission(ctx.missionGraph, ctx.completed, mapKey);
  if (mission) {
    ls.highestMission = mission.id;
  }
  const dist = goalDistance(ctx.spatial, state, ctx.options.targetMap);
  const failedTransition =
    ls.prevAtTriggerCross && obs.mapId !== null && obs.mapId === ls.prevMapId;
  const stuck = computeStuckScore(state, dist, ctx.history, failedTransition);
  const { recoveries, recoveryActive } = assess(ctx, stuck);
  const decision = buildDecision(ctx, state, mission, stuck, recoveries);
  persistStep(ctx, {
    decision,
    dist,
    mapKey,
    mission,
    obs,
    recoveryActive,
    state,
    step,
    stuck,
  });
  completePassedMissions(ctx.missionGraph, ctx.completed, mapKey);

  if (mapKey === ctx.options.targetMap) {
    ls.missionCompleted = true;
    ctx.agg.timeToTargetMs = Date.now() - ctx.agg.startMs;
    ls.failureReason = null;
    await execute(ctx.client, decision, ctx.options.settleMs, signal);
    return "stop";
  }
  ls.prevMapId = obs.mapId;
  ls.prevX = state.x;
  ls.prevY = state.y;
  ls.prevNextHop =
    mapKey === null
      ? null
      : (nextExitToward(ctx.spatial, mapKey, ctx.options.targetMap)?.to ??
        null);
  ls.prevAtTriggerCross = isTriggerCross(
    ctx.spatial,
    state,
    mission?.successMap
  );
  ls.lastAction = decision.button;
  await execute(ctx.client, decision, ctx.options.settleMs, signal);
  return "continue";
}

export async function runDeterministic(
  options: RunnerOptions,
  signal?: AbortSignal
): Promise<EvaluationInput> {
  const ctx = setupContext(options);
  const ls: LoopState = {
    failureReason: null,
    highestMission: null,
    lastAction: null,
    missionCompleted: false,
    prevAtTriggerCross: false,
    prevMapId: null,
    prevNextHop: null,
    prevX: null,
    prevY: null,
  };

  for (let step = 1; step <= options.maxSteps; step += 1) {
    if (signal?.aborted) {
      ls.failureReason = "aborted";
      break;
    }
    const result = await runStep(ctx, ls, step, signal);
    if (result === "stop") {
      break;
    }
    if (step === options.maxSteps) {
      ls.failureReason = `max_steps_reached(${options.maxSteps}) without ${options.targetMap}`;
    }
  }

  const evaluation = buildEvaluation(
    ctx.runId,
    ctx.agg,
    ctx.history,
    ls.highestMission,
    ls.missionCompleted,
    ls.failureReason
  );
  writeEvaluationReport(
    options.reportsDir,
    ctx.runId.replace(OS_PREFIX, ""),
    renderEvaluationReport(evaluation)
  );
  return evaluation;
}

async function execute(
  client: MgbaHttpClient,
  decision: Decision,
  settleMs: number,
  signal?: AbortSignal
): Promise<void> {
  await pressButton(client, decision.button as MgbaButton, signal);
  await sleep(settleMs);
}

function isTriggerCross(
  spatial: SpatialGraph,
  state: GameState,
  targetMap: string | null | undefined
): boolean {
  if (!targetMap || state.mapKey === null) {
    return false;
  }
  const exit = nextExitToward(spatial, state.mapKey, targetMap);
  if (!exit) {
    return false;
  }
  return atTrigger(state, exit);
}

function completePassedMissions(
  graph: MissionGraph,
  completed: Set<string>,
  mapKey: string | null
): void {
  if (mapKey === null) {
    return;
  }
  for (const mission of graph.missions) {
    if (!completed.has(mission.id) && mission.successMap === mapKey) {
      completed.add(mission.id);
    }
  }
}

function countSamePosition(
  history: readonly StepRecord[],
  state: GameState
): number {
  let count = 0;
  for (const record of history) {
    if (
      record.mapId === state.mapId &&
      record.x === state.x &&
      record.y === state.y
    ) {
      count += 1;
    }
  }
  return count;
}

function countRepeatedAction(
  history: readonly StepRecord[],
  button: Button
): number {
  let count = 0;
  for (const record of history) {
    if (record.action === button) {
      count += 1;
    }
  }
  return count;
}

function pushHistory(history: StepRecord[], record: StepRecord): void {
  history.push(record);
  while (history.length > WINDOW) {
    history.shift();
  }
}

function buildEvaluation(
  runId: string,
  agg: Aggregates,
  history: readonly StepRecord[],
  highestMission: string | null,
  missionCompleted: boolean,
  failureReason: string | null
): EvaluationInput {
  const totalSteps = history.length > 0 ? (history.at(-1)?.step ?? 0) : 0;
  const topFailureModes = [...agg.topFailures.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([mode, n]) => `${mode} x${n}`);
  return {
    averageStuckScore: totalSteps > 0 ? agg.stuckSum / totalSteps : 0,
    battleCount: agg.battleCount,
    battleLosses: 0,
    battleWins: 0,
    currentMission: highestMission,
    failedRecoveries: agg.failedRecoveries,
    failureReason,
    highestMissionReached: highestMission,
    mapTransitions: agg.mapTransitions,
    maxStuckScore: agg.maxStuck,
    missionCompleted,
    nextImprovement: missionCompleted
      ? "calibrate route coordinates; extend missions past Viridian"
      : "inspect agent_steps.jsonl for the dominant failure_type and calibrate exit triggers",
    pathTakenSummary: [...agg.maps].join(" -> "),
    runId,
    runtimeSeconds: (Date.now() - agg.startMs) / 1000,
    startedAt: new Date(agg.startMs).toISOString(),
    stuckEvents: agg.stuckEvents,
    successfulRecoveries: agg.successfulRecoveries,
    timeToViridianSeconds:
      agg.timeToTargetMs === null ? null : agg.timeToTargetMs / 1000,
    topFailureModes,
    totalSteps,
    uniqueCoordinatesSeen: agg.coords.size,
    uniqueMapsSeen: agg.maps.size,
  };
}

export interface CalibrationRow {
  button: MgbaButton;
  dDir: string;
  dMapId: number | null;
  dx: number | null;
  dy: number | null;
  mapId: number | null;
  step: number;
  x: number | null;
  y: number | null;
}

/**
 * Calibration mode: drive a fixed probe sequence and record observed RAM
 * deltas. Verifies RAM addresses + button->delta semantics and harvests real
 * coordinates before the spatial graph is trusted. No knowledge files needed.
 */
export async function runCalibration(
  options: RunnerOptions,
  signal?: AbortSignal
): Promise<CalibrationRow[]> {
  const client = new MgbaHttpClient({ baseUrl: options.baseUrl });
  mkdirSync(options.logsDir, { recursive: true });
  const out = join(options.logsDir, "calibration.jsonl");
  const rows: CalibrationRow[] = [];
  let prev = await readPokemonStateObservation(client, signal);

  for (let i = 0; i < options.maxSteps; i += 1) {
    if (signal?.aborted) {
      break;
    }
    const button = CALIBRATION_PROBE[i % CALIBRATION_PROBE.length];
    await pressButton(client, button, signal);
    await sleep(options.settleMs);
    const cur = await readPokemonStateObservation(client, signal);
    const row: CalibrationRow = {
      button,
      dDir: `${prev.direction}->${cur.direction}`,
      dMapId: delta(cur.mapId, prev.mapId),
      dx: delta(cur.position.x, prev.position.x),
      dy: delta(cur.position.y, prev.position.y),
      mapId: cur.mapId,
      step: i + 1,
      x: cur.position.x,
      y: cur.position.y,
    };
    rows.push(row);
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    prev = cur;
  }
  return rows;
}

function delta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) {
    return null;
  }
  return a - b;
}
