# Pokemon Red Agent OS

A deterministic, structured-knowledge agent layer over the existing
`typescript-pokemon-harness`. It implements the design in
`POKEMONDEV_AGENT_OS.md`: RAM state is the truth source, game knowledge is
externalized into JSON, navigation/recovery are deterministic, and the LLM is
**not** in the movement path.
<!-- DOC-SYNC: 2026-08-04 확인 — `POKEMONDEV_AGENT_OS.md`는 이 저장소 어디에도 존재하지 않음(전체 리포 검색 확인, MISSING_SOURCE). `docs/AGENT_OS_TRACKER.md`의 스냅샷 헤더에 따르면 최초 작성 당시 다른 머신(m4-air)의 `~/Downloads/POKEMONDEV_AGENT_OS.md`를 가리켰던 외부 스펙 문서로, 이 클론에는 포함되어 있지 않다. 이 파일을 그대로 참고하려는 사람은 원본을 별도로 확보해야 하며, 리포 내 실제 구현 근거는 아래 "Source modules" 절과 `knowledge/*.json`이다. -->
<!-- DOC-SYNC: 2026-08-04 재확인 — `memory-map.ts`의 unwired 상태(line 37 주석)는 2026-08-04 기준 `grep -rn "memory-map" src/ tests/`로 재검증, 여전히 아무 곳에서도 import되지 않음(변동 없음). -->


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
- `pathfinder.ts` — A\* over an `OccupancyGrid`, with bump learning (failed move → tile blocked) and unwanted-warp learning (unintended map transition → origin tile blocked).
- `brain.ts` — deterministic Coordinator `decide()` → Navigation / Recovery / Battle / Dialog / Menu (§15.1).
- `io.ts` — runtime-state writer, step-log appender, `computeProgressScore` (§17), evaluation report renderer (§19).
- `os-runner.ts` — live loop (`runDeterministic`) + `runCalibration`.
- `scanner.ts` — flood-fill map scanner (`pnpm os:scan`) that reuses the `OccupancyGrid`/A* to discover walkable tiles and exits.
- `memory-map.ts` — RAM tilemap (`wTileMap`/`wCurMapTileset`) → per-tileset walkability mask builder for `OccupancyGrid`. <!-- DOC-SYNC: 2026-07-14 확인 — 구현은 존재하나 os-runner를 포함해 어디에서도 import되지 않는 미배선(unwired) 초안 모듈, 전용 테스트 없음. -->
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
- `AGENT_OS_MAX_STEPS` (default 400), `AGENT_OS_SETTLE_MS` (default 120),
  `AGENT_OS_TARGET` (default `VIRIDIAN_CITY`). <!-- DOC-SYNC: 2026-07-15 수정 — `src/agent-os/index.ts`의 `intArg("AGENT_OS_SETTLE_MS", 120)` 실측 기준 260→120 정정. -->

## Status / deferred

Implemented + unit-tested: state normalize, stuck score, failure classify,
knowledge routing, deterministic decisions, logging, evaluation. Battle policy
is an MVP (mash A) because party HP/move RAM is not read yet. Deferred:
party/move/type knowledge DBs, save-state automation, Critic agent. These are
the live-loop backlog once calibration confirms the corridor.
