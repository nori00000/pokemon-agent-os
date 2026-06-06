export const SUPPORTED_EMULATOR_FPS = [60, 240, 640] as const;
export const DEFAULT_EMULATOR_FPS: EmulatorFps = 240;

export type EmulatorFps = (typeof SUPPORTED_EMULATOR_FPS)[number];

export interface EpisodeRunConfig {
  emulator_fps: EmulatorFps;
  goal: string;
  llm_supervisor_interval: number;
  max_steps: number;
  screenshot_interval: number;
}

export function normalizeEpisodeRunConfig(
  config: Partial<EpisodeRunConfig> = {}
): EpisodeRunConfig {
  const emulatorFps = config.emulator_fps ?? DEFAULT_EMULATOR_FPS;
  if (!SUPPORTED_EMULATOR_FPS.includes(emulatorFps)) {
    throw new Error(
      `Unsupported emulator_fps ${emulatorFps}. Supported values: ${SUPPORTED_EMULATOR_FPS.join(", ")}`
    );
  }

  return {
    emulator_fps: emulatorFps,
    goal: config.goal ?? "reach_viridian_city",
    llm_supervisor_interval: config.llm_supervisor_interval ?? 100,
    max_steps: config.max_steps ?? 2000,
    screenshot_interval: config.screenshot_interval ?? 100,
  };
}

export function emulatorFpsContractNote(config: EpisodeRunConfig): string {
  return [
    `Configured emulator_fps=${config.emulator_fps}.`,
    "This is an episode/run contract field only.",
    "The current mGBA socket Lua API exposes no emulation-speed command, so applying this value requires the mGBA frontend fast-forward setting.",
    "LLM supervisor cadence remains controlled by llm_supervisor_interval and must not run per emulator frame.",
  ].join(" ");
}
