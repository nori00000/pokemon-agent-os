import type { AgentTools } from "@minpeter/pss-runtime";
import { ModeGatedToolFactory } from "../agent/mode-gated-tool-factory";
import { env } from "../env";
import { MGBA_BUTTONS, MgbaHttpClient } from "../mgba-http";
import type { SessionState } from "../session/session-state";
import {
  createSupervisedMgbaClient,
  type SupervisorIntervention,
} from "../supervisor";
import type { MgbaToolContext } from "./context";
import { createHoldManyTool, createHoldTool } from "./hold";
import { createReleaseTool } from "./release";
import { createTapManyTool, createTapTool } from "./tap";

export interface MgbaControlPlaneOptions {
  client?: MgbaHttpClient;
  onSupervisorIntervention?: (intervention: SupervisorIntervention) => void;
  sessionState?: SessionState;
}

export function createMgbaControlPlane({
  client = new MgbaHttpClient({ baseUrl: env.MGBA_HTTP_BASE_URL }),
  onSupervisorIntervention,
  sessionState,
}: MgbaControlPlaneOptions = {}): AgentTools {
  const tools = createMgbaTools({
    client: createSupervisedMgbaClient(client, {
      onIntervention: onSupervisorIntervention,
    }),
  });
  if (!sessionState) {
    return tools;
  }
  return new ModeGatedToolFactory({
    getSessionState: () => sessionState,
    tools,
  }).resolveTools();
}

export function describeMgbaControlPlane(): string {
  return describeMgbaTools();
}

function createMgbaTools(context: MgbaToolContext): AgentTools {
  return {
    mgba_tap: createTapTool(context),
    mgba_tap_many: createTapManyTool(context),
    mgba_hold: createHoldTool(context),
    mgba_hold_many: createHoldManyTool(context),
    mgba_release: createReleaseTool(context),
  } satisfies AgentTools;
}

function describeMgbaTools(): string {
  return [
    "You can control the already-running game through button tools.",
    "Game progress must never be reset or reloaded by the model; reset and ROM-loading tools are intentionally not exposed.",
    `Available buttons: ${MGBA_BUTTONS.join(", ")}.`,
    "Use mgba_tap for A/B/Start/Select interactions, dialogue, menus, and facing/very small directional nudges. Use mgba_hold for movement. A local supervisor enforces deterministic timing: single directional movement uses duration 12, non-directional taps use duration 6, and unsafe long movement chains are shortened to one supervised tile before the next observation.",
    "Mode-gated tools are enforced in code using SessionState.mode as the authority; raw RAM/screenshot mode evidence is diagnostic and does not override the session authority.",
    "The runner injects current screenshot/status into each turn, so model-facing tools are limited to game controls.",
  ].join("\n");
}
