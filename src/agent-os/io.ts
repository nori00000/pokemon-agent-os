import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RuntimeStateInput {
  currentMap: string | null;
  currentMission: string | null;
  currentSubgoal: string | null;
  forbiddenActions: readonly string[];
  inBattle: boolean;
  inDialog: boolean;
  inMenu: boolean;
  lastAction: string | null;
  mode: string;
  recoveryMode: boolean;
  stuckScore: number;
  x: number | null;
  y: number | null;
}

export interface StepLogInput {
  action: string | null;
  currentMission: string | null;
  currentSubgoal: string | null;
  failureType: string | null;
  goalDistance: number | null;
  mapId: number | null;
  mapKey: string | null;
  mode: string;
  progressScore: number;
  recoveryTriggered: boolean;
  repeatedActionCount: number;
  samePositionCount: number;
  sameScreenCount: number;
  screenHash: string | null;
  step: number;
  stuckScore: number;
  timestamp: string;
  x: number | null;
  y: number | null;
}

export interface EvaluationInput {
  averageStuckScore: number;
  battleCount: number;
  battleLosses: number;
  battleWins: number;
  currentMission: string | null;
  failedRecoveries: number;
  failureReason: string | null;
  highestMissionReached: string | null;
  mapTransitions: number;
  maxStuckScore: number;
  missionCompleted: boolean;
  nextImprovement: string | null;
  pathTakenSummary: string;
  runId: string;
  runtimeSeconds: number;
  startedAt: string;
  stuckEvents: number;
  successfulRecoveries: number;
  timeToViridianSeconds: number | null;
  topFailureModes: readonly string[];
  totalSteps: number;
  uniqueCoordinatesSeen: number;
  uniqueMapsSeen: number;
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function writeRuntimeState(
  memoryDir: string,
  input: RuntimeStateInput
): void {
  const path = join(memoryDir, "runtime_state.json");
  ensureDir(path);
  const snapshot = {
    current_map: input.currentMap,
    current_mission: input.currentMission,
    current_subgoal: input.currentSubgoal,
    forbidden_actions: input.forbiddenActions,
    in_battle: input.inBattle,
    in_dialog: input.inDialog,
    in_menu: input.inMenu,
    last_action: input.lastAction,
    mode: input.mode,
    recovery_mode: input.recoveryMode,
    stuck_score: round(input.stuckScore, 3),
    x: input.x,
    y: input.y,
  };
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function stepLogRecord(input: StepLogInput): Record<string, unknown> {
  return {
    action: input.action,
    current_mission: input.currentMission,
    current_subgoal: input.currentSubgoal,
    failure_type: input.failureType,
    goal_distance: input.goalDistance,
    map_id: input.mapId,
    map_key: input.mapKey,
    mode: input.mode,
    progress_score: round(input.progressScore, 2),
    recovery_triggered: input.recoveryTriggered,
    repeated_action_count: input.repeatedActionCount,
    same_position_count: input.samePositionCount,
    same_screen_count: input.sameScreenCount,
    screen_hash: input.screenHash,
    step: input.step,
    stuck_score: round(input.stuckScore, 3),
    timestamp: input.timestamp,
    x: input.x,
    y: input.y,
  };
}

export function appendStepLog(logsDir: string, input: StepLogInput): void {
  const path = join(logsDir, "agent_steps.jsonl");
  ensureDir(path);
  appendFileSync(path, `${JSON.stringify(stepLogRecord(input))}\n`);
}

export interface ProgressInput {
  mapTransitionCount: number;
  missionIndex: number;
  recoveryFailures: number;
  stuckEvents: number;
  uniqueCoordinatesSeen: number;
}

export function computeProgressScore(input: ProgressInput): number {
  return (
    input.missionIndex * 100 +
    input.mapTransitionCount * 10 +
    input.uniqueCoordinatesSeen * 0.1 -
    input.stuckEvents * 5 -
    input.recoveryFailures * 10
  );
}

export function renderEvaluationReport(input: EvaluationInput): string {
  const lines = [
    `# Run Evaluation — ${input.runId}`,
    "",
    `- started_at: ${input.startedAt}`,
    `- total_steps: ${input.totalSteps}`,
    `- runtime_seconds: ${round(input.runtimeSeconds, 1)}`,
    `- current_mission: ${input.currentMission ?? "none"}`,
    `- mission_completed: ${input.missionCompleted}`,
    `- highest_mission_reached: ${input.highestMissionReached ?? "none"}`,
    `- map_transitions: ${input.mapTransitions}`,
    `- unique_maps_seen: ${input.uniqueMapsSeen}`,
    `- unique_coordinates_seen: ${input.uniqueCoordinatesSeen}`,
    `- battle_count: ${input.battleCount}`,
    `- battle_wins: ${input.battleWins}`,
    `- battle_losses: ${input.battleLosses}`,
    `- stuck_events: ${input.stuckEvents}`,
    `- successful_recoveries: ${input.successfulRecoveries}`,
    `- failed_recoveries: ${input.failedRecoveries}`,
    `- average_stuck_score: ${round(input.averageStuckScore, 3)}`,
    `- max_stuck_score: ${round(input.maxStuckScore, 3)}`,
    `- time_to_viridian: ${
      input.timeToViridianSeconds === null
        ? "not reached"
        : `${round(input.timeToViridianSeconds, 1)}s`
    }`,
    `- failure_reason: ${input.failureReason ?? "none"}`,
    "",
    "## path_taken_summary",
    input.pathTakenSummary || "(none)",
    "",
    "## top_failure_modes",
    ...(input.topFailureModes.length > 0
      ? input.topFailureModes.map((mode) => `- ${mode}`)
      : ["- (none)"]),
    "",
    "## next_improvement",
    input.nextImprovement ?? "(none)",
    "",
  ];
  return lines.join("\n");
}

export function writeEvaluationReport(
  reportsDir: string,
  fileStamp: string,
  content: string
): string {
  const path = join(reportsDir, `run_${fileStamp}.md`);
  ensureDir(path);
  writeFileSync(path, content);
  return path;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
