import type { MgbaButton } from "../mgba-http";
import type { SupervisedClient } from "../supervisor";
import { detectTransition, type StateTransition } from "./transition-detector";
import type { MiniState, SessionMode } from "./session-state";

export type InputIntent = "battle" | "dialog" | "menu" | "navigation" | "release" | "wait";

export type InputRejectReason =
  | "mode-mismatch"
  | "text-window"
  | "tool-not-allowed"
  | "walk-animation";

export interface InputResult {
  after: MiniState;
  before: MiniState;
  button: MgbaButton | "ALL" | "WAIT";
  executed: boolean;
  frames?: number;
  intent: InputIntent;
  polls: number;
  reason?: InputRejectReason;
  settle_timed_out: boolean;
  source: "agent" | "supervisor" | "test";
  transition: StateTransition;
}

export interface InputGateOptions {
  client: SupervisedClient;
  readMiniState: (signal?: AbortSignal) => Promise<MiniState>;
  recordInput?: (result: InputResult) => Promise<void> | void;
  sessionMode: () => SessionMode;
}

const DIRECTION_BUTTONS = new Set<MgbaButton>(["Up", "Down", "Left", "Right"]);

export function inputIntentForButton(button: MgbaButton): InputIntent {
  return DIRECTION_BUTTONS.has(button) ? "navigation" : "dialog";
}

export function isInputAllowed(mode: SessionMode, intent: InputIntent): boolean {
  if (intent === "release" || intent === "wait") {
    return true;
  }
  if (mode === "battle") {
    return intent === "battle" || intent === "dialog";
  }
  if (mode === "dialog" || mode === "title") {
    return intent === "dialog" || intent === "menu";
  }
  if (mode === "menu") {
    return intent === "menu" || intent === "dialog";
  }
  if (mode === "overworld") {
    return intent === "navigation" || intent === "menu";
  }
  return false;
}

export class InputGate {
  readonly #client: SupervisedClient;
  readonly #readMiniState: (signal?: AbortSignal) => Promise<MiniState>;
  readonly #recordInput: ((result: InputResult) => Promise<void> | void) | undefined;
  readonly #sessionMode: () => SessionMode;

  constructor({
    client,
    readMiniState,
    recordInput,
    sessionMode,
  }: InputGateOptions) {
    this.#client = client;
    this.#readMiniState = readMiniState;
    this.#recordInput = recordInput;
    this.#sessionMode = sessionMode;
  }

  async press(
    button: MgbaButton,
    {
      frames,
      intent = inputIntentForButton(button),
      signal,
      source = "agent",
    }: {
      frames?: number;
      intent?: InputIntent;
      signal?: AbortSignal;
      source?: InputResult["source"];
    } = {}
  ): Promise<InputResult> {
    const before = await this.#readMiniState(signal);
    const mode = this.#sessionMode();
    if (!isInputAllowed(mode, intent)) {
      return this.#record({
        after: before,
        before,
        button,
        executed: false,
        frames,
        intent,
        polls: 0,
        reason: "mode-mismatch",
        settle_timed_out: false,
        source,
        transition: detectTransition(before, before),
      });
    }

    if (frames === undefined) {
      await this.#client.tap(button, signal);
    } else {
      await this.#client.hold(button, frames, signal);
    }

    const after = await this.#readMiniState(signal);
    return this.#record({
      after,
      before,
      button,
      executed: true,
      frames,
      intent,
      polls: 1,
      settle_timed_out: false,
      source,
      transition: detectTransition(before, after),
    });
  }

  async releaseAll(signal?: AbortSignal): Promise<InputResult> {
    const before = await this.#readMiniState(signal);
    await this.#client.clearMany(["A", "B", "Start", "Select", "Up", "Down", "Left", "Right"], signal);
    const after = await this.#readMiniState(signal);
    return this.#record({
      after,
      before,
      button: "ALL",
      executed: true,
      intent: "release",
      polls: 1,
      settle_timed_out: false,
      source: "agent",
      transition: detectTransition(before, after),
    });
  }

  async #record(result: InputResult): Promise<InputResult> {
    await this.#recordInput?.(result);
    return result;
  }
}
