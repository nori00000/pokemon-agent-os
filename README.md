# TypeScript Pokemon Harness

Autonomous Pokemon gameplay harness for an already-running mGBA instance. The
agent controls the emulator through `mGBA-http`, receives a fresh observed state
at the start of every turn, and records enough trace/metric data to compare
experiments without changing `@minpeter/pss-runtime`.

This branch is intentionally local-harness focused: Pokemon RAM reads, movement
supervision, stuck memory, milestone scoring, screenshot processing, and run
metrics all live here unless separate evidence proves a generic runtime need.

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
AI_REASONING=medium
METRICS_HTTP_HOST=0.0.0.0
METRICS_HTTP_PORT=9464
```

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

### Turn-Step Trace

현재 harness 흐름을 Turn-Step Trace 표기법으로 보면 `session.send(...)`는 새
turn을 시작하고, `afterStep`의 `session.steer(...)`는 같은 turn 안의 다음
step으로 이어지는 `runtime input @ step-end`를 추가한다.

EVENT STREAM

turn 1
  user message: "관찰된 mGBA 상태로 포켓몬 진행 계속"

  runtime input @ turn-start
    - `createObservedTurnInput(...)`이 현재 mGBA status, Pokemon RAM state,
      grid-overlay screenshot, recent actions, stuck-memory hints를 주입

  step 1
    runtime input @ step-start
      - 이 step 전용 추가 입력 없음

    <-- llm call #1

    assistant action:
      <action_plan>...</action_plan>
      `mgba_*` control tool call

    tool/result/event:
      mGBA control result와 supervisor settle/black-frame polling 결과

    runtime input @ step-end
      - `afterStep`이 `result === "continue"`일 때 새 mGBA observation을 캡처
      - `session.steer(createObservedInput(...))`로 새 screenshot/status/state를
        active session에 추가

  step 2
    runtime input @ step-start
      - step 1의 tool result와 step-end에 steered 된 fresh observation

    <-- llm call #2

    assistant action:
      다음 control tool call 또는 짧은 progress summary

    runtime input @ step-end
      - tool call이 있으면 다시 fresh observation을 steer
      - tool call 없이 완료되면 turn 종료 가능

  runtime input @ turn-end
    - token usage, run metrics, trace metadata가 저장됨

MODEL HISTORY

<-- llm call #1 sees:
  system:
    `instructions`와 mGBA control-plane 설명
  user:
    turn-start observation text
    현재 screenshot image part
  runtime:
    runtime state 자체는 숨겨져 있고, model에는 user-role observation으로만 보임

<-- llm call #2 sees:
  system:
    `instructions`와 mGBA control-plane 설명
  user:
    최초 turn-start observation
  assistant:
    step 1의 `<action_plan>`과 tool call
  tool:
    step 1의 tool result
  runtime:
    `runtime-input @ step-end`가 model history에는 user-role message로 들어감
    내용은 fresh mGBA observation text와 screenshot image part

이 표기에서 중요한 점은 EVENT STREAM의 `runtime-input`이 그대로 MODEL
HISTORY의 별도 role이 되지는 않는다는 것이다. Runtime은 이 입력을 이벤트로
노출하지만, 다음 LLM snapshot에는 user-role model message로 매핑한다. 그래서
`toolChoice`는 첫 결정에는 `required`, tool result 뒤 또는 tool result 뒤에
steered user observation이 붙은 경우에는 `auto`를 사용해 turn이 끝날 수 있게
한다.

## Control Plane

The model can use these tools:

- `mgba_status`
- `mgba_screenshot`
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

Useful focused commands while iterating:

```bash
pnpm test -- tests/mgba-http.test.ts tests/runner.test.ts tests/observation.test.ts
pnpm test -- tests/screenshot-image.test.ts tests/run-metrics.test.ts tests/metrics-server.test.ts
pnpm test -- tests/viewer-events.test.ts tests/viewer-server.test.ts
pnpm web:typecheck
pnpm web:build
pnpm trace:report
```

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
