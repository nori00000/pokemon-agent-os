import { readFile } from "node:fs/promises";
import { MGBA_BUTTONS, type MgbaButton, type MgbaStatus } from "./mgba-http";
import { sampleGameBoyBlackFrame } from "./screenshot-image";
import { createScreenshotPath } from "./screenshot-path";

export const DIRECTIONAL_HOLD_DURATION = 12;
export const NON_DIRECTIONAL_TAP_DURATION = 6;
export const POST_ACTION_SETTLE_FRAMES = 200;
export const BLACK_FRAME_MAX_POLLS = 5;

const DIRECTION_BUTTONS = new Set<MgbaButton>(["Up", "Down", "Left", "Right"]);
const BUTTON_SET = new Set<MgbaButton>(MGBA_BUTTONS);

export type SupervisorInterventionReason =
  | "black-frame-wait"
  | "invalid-button"
  | "long-movement-split"
  | "settle-wait"
  | "timing-normalized";

export interface SupervisorIntervention {
  blackFrames?: number;
  blackPixelRatio?: number;
  detail: string;
  polls?: number;
  reason: SupervisorInterventionReason;
  settledFrame?: number;
  startFrame?: number;
  targetFrame?: number;
}

export interface SupervisorInterventionEvent {
  intervention: SupervisorIntervention;
  type: "supervisor-intervention";
}

export interface SupervisedClient {
  clear(button: MgbaButton, signal?: AbortSignal): Promise<string>;
  clearMany(
    buttons: readonly MgbaButton[],
    signal?: AbortSignal
  ): Promise<string>;
  hold(
    button: MgbaButton,
    duration: number,
    signal?: AbortSignal
  ): Promise<string>;
  holdMany(
    buttons: readonly MgbaButton[],
    duration: number,
    signal?: AbortSignal
  ): Promise<string>;
  screenshot(path: string, signal?: AbortSignal): Promise<string>;
  status(signal?: AbortSignal): Promise<MgbaStatus>;
  tap(button: MgbaButton, signal?: AbortSignal): Promise<string>;
  tapMany(
    buttons: readonly MgbaButton[],
    signal?: AbortSignal
  ): Promise<string>;
}

export interface SupervisorOptions {
  onIntervention?: (intervention: SupervisorIntervention) => void;
}

export function createSupervisedMgbaClient<T extends SupervisedClient>(
  client: T,
  { onIntervention }: SupervisorOptions = {}
): T {
  const supervisor = new MgbaSupervisor(client, onIntervention);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "tap") {
        return supervisor.tap;
      }
      if (property === "tapMany") {
        return supervisor.tapMany;
      }
      if (property === "hold") {
        return supervisor.hold;
      }
      if (property === "holdMany") {
        return supervisor.holdMany;
      }
      if (property === "clear") {
        return supervisor.clear;
      }
      if (property === "clearMany") {
        return supervisor.clearMany;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export async function waitThroughBlackFrames({
  client,
  onIntervention,
  signal,
}: {
  client: Pick<SupervisedClient, "screenshot">;
  onIntervention?: (intervention: SupervisorIntervention) => void;
  signal?: AbortSignal;
}): Promise<{ blackFrames: number; polls: number }> {
  let blackFrames = 0;

  for (let poll = 1; poll <= BLACK_FRAME_MAX_POLLS; poll += 1) {
    const screenshotPath = await createScreenshotPath();
    await client.screenshot(screenshotPath, signal);
    const sample = sampleGameBoyBlackFrame(await readFile(screenshotPath));
    if (!sample.isBlackFrame) {
      return { blackFrames, polls: poll };
    }
    blackFrames += 1;
    onIntervention?.({
      blackFrames,
      blackPixelRatio: sample.blackPixelRatio,
      detail: `black/loading frame ${poll} (${sample.blackPixelRatio.toFixed(4)} black pixels)`,
      polls: poll,
      reason: "black-frame-wait",
    });
  }

  return { blackFrames, polls: BLACK_FRAME_MAX_POLLS };
}

export function createSupervisorEvent(
  intervention: SupervisorIntervention
): SupervisorInterventionEvent {
  return {
    intervention,
    type: "supervisor-intervention",
  };
}

class MgbaSupervisor {
  readonly #client: SupervisedClient;
  readonly #onIntervention:
    | ((intervention: SupervisorIntervention) => void)
    | undefined;
  #controlQueue: Promise<void> = Promise.resolve();

  constructor(
    client: SupervisedClient,
    onIntervention: ((intervention: SupervisorIntervention) => void) | undefined
  ) {
    this.#client = client;
    this.#onIntervention = onIntervention;
  }

  tap = (button: MgbaButton, signal?: AbortSignal): Promise<string> =>
    this.#runControl(async () => {
      const normalizedButton = this.#requireButton(button);
      const startFrame = await this.#currentFrame(signal);
      const result = isDirection(normalizedButton)
        ? await this.#client.hold(
            normalizedButton,
            DIRECTIONAL_HOLD_DURATION,
            signal
          )
        : await this.#client.hold(
            normalizedButton,
            NON_DIRECTIONAL_TAP_DURATION,
            signal
          );
      this.#intervene({
        detail: `normalized tap ${normalizedButton} to hold duration ${isDirection(normalizedButton) ? DIRECTIONAL_HOLD_DURATION : NON_DIRECTIONAL_TAP_DURATION}`,
        reason: "timing-normalized",
      });
      await this.#settle(startFrame, signal);
      return result;
    });

  tapMany = (
    buttons: readonly MgbaButton[],
    signal?: AbortSignal
  ): Promise<string> =>
    this.#runControl(async () => {
      const normalizedButtons = this.#requireButtons(buttons);
      const startFrame = await this.#currentFrame(signal);
      const result = await this.#client.holdMany(
        normalizedButtons,
        NON_DIRECTIONAL_TAP_DURATION,
        signal
      );
      this.#intervene({
        detail: `normalized multi-tap ${normalizedButtons.join("+")} to hold duration ${NON_DIRECTIONAL_TAP_DURATION}`,
        reason: "timing-normalized",
      });
      await this.#settle(startFrame, signal);
      return result;
    });

  hold = (
    button: MgbaButton,
    duration: number,
    signal?: AbortSignal
  ): Promise<string> =>
    this.#runControl(async () => {
      const normalizedButton = this.#requireButton(button);
      const startFrame = await this.#currentFrame(signal);
      const fixedDuration = isDirection(normalizedButton)
        ? DIRECTIONAL_HOLD_DURATION
        : NON_DIRECTIONAL_TAP_DURATION;
      if (duration !== fixedDuration) {
        this.#intervene({
          detail: `normalized hold ${normalizedButton} duration ${duration} to ${fixedDuration}`,
          reason:
            isDirection(normalizedButton) && duration > fixedDuration
              ? "long-movement-split"
              : "timing-normalized",
        });
      }
      const result = await this.#client.hold(
        normalizedButton,
        fixedDuration,
        signal
      );
      await this.#settle(startFrame, signal);
      return result;
    });

  holdMany = (
    buttons: readonly MgbaButton[],
    duration: number,
    signal?: AbortSignal
  ): Promise<string> =>
    this.#runControl(async () => {
      const normalizedButtons = this.#requireButtons(buttons);
      if (normalizedButtons.some(isDirection)) {
        this.#intervene({
          detail: `rejected directional multi-hold ${normalizedButtons.join("+")}`,
          reason: "invalid-button",
        });
        throw new Error(
          "Supervisor rejected directional multi-button movement"
        );
      }
      const startFrame = await this.#currentFrame(signal);
      if (duration !== NON_DIRECTIONAL_TAP_DURATION) {
        this.#intervene({
          detail: `normalized multi-hold ${normalizedButtons.join("+")} duration ${duration} to ${NON_DIRECTIONAL_TAP_DURATION}`,
          reason: "timing-normalized",
        });
      }
      const result = await this.#client.holdMany(
        normalizedButtons,
        NON_DIRECTIONAL_TAP_DURATION,
        signal
      );
      await this.#settle(startFrame, signal);
      return result;
    });

  clear = (button: MgbaButton, signal?: AbortSignal): Promise<string> =>
    this.#runControl(() => this.#client.clear(button, signal));

  clearMany = (
    buttons: readonly MgbaButton[],
    signal?: AbortSignal
  ): Promise<string> =>
    this.#runControl(() => this.#client.clearMany(buttons, signal));

  async #currentFrame(signal?: AbortSignal): Promise<number | undefined> {
    const status = await this.#client.status(signal);
    return status.frame ?? undefined;
  }

  #intervene(intervention: SupervisorIntervention): void {
    this.#onIntervention?.(intervention);
  }

  #requireButton(button: MgbaButton): MgbaButton {
    if (BUTTON_SET.has(button)) {
      return button;
    }
    this.#intervene({
      detail: `rejected invalid button ${String(button)}`,
      reason: "invalid-button",
    });
    throw new Error(`Supervisor rejected invalid button: ${String(button)}`);
  }

  #requireButtons(buttons: readonly MgbaButton[]): readonly MgbaButton[] {
    return buttons.map((button) => this.#requireButton(button));
  }

  async #runControl<T>(control: () => Promise<T>): Promise<T> {
    const previous = this.#controlQueue;
    let release: () => void = () => undefined;
    this.#controlQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await control();
    } finally {
      release();
    }
  }

  async #settle(
    startFrame: number | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    if (startFrame === undefined) {
      return;
    }
    const targetFrame = startFrame + POST_ACTION_SETTLE_FRAMES;
    let polls = 0;
    while (true) {
      polls += 1;
      const frame = (await this.#client.status(signal)).frame;
      if (frame !== null && frame >= targetFrame) {
        if (polls > 1) {
          this.#intervene({
            detail: `settled from frame ${startFrame} to ${frame} after ${polls} polls`,
            polls,
            reason: "settle-wait",
            settledFrame: frame,
            startFrame,
            targetFrame,
          });
        }
        return;
      }
    }
  }
}

function isDirection(button: MgbaButton): boolean {
  return DIRECTION_BUTTONS.has(button);
}
