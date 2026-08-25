<p align="center">
  <img src="./assets/banner.png" alt="Which harness is the best Pokémon trainer?" width="100%" />
</p>

# TypeScript Pokemon Harness

[![CI](https://github.com/nori00000/pokemon-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/nori00000/pokemon-agent-os/actions/workflows/ci.yml)
<!-- DOC-SYNC: 2026-07-16 추가 — `.github/workflows/ci.yml`(push/PR on main: typecheck + test)가 이 문서 어디에도 언급되지 않아 배지만 추가. CI는 `pnpm check`(lint)를 실행하지 않음 — 아래 Verification 절의 DOC-SYNC 주석 참고. -->

Autonomous Pokemon gameplay harness for an already-running mGBA instance. The
agent controls the emulator through `mGBA-http`, receives a fresh observed state
at the start of every turn, and records enough trace/metric data to compare
experiments without changing `@minpeter/pss-runtime`.

This branch is intentionally local-harness focused: Pokemon RAM reads, movement
supervision, stuck memory, milestone scoring, screenshot processing, and run
metrics all live here unless separate evidence proves a generic runtime need.

## 🧠 Deterministic Agent OS Layer

> **Hackathon submission.** A deterministic (no-LLM) control layer on top of this harness that drives Pokémon Red toward Viridian City. Principle: **RAM is the source of truth, knowledge is externalized to JSON, and movement/recovery are deterministic** (A\* over a learned occupancy grid) — instead of relying on an LLM to "remember" game state.

Code lives in [`src/agent-os/`](./src/agent-os) (`game-state`, `knowledge`, `brain`, `io`, `os-runner`, `pathfinder`, `scanner`, `memory-map`); knowledge graphs are in [`knowledge/`](./knowledge).

### Run the Agent OS

No API key is required — the Agent OS layer is fully deterministic.

```bash
pnpm install
pnpm test            # runs the suite

# With mGBA running, mGBASocketServer.lua loaded once (GUI: Tools -> Scripting),
# and mGBA-http up:
pnpm os:calibrate    # verify button -> delta(x,y) and collect real exit coordinates
pnpm os              # run the deterministic agent loop (emits an evaluation report)
pnpm os:scan         # flood-fill map scanner (discovers walkable tiles / exits)
```

Prerequisites are the same as the harness above (mGBA + `mGBA-http` + a legally
obtained ROM already loaded in mGBA). Load the Lua bridge **once** per mGBA window —
double-loading freezes the bridge.

### How it works

1. `game-state.ts` — normalizes RAM into a small `GameState` plus a weighted `stuck_score` and failure classification.
2. `knowledge.ts` — loads `spatial_graph` / `mission_graph` / `failure_dex` JSON and runs BFS map routing.
3. `pathfinder.ts` — A\* over an `OccupancyGrid` with **bump learning** (failed move -> tile blocked) and **unwanted-warp learning** (unintended map transition -> origin tile blocked).
4. `brain.ts` — deterministic coordinator `decide()` routing to Navigation / Recovery / Battle / Dialog / Menu (no LLM in the loop).
5. `io.ts` — runtime state, step log (`agent_steps.jsonl`), `progress_score`, and a per-run evaluation report.
6. `memory-map.ts` — reads the on-screen RAM tilemap (`wTileMap`/`wCurMapTileset`) into a per-tileset walkability mask for `OccupancyGrid`. <!-- DOC-SYNC: 2026-07-14 확인 — 코드는 존재하고 typecheck/build/lint을 통과하지만, `src/agent-os/os-runner.ts`를 포함해 어디에서도 import되지 않고 전용 유닛 테스트도 없음(grep 확인). 배선되지 않은 초안(draft) 모듈로 취급할 것. -->
7. `os-runner.ts` — live loop (`runDeterministic`, driven by `pnpm os`) plus `runCalibration` (`pnpm os:calibrate`); wires `game-state`/`knowledge`/`pathfinder`/`brain`/`io` together.
8. `scanner.ts` — flood-fill map scanner (`pnpm os:scan`) that reuses the `OccupancyGrid`/A\* to discover walkable tiles and exits. <!-- DOC-SYNC: 2026-08-09 추가 — 위 모듈 인벤토리(23행)와 `src/agent-os/README.md`에는 있었지만 이 "How it works" 번호 목록에는 `os-runner.ts`/`scanner.ts`가 빠져 있었음(UNDOCUMENTED, LOW). 소스 확인 후 추가. -->

### How to evaluate

Reproduce the build/test guardrails locally:

```bash
pnpm typecheck   # tsc --noEmit (+ web)
pnpm build       # tsc -p tsconfig.json
pnpm test        # vitest run
npx ultracite check src/agent-os   # lint the Agent OS sources
```

Last verified on this branch (2026-06-06): `pnpm typecheck` and `pnpm build` exit 0,
and `pnpm test` reports **133 passing across 20 test files**, and the Agent OS sources are lint-clean (`npx ultracite check src/agent-os`). Re-run the commands above
to confirm.

Runtime scoring uses `progress_score = mission_index×100 + map_transitions×10 +
unique_coords×0.1 − stuck×5 − recovery_fail×10`, written to an evaluation report on
every `pnpm os` run.

### What the tests validate

The deterministic layer is covered by `tests/agent-os/agent-os.test.ts` (20 cases),
part of the full **133-test** suite (20 files). The agent-os cases assert:

- **Knowledge graph** — loads the real spatial graph, routes Pallet Town → Viridian City, resolves the first-hop exit toward a target, axis-priority direction, mission selection by live map, and failure-dex recovery sequences.
- **Game state + stuck score** — RAM → battle-mode normalization, stuck-score thresholds (idle vs pinned-in-place), and menu-loop classification.
- **Brain decisions** — A-mash in battle, B to close a menu, navigation toward the Route 1 exit, and lateral recovery when wall-looped.
- **Pathfinder A\*** — steps toward an unobstructed target, routes around a blocked tile, and returns null when already at the target.
- **I/O rendering** — `progress_score` computed per the spec weights, snake_case step-log keys, and the evaluation-report headline metrics.

### Development log

The full live-run development journey — early-game navigation, the Oak story-gate, and
battle handling, with the RAM addresses used at each step — is tracked in
[issue #14 (Agent OS Tracker)](../../issues/14) and milestone issues
[#7–#13](../../issues). These are an in-progress engineering log, not final benchmark
results.

## Requirements

- Node.js 20 or newer
- pnpm 11.2.2
- mGBA with the `mGBASocketServer.lua` script
- `mGBA-http`
- A legally obtained Game Boy ROM already loaded in mGBA

Install dependencies:

```bash
pnpm install
```

Copy `.env.example` to `.env` and configure the local emulator and model:

```bash
MGBA_HTTP_BASE_URL=http://127.0.0.1:5000
AI_BASE_URL=https://codex.nekos.me/v1
AI_API_KEY=
AI_MODEL=gpt-5.5
METRICS_HTTP_HOST=0.0.0.0
METRICS_HTTP_PORT=9464
```

<!-- DOC-SYNC: 2026-08-05 추가 — `src/env.ts`의 `STRATEGY_PROMPT_FILE`(optional)이 위 예시·`.env.example`에는 없지만 `src/index.ts`/`src/episode-main.ts` 둘 다에서 실제로 읽는다(UNDOCUMENTED, LOW — 미설정 시 기본 지시문과 100% 동일하게 동작해 안전하지만 이 섹션 어디에도 이름이 없었음). 설정 시 해당 경로의 파일 내용을 기본 지시문 뒤에 덧붙인다. 자세한 사용례(다중 인스턴스 전략 주입)는 `multi/README.md` §"동작 원리" 참고. -->
Optional: set `STRATEGY_PROMPT_FILE=/path/to/strategy.md` to append extra
instructions to the base prompt; unset behaves identically to the base prompt.

Start mGBA and `mGBA-http` separately, then run the harness:

```bash
mgba --script .local-tools/mgba-http/mGBASocketServer.lua /absolute/path/to/legal/rom.gb
.local-tools/mgba-http/mGBA-http
pnpm dev
```

The harness expects one live emulator server. Do not start a second mGBA or
`mGBA-http` process for a live experiment; the current emulator state is the
state being measured.

## Runtime Loop

`src/index.ts` creates a persistent `pokemon-run` session and loops forever.
Each turn:

1. Captures mGBA status, screenshot, and Pokemon RAM state when available.
2. Crops Game Boy screenshots to 160x144 and overlays red 16x16 movement guide
   lines for navigation.
3. Injects the observed state, screenshot, recent actions, and stuck-memory
   hints into the model input.
4. Asks the model to emit one `<action_plan>...</action_plan>` block and execute
   exactly one useful game action.
5. Streams runtime events into pretty logs, token traces, behavior metrics, and
   Prometheus output.

There is no CLI prompt, `--loop` flag, max-turn stop condition, or completion
marker. Stop the process with `Ctrl-C` when the experiment window ends.

## Episode Runner (Evaluation Harness)

<!-- DOC-SYNC: 2026-07-14 추가 — package.json의 `pnpm episode`(`src/episode-main.ts`)가 이전까지 루트 README 어디에도 문서화되어 있지 않았음(구 문서 3종은 dangling reference로 이미 docs/archive/로 이동됨). 아래는 소스 코드 실측 기반 최소 설명. -->

Unlike the open-ended `pnpm dev` loop above, `pnpm episode` (`src/episode-main.ts`)
runs a bounded, evaluated episode: `EpisodeRunner` (`src/evaluation/episode-runner.ts`)
drives the same mGBA control plane through `InputGate`/`SessionState`/`Supervisor`
(`src/session/`) and `CommandExecutor` (`src/executor/command-executor.ts`, executes
only the first queued `GameCommand` per step and reports the rest as `ignored`),
stops on a hard failure, max-steps limit, or reaching Viridian
City (`mapId === 1`), and prints a JSON result plus JSONL evidence via
`EvidenceRecorder`. Config comes from `src/evaluation/run-config.ts`
(`normalizeEpisodeRunConfig`). Each step's before/after state is classified by
`src/session/transition-detector.ts` (`detectTransition`: `map` / `mode` /
`movement` / `none`) and scored by `src/evaluation/reward.ts`
(`calculateTransitionReward`, returns a `RewardBreakdown` with per-category
components and a `reward_total`); the breakdown is appended to a `reward_logs`
JSONL evidence stream via `EvidenceRecorder`. This path is covered by
`tests/episode-runner.test.ts`.
<!-- DOC-SYNC: 2026-07-27 추가 — `src/executor/command-executor.ts`(`CommandExecutor`)가 episode 경로에서 실제로 per-step 실행을 맡지만(episode-main.ts에서 `new CommandExecutor(inputGate)`) 이 절 어디에도 이름이 없었음(UNDOCUMENTED, LOW). 소스 확인: `executeOne()`은 큐의 첫 `GameCommand`만 실행하고 나머지는 `ignored`로 반환. `pnpm dev` 루프의 "한 턴 한 액션" 강제(`src/agent/command-agent-runner.ts`, 이벤트 스트림 필터링)와는 별개의 독립 메커니즘 — 혼동 방지를 위해 구분 명시. -->
<!-- DOC-SYNC: 2026-07-20 수정 — 위 3문장은 `EpisodeRunner` 클래스 자체의 능력(생성자가 `isSuccess`/`isHardFailure` 콜백을 모두 받고, 둘 다 기본값은 `() => false`)을 정확히 서술하지만, 실제 `pnpm episode` 진입점인 `src/episode-main.ts`의 `createProductionEpisodeRunner()`(line 92-106)는 `isSuccess: isViridianCitySuccess`(`transition.to?.mapId === 1`)만 넘기고 **`isHardFailure`는 넘기지 않는다** — 즉 production 실행은 기본값(`() => false`)이 그대로 적용되어 "hard failure" 정지 조건이 배선되지 않았다(`src/evaluation/episode-runner.ts` line 109 기본값 확인). `tests/episode-runner.test.ts:266`은 `isHardFailure`를 넘기는 예를 보여주지만 이는 클래스 단위 테스트일 뿐, production 배선을 검증하지 않는다. 따라서 현재 `pnpm episode`는 실제로 **성공(Viridian 도달) 또는 max-steps(기본 2000, `EPISODE_MAX_STEPS`)로만 멈추고, hard-failure로는 멈추지 않는다**. -->

## Control Plane

The model can use these tools:

- `mgba_tap`
- `mgba_tap_many`
- `mgba_hold`
- `mgba_hold_many`
- `mgba_release`

ROM loading and reset tools are intentionally not exposed. The underlying client
still has helpers for mGBA endpoints, but model-facing tools must not reset,
reload, or restart game progress.

The local supervisor wraps control calls before they reach mGBA. It normalizes
directional movement to one tile, normalizes non-directional taps, rejects unsafe
directional multi-holds, waits for post-action settle frames, and polls through
short black/loading frames before the next observation.

<!-- DOC-SYNC: 2026-07-19 추가 — 도구 자체는 `src/tools/` (`tap.ts`/`hold.ts`/`release.ts`)에 구현되어 있고, 위 어디에도 파일 경로가 없었음(다른 섹션들은 소스 경로를 명시하는 스타일). `src/agent/mode-gated-tool-factory.ts`가 세션 모드별로 노출 도구를 게이팅하고, `src/agent/command-agent-runner.ts`가 턴당 하나의 게임 액션만 통과시킨다(둘 다 소스 확인). -->
Implementation: `src/tools/` (tool factories), `src/agent/mode-gated-tool-factory.ts`
(mode-based tool gating), `src/agent/command-agent-runner.ts` (enforces one game
action per turn).

<!-- DOC-SYNC: 2026-08-14 추가 — 바로 위 "local supervisor" 문단(정규화/settle-frame 대기/black-frame 폴링)이 서술하는 구현체 자체(`src/supervisor.ts`: `DIRECTIONAL_HOLD_DURATION`, `POST_ACTION_SETTLE_FRAMES`, `BLACK_FRAME_MAX_POLLS`, `waitThroughBlackFrames`)와 이를 `pnpm dev` 루프에 배선하는 `src/runner.ts`(`streamSupervisedRun`, `src/index.ts`가 import)가 이 문서 어디에도 파일 경로로 언급되어 있지 않았음(UNDOCUMENTED, LOW — 개념은 이미 서술돼 있고 코드도 정상 동작, 경로 인용만 누락). 소스 확인: `src/supervisor.ts`는 `src/runner.ts`/`src/index.ts`/`src/episode-main.ts`/`src/tools/*`/`src/evaluation/episode-runner.ts`/`src/session/input-gate.ts` 등 8개 파일에서 import되는 핵심 공유 모듈. -->
Implementation: `src/supervisor.ts` (normalization, settle-frame wait, black-frame
poll) and `src/runner.ts` (`streamSupervisedRun`, wired into the `pnpm dev` loop via
`src/index.ts`).

## Observation And Progress Signals

The harness combines visual and state signals:

- `src/screenshot-image.ts` decodes PNG screenshots, crops mGBA Game Boy frames,
  draws the movement grid, and detects black/loading frames.
- `src/pokemon-state.ts` reads compact Pokemon Red RAM fields such as map,
  position, facing direction, and battle state. If RAM reads fail, the run falls
  back to visual-only observation.
- `src/stuck-memory.ts` records repeated failed movement edges and recent
  recovery attempts so the prompt can avoid blind repetition.
- `src/pokemon-milestones.ts` scores coarse progress milestones such as player
  control reached, first map transition, and battle detected/completed.
- `src/game/map-memory.ts` — a `MapMemory` class that records per-map tile kinds
  (`blocked`/`door`/`grass`/`npc`/`unknown`/`walkable`/`warp`/`water`) and builds a
  `walkabilityGrid()`. <!-- DOC-SYNC: 2026-07-17 추가 — 이 클래스는 `tests/map-memory.test.ts` 외 어디에서도 import되지 않음(grep 확인). `src/agent-os/memory-map.ts`(위 Agent OS 절, 이미 unwired로 표시됨)와는 별개의, 이것도 배선되지 않은 초안 모듈. 두 모듈 다 os-runner에 연결되지 않은 상태. -->

The current RAM map is Pokemon Red oriented. Do not interpret those state fields
as authoritative for another ROM unless separate validation proves they match.

## Metrics And Traces

Each run creates a trace directory under `.pss-mgba/traces/runs/<run-id>/` and
appends an iteration record to `.pss-mgba/traces/iterations.jsonl`.

Important outputs:

- `run.json`: run metadata, mode, experiment id, milestone, stuck count, and
  supervisor count.
- `events.jsonl`: structured viewer event log with observation screenshots and
  status, `action_plan` summaries, action tool calls and results, and supervisor
  interventions.
- `token-usage.jsonl`: per-step and per-turn token usage.
- Prometheus endpoint: `http://127.0.0.1:9464/metrics` by default.
- `pnpm trace:report`: local comparison report across recorded iterations.

Behavior metrics include action entropy, A-button ratio, same-action streaks,
visual novelty, observe-before-act ratio, tool error rate, turn/step/tool
durations, stuck events, and supervisor interventions. Token savings only count
as improvement when progress, stuck behavior, action diversity, and tool
reliability do not regress.

## Trace Viewer

New runs write `events.jsonl` automatically. Build the React viewer with
`pnpm web:build`, then serve the built viewer and local API with `pnpm viewer`.
The default viewer URL is `http://127.0.0.1:9474`.

During UI development, run `pnpm viewer` for the local API and `pnpm web:dev`
for Vite. Vite proxies `/api` requests to the viewer server. Older runs without
`events.jsonl` still show metadata and token metrics, but they do not have
screenshots or an action timeline. No deployment or API keys are required, and
the server is local-only by default.

## Grafana

Start the local observability stack:

```bash
docker compose -f docker-compose.grafana.yml up -d
```

Then run the harness normally:

```bash
pnpm dev
```

Prometheus scrapes the harness through `host.docker.internal:9464`, and Grafana
provisions the `pss-mgba Run Iterations` dashboard at
`http://127.0.0.1:3000`. Keep the stack running during experiments so each new
`run_id` and iteration remains visible as a separate time series.

## Verification

Run the full guardrail before accepting changes or experiment evidence:

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm check
```

<!-- DOC-SYNC: STALE — `pnpm check`(ultracite/biome)는 lint 부채로 실패한다: 이 저장소 `.gitignore`가 `.omc/`를 누락해 OMC 세션 상태 파일이 작업 디렉터리에 있으면 biome 스캔에 포함되기 때문(포함 시 34건, `.omc/` 격리 시 코드베이스 고유 부채는 26건·92 files·12파일 — useAwait·noUselessUndefined·noNestedTernary·noUnusedImports·useTopLevelRegex·organizeImports). `.github/workflows/ci.yml`은 `pnpm check`를 실행하지 않으므로 CI green과 무관. 자동수정(`pnpm fix`)·`.gitignore`에 `.omc/` 추가는 doc-sync 범위 밖(사용자 판단) (최초 2026-08-12, 최종확인 2026-08-25) -->

Useful focused commands while iterating:

```bash
pnpm test -- tests/mgba-http.test.ts tests/runner.test.ts tests/observation.test.ts
pnpm test -- tests/screenshot-image.test.ts tests/run-metrics.test.ts tests/metrics-server.test.ts
pnpm test -- tests/viewer-events.test.ts tests/viewer-server.test.ts
pnpm web:typecheck
pnpm web:build
pnpm web:preview
pnpm trace:report
pnpm check:session-authority
pnpm fix
```

<!-- DOC-SYNC: 2026-08-05 추가 — `pnpm web:preview`(`vite preview`)와 `pnpm fix`(`ultracite fix`, 위 34건 오류 중 일부의 FIXABLE 표시분을 자동수정)가 package.json에는 있었지만 이 문서 어디에도 없었음(UNDOCUMENTED, LOW). `pnpm fix`를 실행하면 lint 상태가 바뀌므로 위 34건 재확인 주석과 어긋나지 않도록 doc-sync 범위에서는 실행하지 않고 명령만 추가. -->

<!-- DOC-SYNC: 2026-07-15 추가 — `pnpm check:session-authority` (`scripts/check-session-authority.ts`)가 package.json에는 있었지만 이 문서 어디에도 없었음. tap/hold/clear 등 저수준 입력 호출과 모드-게이팅 권한(`ModeGatedToolFactory`/`isToolAllowedForMode`), readiness-polling 내부 상태를 지정된 파일 목록 밖에서 쓰면 실패하는 아키텍처 가드레일. 현재 통과 확인됨(`session authority check passed`). -->

Connectivity probe before a live run:

```bash
python3 - <<'PY'
import urllib.request
for path in ['/core/currentframe','/core/getgamecode','/core/getgametitle','/mgba-http/button/getall']:
    with urllib.request.urlopen('http://127.0.0.1:5000'+path, timeout=2) as response:
        print(path, response.status, response.read(200).decode('utf-8','replace'))
PY
```

Five-minute experiment window:

```bash
MGBA_HTTP_BASE_URL=http://127.0.0.1:5000 pnpm dev > .omo/evidence/<task>-pnpm-dev.log 2>&1 & PID=$!; sleep 300; kill -INT $PID; wait $PID || true
```

Valid run modes are `fresh`, `resumed`, `recovery`, `deterministic-replay`, and
`exploratory`. Use `fresh` only for a normal run from the current live emulator
state. Recovery and deterministic replay metrics must not be mixed with fresh
progress metrics.

## Evidence Caveats

Keep evidence tied to run id and ROM identity.

- Baseline Task 1 run `00058-2026-05-24T06-19-02-489Z` used Pokemon Red identity
  `DMG-AR` / `PKMN RED ST`, with 29 summarized turns, `1,189,899` total tokens,
  and `41,031.0` average tokens per turn.
- Combined Task 8 run `00064-2026-05-24T07-51-35-549Z` was metadata-valid with
  `mode=fresh`, `experimentId=combined-optimized`, 20 summarized turns,
  `607,453` total tokens, `30,372.7` average tokens per turn, `stuckEvents=0`,
  `supervisorInterventions=24`, and milestone `player-control-reached`.
- Do not claim this proves a clean Pokemon Red gameplay improvement: Task 8 used
  Pokemon Gold identity `DMG-AAUE` / `POKEMON_GLD`, not the baseline Pokemon Red
  identity.

Reject or roll back an improvement when token usage improves but progress,
stuck behavior, action entropy, tool reliability, or ROM identity gets worse.

## Runtime Boundary

Task 9 recorded `NO_RUNTIME_CHANGE` in `.omo/evidence/task-9-runtime-gate.md`.
That remains the default boundary: do not move harness-specific behavior into
`@minpeter/pss-runtime` without separate cross-harness evidence.

Exception: PR 39 updates this harness to published `@minpeter/pss-runtime@0.0.8`
to use the released `toolChoice` and `session.steer(...)` APIs. The implementation
stays local to this repository: the runtime package source is not modified, and
after-step screenshots are steered into the active session before the next model
step.

Only move work into `@minpeter/pss-runtime` after multiple runs prove the same
need outside this Pokemon/mGBA harness and the evidence names the affected
runtime loop, session, event, budget, metric, store, or replay contract.
