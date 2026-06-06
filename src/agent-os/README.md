# Pokemon Red Agent OS

A deterministic, structured-knowledge agent layer over the existing
`typescript-pokemon-harness`. It implements the design in
`POKEMONDEV_AGENT_OS.md`: RAM state is the truth source, game knowledge is
externalized into JSON, navigation/recovery are deterministic, and the LLM is
**not** in the movement path.

## Why a second runner?

The existing `pnpm dev` loop is fully LLM-driven and (per `.pss-mgba/traces`)
tends to get stuck indoors. This OS replaces movement/recovery with
deterministic planners and keeps full per-step logs + an evaluation report.

## Layout

| Path | Role |
| --- | --- |
| `knowledge/spatial_graph.json` | maps, exits, warps, trigger coords (BFS routing) |
| `knowledge/mission_graph.json` | ordered missions toward Viridian (event deps embedded) |
| `knowledge/failure_dex.json` | failure modes → ordered recovery primitives |
| `memory/runtime_state.json` | small current-state snapshot (overwritten each step) |
| `logs/agent_steps.jsonl` | per-step evidence log (spec §18) |
| `logs/calibration.jsonl` | calibration probe deltas |
| `logs/evaluation_reports/run_*.md` | per-run report (spec §19) |
| `checkpoints/manifest.json` | save-state tree seed |

## Source modules

- `game-state.ts` — `normalizeGameState`, weighted `computeStuckScore` (§12), `classifyFailure`.
- `knowledge.ts` — JSON loaders + pure graph ops: `findMapRoute` (BFS), `nextExitToward`, `directionToTarget`, `selectMission`.
- `brain.ts` — deterministic Coordinator `decide()` → Navigation / Recovery / Battle / Dialog / Menu (§15.1).
- `io.ts` — runtime-state writer, step-log appender, `computeProgressScore` (§17), evaluation report renderer (§19).
- `os-runner.ts` — live loop (`runDeterministic`) + `runCalibration`.
- `index.ts` — CLI entry.

## Running (calibration-first)

The spatial-graph coordinates are seeded from documented pret/pokered map IDs
(`PALLET_TOWN=0` is confirmed from traces) but exit coordinates are
**unverified** (`calibrated:false`). Always calibrate before trusting routing.

1. Start the emulator stack (one live instance only — see root README):
   ```bash
   mgba --script .local-tools/mgba-http/mGBASocketServer.lua /absolute/path/to/pokemon-red.gb
   .local-tools/mgba-http/mGBA-http
   ```
2. Calibrate — verifies RAM addresses + button→delta and harvests real coords:
   ```bash
   AGENT_OS_MAX_STEPS=40 pnpm os:calibrate
   ```
   Read `logs/calibration.jsonl` and the printed `button -> mean(dx,dy)` table.
   Expected for Pokemon Red: `Up` lowers `y`, `Down` raises `y`, `Left` lowers
   `x`, `Right` raises `x`. If a button moves the wrong axis, the RAM x/y
   addresses in `src/pokemon-state.ts` need swapping.
3. Update `knowledge/spatial_graph.json` exit triggers from the harvested
   coordinates, set `calibrated:true`.
4. Run the deterministic agent toward Viridian:
   ```bash
   pnpm os                 # default target VIRIDIAN_CITY, 400 steps
   AGENT_OS_TARGET=ROUTE_1 AGENT_OS_MAX_STEPS=120 pnpm os
   ```
5. Inspect `logs/evaluation_reports/run_*.md` and the dominant `failure_type`
   in `logs/agent_steps.jsonl`; iterate.

## Env knobs

- `MGBA_HTTP_BASE_URL` (from `.env`) — emulator bridge.
- `AGENT_OS_MAX_STEPS` (default 400), `AGENT_OS_SETTLE_MS` (default 260),
  `AGENT_OS_TARGET` (default `VIRIDIAN_CITY`).

## Status / deferred

Implemented + unit-tested: state normalize, stuck score, failure classify,
knowledge routing, deterministic decisions, logging, evaluation. Battle policy
is an MVP (mash A) because party HP/move RAM is not read yet. Deferred:
party/move/type knowledge DBs, save-state automation, Critic agent. These are
the live-loop backlog once calibration confirms the corridor.
