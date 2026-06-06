import type { InputResult } from "./input-gate";

export interface SupervisorHint {
  confidence: number;
  failure_type?: "dialog_loop" | "failed_map_transition" | "menu_loop" | "wall_loop";
  forbidden_actions: Array<{ action: string; until_step: number }>;
  hint: string;
  recommended_macro_action?: string;
  should_create_issue: boolean;
  should_create_pr: boolean;
}

export class Supervisor {
  evaluateInput(result: InputResult, step: number): SupervisorHint | undefined {
    if (result.transition.kind !== "none" || !result.executed) {
      return undefined;
    }
    if (result.intent !== "navigation") {
      return undefined;
    }

    return {
      confidence: 0.7,
      failure_type: "wall_loop",
      forbidden_actions: [{ action: String(result.button), until_step: step + 10 }],
      hint: `Navigation input ${String(result.button)} produced no transition. Treat this as wall/collision evidence and try a lateral move.`,
      recommended_macro_action: "recover_from_wall_loop",
      should_create_issue: false,
      should_create_pr: false,
    };
  }
}
