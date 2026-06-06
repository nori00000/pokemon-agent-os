import type { MgbaButton } from "../mgba-http";
import type { InputGate, InputIntent, InputResult } from "../session/input-gate";

export type GameCommand =
  | {
      button: MgbaButton;
      frames?: number;
      intent?: InputIntent;
      kind: "press";
    }
  | { kind: "release-all" }
  | { kind: "wait" };

export interface CommandExecutionResult {
  ignored: GameCommand[];
  result?: InputResult;
}

export class CommandExecutor {
  readonly #inputGate: InputGate;

  constructor(inputGate: InputGate) {
    this.#inputGate = inputGate;
  }

  async executeOne(commands: readonly GameCommand[]): Promise<CommandExecutionResult> {
    const [first, ...ignored] = commands;
    if (!first || first.kind === "wait") {
      return { ignored };
    }
    if (first.kind === "release-all") {
      return { ignored, result: await this.#inputGate.releaseAll() };
    }
    return {
      ignored,
      result: await this.#inputGate.press(first.button, {
        frames: first.frames,
        intent: first.intent,
      }),
    };
  }
}
