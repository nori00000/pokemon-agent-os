import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isToolAllowedForMode } from "../src/agent/mode-gated-tool-factory";
import { CommandExecutor, type GameCommand } from "../src/executor/command-executor";
import { EvidenceRecorder } from "../src/evaluation/evidence-recorder";
import {
  DEFAULT_EMULATOR_FPS,
  normalizeEpisodeRunConfig,
} from "../src/evaluation/run-config";
import { InputGate, type InputResult } from "../src/session/input-gate";
import type { MiniState, SessionMode } from "../src/session/session-state";

describe("Grokemon integration contracts", () => {
  it("enforces mode-gated tools in code", () => {
    expect(isToolAllowedForMode("battle", "mgba_hold")).toBe(false);
    expect(isToolAllowedForMode("dialog", "mgba_hold")).toBe(false);
    expect(isToolAllowedForMode("overworld", "mgba_tap")).toBe(false);
    expect(isToolAllowedForMode("overworld", "mgba_hold")).toBe(true);
  });

  it("defaults emulator_fps to 240 and rejects unsupported values", () => {
    expect(normalizeEpisodeRunConfig().emulator_fps).toBe(DEFAULT_EMULATOR_FPS);
    expect(normalizeEpisodeRunConfig({ emulator_fps: 60 }).emulator_fps).toBe(60);
    expect(normalizeEpisodeRunConfig({ emulator_fps: 640 }).emulator_fps).toBe(640);
    expect(() =>
      normalizeEpisodeRunConfig({ emulator_fps: 120 as never })
    ).toThrow(/Unsupported emulator_fps/);
  });

  it("logs input transactions and rejects mode mismatches", async () => {
    const states: MiniState[] = [
      { frame: 1, mapId: 1, mode: "dialog", x: 4, y: 5 },
    ];
    const results: InputResult[] = [];
    const gate = new InputGate({
      client: fakeClient(),
      readMiniState: async () => states.at(-1) ?? states[0],
      recordInput: (result) => {
        results.push(result);
      },
      sessionMode: () => "dialog",
    });

    const result = await gate.press("Up", { intent: "navigation" });

    expect(result.executed).toBe(false);
    expect(result.reason).toBe("mode-mismatch");
    expect(results).toHaveLength(1);
  });

  it("executes only one game action per command turn", async () => {
    const states: MiniState[] = [
      { frame: 1, mapId: 1, mode: "overworld", x: 4, y: 5 },
      { frame: 2, mapId: 1, mode: "overworld", x: 4, y: 4 },
    ];
    let readCount = 0;
    const gate = new InputGate({
      client: fakeClient(),
      readMiniState: async () => states[Math.min(readCount++, states.length - 1)],
      sessionMode: () => "overworld",
    });
    const executor = new CommandExecutor(gate);
    const commands: GameCommand[] = [
      { button: "Up", kind: "press", intent: "navigation" },
      { button: "Left", kind: "press", intent: "navigation" },
    ];

    const result = await executor.executeOne(commands);

    expect(result.result?.button).toBe("Up");
    expect(result.result?.transition.kind).toBe("movement");
    expect(result.ignored).toHaveLength(1);
  });

  it("records emulator_fps in config and evidence package paths", async () => {
    const runDir = join(tmpdir(), `pss-mgba-evidence-${Date.now()}`);
    await mkdir(runDir, { recursive: true });
    try {
      const config = normalizeEpisodeRunConfig({ emulator_fps: 640 });
      const recorder = new EvidenceRecorder(runDir, config);
      await recorder.initialize();

      const rawConfig = await readFile(join(runDir, "config.json"), "utf8");
      const debugNotes = await readFile(join(runDir, "debug_notes.md"), "utf8");

      expect(JSON.parse(rawConfig)).toMatchObject({ emulator_fps: 640 });
      expect(recorder.package.input_results).toContain("input_results.jsonl");
      expect(debugNotes).toContain("mGBA frontend fast-forward setting");
    } finally {
      await rm(runDir, { force: true, recursive: true });
    }
  });
});

function fakeClient() {
  return {
    clear: async () => "ok",
    clearMany: async () => "ok",
    hold: async () => "ok",
    holdMany: async () => "ok",
    screenshot: async () => "ok",
    status: async () => ({ activeButtons: [], frame: 1, gameCode: "POKE", gameTitle: "RED" }),
    tap: async () => "ok",
    tapMany: async () => "ok",
  };
}
