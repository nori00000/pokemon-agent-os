import type { FailureType, GameState } from "./game-state";
import { STUCK_THRESHOLD } from "./game-state";
import type { MapExit, Mission, MoveButton, SpatialGraph } from "./knowledge";
import { directionToTarget, manhattan, nextExitToward } from "./knowledge";
import type { OccupancyGrid } from "./pathfinder";
import { nextStepToward } from "./pathfinder";

export type Button =
  | "A"
  | "B"
  | "Down"
  | "Left"
  | "Right"
  | "Select"
  | "Start"
  | "Up";

export type AgentKind =
  | "battle"
  | "dialog"
  | "menu"
  | "navigation"
  | "recovery";

export interface Decision {
  agent: AgentKind;
  button: Button;
  reason: string;
  recoveryTriggered: boolean;
  subgoal: string | null;
}

export interface BrainInput {
  failureType: FailureType | null;
  forbidden: readonly string[];
  mission: Mission | null;
  occupancy?: OccupancyGrid;
  recoveries: readonly string[];
  recoveryStepIndex: number;
  spatial: SpatialGraph;
  state: GameState;
  stuckScore: number;
}

const OPPOSITE: Record<MoveButton, MoveButton> = {
  Down: "Up",
  Left: "Right",
  Right: "Left",
  Up: "Down",
};

const LATERAL: Record<MoveButton, MoveButton> = {
  Down: "Right",
  Left: "Up",
  Right: "Down",
  Up: "Left",
};

const MOVE_BUTTONS: readonly MoveButton[] = ["Up", "Down", "Left", "Right"];

function connectionDirection(exitType: string): MoveButton | null {
  if (exitType.startsWith("north")) {
    return "Up";
  }
  if (exitType.startsWith("south")) {
    return "Down";
  }
  if (exitType.startsWith("east")) {
    return "Right";
  }
  if (exitType.startsWith("west")) {
    return "Left";
  }
  return null;
}

function lastMoveButton(state: GameState): MoveButton | null {
  const action = state.lastAction;
  if (!action) {
    return null;
  }
  for (const button of MOVE_BUTTONS) {
    if (action.includes(button)) {
      return button;
    }
  }
  return null;
}

/** Has the player reached the exit trigger tile? */
export function atTrigger(state: GameState, exit: MapExit): boolean {
  return state.x === exit.trigger.x && state.y === exit.trigger.y;
}

function avoidForbidden(button: Button, forbidden: readonly string[]): Button {
  if (!forbidden.includes(button)) {
    return button;
  }
  for (const candidate of MOVE_BUTTONS) {
    if (!forbidden.includes(candidate)) {
      return candidate;
    }
  }
  return "A";
}

function navigate(input: BrainInput): Decision {
  const { mission, spatial, state } = input;
  if (state.mapKey === null) {
    return {
      agent: "navigation",
      button: avoidForbidden("Up", input.forbidden),
      reason: "map unknown; exploratory step pending calibration",
      recoveryTriggered: false,
      subgoal: "explore_unknown_map",
    };
  }
  const targetMap = mission?.successMap ?? null;
  if (!targetMap || targetMap === state.mapKey) {
    return {
      agent: "navigation",
      button: avoidForbidden("Up", input.forbidden),
      reason: mission
        ? `at/within target map ${state.mapKey}; holding pattern`
        : "no active mission; exploratory step",
      recoveryTriggered: false,
      subgoal: mission ? "arrived_or_internal" : "explore",
    };
  }
  const exit = nextExitToward(spatial, state.mapKey, targetMap);
  if (!exit) {
    return {
      agent: "navigation",
      button: avoidForbidden("Up", input.forbidden),
      reason: `no known route ${state.mapKey} -> ${targetMap}; exploring`,
      recoveryTriggered: false,
      subgoal: `route_unknown:${targetMap}`,
    };
  }
  return navigateTowardExit(input, exit, targetMap, state.mapKey);
}

function navigateTowardExit(
  input: BrainInput,
  exit: MapExit,
  targetMap: string,
  mapKey: string
): Decision {
  const { state } = input;
  const subgoal = `reach_exit:${exit.to}@(${exit.trigger.x},${exit.trigger.y})`;
  if (state.x === null || state.y === null) {
    return {
      agent: "navigation",
      button: avoidForbidden("Up", input.forbidden),
      reason: "position unknown; cannot path; exploratory step",
      recoveryTriggered: false,
      subgoal,
    };
  }
  if (atTrigger(state, exit)) {
    const cross = connectionDirection(exit.type) ?? "Down";
    return {
      agent: "navigation",
      button: avoidForbidden(cross, input.forbidden),
      reason: `on ${exit.type} trigger to ${exit.to}; crossing ${cross}`,
      recoveryTriggered: false,
      subgoal,
    };
  }
  const here = { x: state.x, y: state.y };
  const astar = input.occupancy
    ? nextStepToward(input.occupancy, mapKey, here, exit.trigger)
    : null;
  const step = astar ?? directionToTarget(here, exit.trigger);
  const dist = manhattan(here, exit.trigger);
  return {
    agent: "navigation",
    button: avoidForbidden(step ?? "Up", input.forbidden),
    reason: `route to ${targetMap}: step ${step} toward exit ${exit.to} (d=${dist})`,
    recoveryTriggered: false,
    subgoal,
  };
}

function recover(input: BrainInput): Decision {
  const { recoveries, recoveryStepIndex, state } = input;
  const primitive = recoveries[recoveryStepIndex] ?? "reset_subgoal";
  const last = lastMoveButton(state);
  const button = recoveryButton(primitive, last);
  if (button === null) {
    return { ...navigate(input), recoveryTriggered: true };
  }
  return {
    agent: "recovery",
    button: avoidForbidden(button, input.forbidden),
    reason: `recovery[${recoveryStepIndex}] ${primitive} (failure=${input.failureType})`,
    recoveryTriggered: true,
    subgoal: `recover:${primitive}`,
  };
}

function recoveryButton(
  primitive: string,
  last: MoveButton | null
): Button | null {
  switch (primitive) {
    case "press_A":
    case "detect_dialog_closed":
      return "A";
    case "press_B":
    case "press_B_until_closed":
    case "wait":
      return "B";
    case "step_back":
    case "backtrack_to_last_progress":
      return last ? OPPOSITE[last] : "Down";
    case "forbid_repeated_direction":
    case "try_lateral_move":
      return last ? LATERAL[last] : "Right";
    case "reset_subgoal":
    case "realign_to_trigger_coordinate":
    case "retry_transition":
    case "choose_alternative_exit":
      return null;
    default:
      return "B";
  }
}

/**
 * Deterministic Coordinator (spec section 15.1). Routes the live state to one
 * agent and returns exactly one button. No LLM involved.
 */
export function decide(input: BrainInput): Decision {
  const { state, stuckScore } = input;

  if (state.inBattle) {
    return {
      agent: "battle",
      button: "A",
      reason: "battle MVP policy: select first move / advance (mash A)",
      recoveryTriggered: false,
      subgoal: "battle_resolve",
    };
  }
  if (state.inMenu) {
    return {
      agent: "menu",
      button: "B",
      reason: "menu open; closing with B",
      recoveryTriggered: false,
      subgoal: "close_menu",
    };
  }
  if (state.inDialog) {
    return {
      agent: "dialog",
      button: "A",
      reason: "dialog active; advancing with A",
      recoveryTriggered: false,
      subgoal: "advance_dialog",
    };
  }
  if (stuckScore > STUCK_THRESHOLD && input.failureType !== null) {
    return recover(input);
  }
  return navigate(input);
}
