import type { MiniState, SessionMode } from "./session-state";

export type TransitionKind = "map" | "mode" | "movement" | "none";

export interface StateTransition {
  before: MiniState;
  from?: MiniState;
  kind: TransitionKind;
  to?: MiniState;
}

export function detectTransition(before: MiniState, after: MiniState): StateTransition {
  if (before.mode !== after.mode) {
    return { before, from: before, kind: "mode", to: after };
  }
  if (before.mapId !== after.mapId) {
    return { before, from: before, kind: "map", to: after };
  }
  if (before.x !== after.x || before.y !== after.y) {
    return { before, from: before, kind: "movement", to: after };
  }
  return { before, from: before, kind: "none", to: after };
}

export function modeFromTransition(transition: StateTransition): SessionMode | undefined {
  return transition.kind === "mode" ? transition.to?.mode : undefined;
}
