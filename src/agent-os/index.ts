import { join } from "node:path";
import { env } from "../env";
import type { RunnerOptions } from "./os-runner";
import { runCalibration, runDeterministic } from "./os-runner";
import { runScan } from "./scanner";

const OS_PREFIX = /^os-/;

function intArg(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function buildOptions(): RunnerOptions {
  const root = process.cwd();
  return {
    baseUrl: env.MGBA_HTTP_BASE_URL,
    knowledgeDir: join(root, "knowledge"),
    logsDir: join(root, "logs"),
    maxSteps: intArg("AGENT_OS_MAX_STEPS", 400),
    memoryDir: join(root, "memory"),
    reportsDir: join(root, "logs", "evaluation_reports"),
    settleMs: intArg("AGENT_OS_SETTLE_MS", 120),
    targetMap: process.env.AGENT_OS_TARGET ?? "VIRIDIAN_CITY",
  };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const mode = arg === "calibrate" || arg === "scan" ? arg : "deterministic";
  const options = buildOptions();
  const controller = new AbortController();
  process.on("SIGINT", () => {
    process.stderr.write(
      "\n[agent-os] SIGINT: stopping after current step...\n"
    );
    controller.abort();
  });

  process.stdout.write(
    `[agent-os] mode=${mode} base=${options.baseUrl} target=${options.targetMap} maxSteps=${options.maxSteps}\n`
  );

  if (mode === "scan") {
    const result = await runScan(options, controller.signal);
    process.stdout.write(
      `[agent-os] scan complete: map=${result.startMapKey ?? result.startMapId} walkable=${result.walkableTiles} exits=${result.exits.length} -> logs/scan.jsonl\n`
    );
    for (const ex of result.exits) {
      process.stdout.write(
        `  exit: (${ex.fromX},${ex.fromY}) ${ex.dir} -> map ${ex.arriveMapId} @ (${ex.arriveX},${ex.arriveY})\n`
      );
    }
    return;
  }

  if (mode === "calibrate") {
    const rows = await runCalibration(options, controller.signal);
    process.stdout.write(
      `[agent-os] calibration complete: ${rows.length} probes -> logs/calibration.jsonl\n`
    );
    process.stdout.write(`${summarizeCalibration(rows)}\n`);
    return;
  }

  const report = await runDeterministic(options, controller.signal);
  process.stdout.write(
    `[agent-os] run complete: steps=${report.totalSteps} reachedTarget=${report.missionCompleted} maps=${report.pathTakenSummary}\n`
  );
  process.stdout.write(
    `[agent-os] report -> logs/evaluation_reports/run_${report.runId.replace(OS_PREFIX, "")}.md\n`
  );
}

function summarizeCalibration(
  rows: readonly { button: string; dx: number | null; dy: number | null }[]
): string {
  const byButton = new Map<string, { dx: number; dy: number; n: number }>();
  for (const row of rows) {
    const entry = byButton.get(row.button) ?? { dx: 0, dy: 0, n: 0 };
    entry.dx += row.dx ?? 0;
    entry.dy += row.dy ?? 0;
    entry.n += 1;
    byButton.set(row.button, entry);
  }
  const lines = ["[agent-os] button -> mean(dx,dy):"];
  for (const [button, e] of byButton) {
    lines.push(
      `  ${button}: dx=${(e.dx / e.n).toFixed(2)} dy=${(e.dy / e.n).toFixed(2)} (n=${e.n})`
    );
  }
  return lines.join("\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`[agent-os] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
