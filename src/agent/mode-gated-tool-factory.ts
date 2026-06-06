import type { AgentTool, AgentToolExecutionOptions, AgentTools } from "@minpeter/pss-runtime";
import type { SessionMode, SessionState } from "../session/session-state";

export type ToolCategory = "battle" | "dialog" | "memory" | "menu" | "navigation" | "release" | "wait";

export interface ModeGatedToolFactoryOptions {
  getSessionState: () => SessionState;
  tools: AgentTools;
}

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  mgba_hold: "navigation",
  mgba_hold_many: "navigation",
  mgba_release: "release",
  mgba_tap: "dialog",
  mgba_tap_many: "dialog",
};

const ALLOWED_CATEGORIES_BY_MODE: Record<SessionMode, ReadonlySet<ToolCategory>> = {
  battle: new Set(["battle", "dialog", "memory", "release", "wait"]),
  dialog: new Set(["dialog", "memory", "release", "wait"]),
  menu: new Set(["dialog", "memory", "menu", "release", "wait"]),
  overworld: new Set(["memory", "menu", "navigation", "release", "wait"]),
  title: new Set(["dialog", "memory", "release", "wait"]),
  unknown: new Set(["memory", "release", "wait"]),
};

export function isToolAllowedForMode(
  mode: SessionMode,
  toolName: string
): boolean {
  const category = TOOL_CATEGORIES[toolName] ?? "memory";
  return ALLOWED_CATEGORIES_BY_MODE[mode].has(category);
}

export class ModeGatedToolFactory {
  readonly #getSessionState: () => SessionState;
  readonly #tools: AgentTools;

  constructor({ getSessionState, tools }: ModeGatedToolFactoryOptions) {
    this.#getSessionState = getSessionState;
    this.#tools = tools;
  }

  resolveTools(): AgentTools {
    return Object.fromEntries(
      Object.entries(this.#tools).map(([name, tool]) => [
        name,
        this.#wrapTool(name, tool as AgentTool),
      ])
    ) as AgentTools;
  }

  #wrapTool(name: string, tool: AgentTool): AgentTool {
    const execute = tool.execute;
    if (!execute) {
      return tool;
    }

    return {
      ...tool,
      execute: async (input: unknown, options: AgentToolExecutionOptions) => {
        const { mode } = this.#getSessionState();
        if (!isToolAllowedForMode(mode, name)) {
          return {
            executed: false,
            ok: false,
            reason: "tool-not-allowed",
            session_mode: mode,
            tool: name,
          };
        }
        return execute(input, options);
      },
    } satisfies AgentTool;
  }
}
