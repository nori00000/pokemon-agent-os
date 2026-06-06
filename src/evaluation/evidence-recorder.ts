import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EpisodeRunConfig } from "./run-config";

export interface EvidencePackage {
  agent_steps: string;
  command_history: string;
  config: EpisodeRunConfig;
  config_path: string;
  debug_notes: string;
  input_results: string;
  map_memory: string;
  reward_logs: string;
  run_dir: string;
  session_events: string;
  supervisor_hints: string;
  transition_trace: string;
  transitions: string;
}

export class EvidenceRecorder {
  readonly runDir: string;
  readonly package: EvidencePackage;

  constructor(runDir: string, config: EpisodeRunConfig) {
    this.runDir = runDir;
    this.package = {
      agent_steps: join(runDir, "agent_steps.jsonl"),
      command_history: join(runDir, "command_history.jsonl"),
      config,
      config_path: join(runDir, "config.json"),
      debug_notes: join(runDir, "debug_notes.md"),
      input_results: join(runDir, "input_results.jsonl"),
      map_memory: join(runDir, "map_memory.json"),
      run_dir: runDir,
      reward_logs: join(runDir, "reward_logs.jsonl"),
      session_events: join(runDir, "session_events.jsonl"),
      supervisor_hints: join(runDir, "supervisor_hints.jsonl"),
      transitions: join(runDir, "transitions.jsonl"),
      transition_trace: join(runDir, "transition_trace.jsonl"),
    };
  }

  async initialize(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await writeFile(
      this.package.config_path,
      `${JSON.stringify(this.package.config, null, 2)}\n`
    );
    await writeFile(
      this.package.map_memory,
      `${JSON.stringify({}, null, 2)}\n`
    );
    await writeFile(
      this.package.debug_notes,
      [
        "# Debug Notes",
        "",
        `- emulator_fps: ${this.package.config.emulator_fps}`,
        "- emulator_fps is recorded for experiment comparison only; the current mGBA socket Lua API exposes no emulation-speed command.",
        "- Apply the matching mGBA frontend fast-forward setting manually when running 60/240/640fps experiments.",
        "- llm_supervisor_interval controls decision cadence independently from emulator_fps.",
        "",
      ].join("\n")
    );
  }

  appendJsonl(name: keyof EvidencePackage, value: unknown): Promise<void> {
    const path = this.package[name];
    if (typeof path !== "string") {
      throw new Error(`Evidence package field ${name} is not a path`);
    }
    return appendFile(path, `${JSON.stringify(value)}\n`);
  }
}
