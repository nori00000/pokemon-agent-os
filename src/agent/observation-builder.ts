import type { MgbaHttpClient } from "../mgba-http";
import { captureMgbaObservation, type MgbaObservation } from "../observation";
import type { PokemonStateObservation } from "../pokemon-state";
import {
  inferEvidenceMode,
  type SessionState,
  updateSessionEvidence,
} from "../session/session-state";

export interface BuiltObservation {
  observation: MgbaObservation;
  sessionState: SessionState;
}

export class ObservationBuilder {
  readonly #client: MgbaHttpClient;
  #sessionState: SessionState;

  constructor(client: MgbaHttpClient, sessionState: SessionState) {
    this.#client = client;
    this.#sessionState = sessionState;
  }

  get sessionState(): SessionState {
    return this.#sessionState;
  }

  async build(signal?: AbortSignal): Promise<BuiltObservation> {
    const observation = await captureMgbaObservation(this.#client, signal);
    this.#sessionState = updateSessionEvidence(
      this.#sessionState,
      inferEvidenceMode(observation.state ?? unavailableObservation()),
      "pokemon-state"
    );
    return {
      observation,
      sessionState: this.#sessionState,
    };
  }
}

function unavailableObservation(): PokemonStateObservation {
  return {
    battle: false,
    battleResult: null,
    battleType: null,
    dialogueLike: "visual-fallback",
    direction: "unknown",
    mapId: null,
    menuLike: "visual-fallback",
    position: { x: null, y: null },
    readStatus: "unavailable",
  };
}
