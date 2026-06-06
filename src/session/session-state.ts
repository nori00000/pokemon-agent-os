import type { PokemonStateObservation } from "../pokemon-state";

export type SessionMode = "battle" | "dialog" | "menu" | "overworld" | "title" | "unknown";

export type SessionPhase = "booting" | "diagnostic" | "synced";

export interface SessionEvent {
  authoritativeMode: SessionMode;
  evidenceMode?: SessionMode;
  evidenceSource?: string;
  kind: "mode-mismatch" | "mode-sync" | "mode-unknown";
  timestamp: string;
}

export interface MiniState {
  frame?: number | null;
  mapId?: number | null;
  mode: SessionMode;
  x?: number | null;
  y?: number | null;
}

export interface SessionState {
  events: SessionEvent[];
  miniState?: MiniState;
  mode: SessionMode;
  phase: SessionPhase;
  updatedAt: string;
}

export function createSessionState(mode: SessionMode = "unknown"): SessionState {
  return {
    events: [],
    mode,
    phase: mode === "unknown" ? "booting" : "synced",
    updatedAt: new Date().toISOString(),
  };
}

export function inferEvidenceMode(state: PokemonStateObservation): SessionMode {
  if (state.battle) {
    return "battle";
  }
  if (state.menuLike === true) {
    return "menu";
  }
  if (state.dialogueLike === true || state.dialogueLike === "visual-fallback") {
    return "dialog";
  }
  if (state.readStatus === "unavailable") {
    return "unknown";
  }
  return "overworld";
}

export function updateSessionEvidence(
  session: SessionState,
  evidenceMode: SessionMode,
  evidenceSource: string
): SessionState {
  const timestamp = new Date().toISOString();
  const event: SessionEvent =
    session.mode === "unknown"
      ? {
          authoritativeMode: evidenceMode,
          evidenceMode,
          evidenceSource,
          kind: "mode-sync",
          timestamp,
        }
      : session.mode === evidenceMode || evidenceMode === "unknown"
        ? {
            authoritativeMode: session.mode,
            evidenceMode,
            evidenceSource,
            kind: evidenceMode === "unknown" ? "mode-unknown" : "mode-sync",
            timestamp,
          }
        : {
            authoritativeMode: session.mode,
            evidenceMode,
            evidenceSource,
            kind: "mode-mismatch",
            timestamp,
          };

  return {
    ...session,
    events: [...session.events, event],
    mode: session.mode === "unknown" ? evidenceMode : session.mode,
    phase: evidenceMode === "unknown" ? "diagnostic" : "synced",
    updatedAt: timestamp,
  };
}
