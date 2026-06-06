# Pokemon Red Agent OS

> Build a **Pokemon Red Agent OS**, not a simple LLM player.
> 포켓몬 레드를 LLM이 "기억"하게 만들지 말고, 고정된 세계를 **구조화된 지식**으로
> 외부화하고, 현재 상태는 **RAM에서 읽고**, 이동·전투·대화·복구는 **전용 모듈**로 처리한다.

A deterministic, structured-knowledge agent layer that drives **Pokémon Red** inside
mGBA. It sits on top of the [`minpeter/pss-mgba`](https://github.com/minpeter/pss-mgba)
harness (mGBA-HTTP bridge + RAM reads) and replaces free-form LLM control with
**deterministic navigation, a weighted stuck-score, and a structured recovery
policy** — so movement and recovery never burn an LLM call.

## Core thesis

Pokémon Red is not primarily a *memory* problem. It is a **state-representation,
world-model, planning, recovery, and evaluation** problem. Therefore:

- **RAM is the truth source** (map id, x/y, battle/dialog/menu, party).
- **Game knowledge is externalized** to JSON (`spatial_graph`, `mission_graph`, `failure_dex`).
- **Navigation is deterministic** (BFS over map exits + axis-stepping to triggers).
- **Stuck detection is confidence-based** (a weighted score, not a binary flag).
- **Recovery is a first-class planner** (failure type → ordered recovery primitives).
- The **LLM is used only** for ambiguity, critique, and strategy — never for routine movement.

## Architecture

```
mGBA / Pokémon Red ROM
  ↓ (RAM reads + button input via mGBA-HTTP)
RAM State Reader → GameState Normalizer
  ↓
Knowledge (spatial / mission / failure)  +  Memory (runtime_state)  +  Logs (agent_steps.jsonl)
  ↓
Coordinator → Navigation | Battle | Dialog | Menu | Recovery   (deterministic decide())
  ↓
Action Executor → Evidence Logger → Evaluation Report
```

## Modules (`src/`)

| File | Role |
| --- | --- |
| `game-state.ts` | RAM observation → `GameState`; weighted `computeStuckScore`; `classifyFailure` |
| `knowledge.ts` | JSON loaders + pure graph ops: `findMapRoute` (BFS), `nextExitToward`, `directionToTarget`, `selectMission` |
| `brain.ts` | deterministic Coordinator `decide()` → Navigation / Recovery / Battle / Dialog / Menu |
| `io.ts` | runtime-state writer, `agent_steps.jsonl` logger, `computeProgressScore`, evaluation report |
| `os-runner.ts` | live loop `runDeterministic` + `runCalibration` |
| `index.ts` | CLI entry (`os` / `os:calibrate`) |

> Note: this layer depends on the `pss-mgba` harness for the mGBA-HTTP client and RAM
> reader; the files here are the Agent-OS layer as reference, plus the design/tracking docs.

## Reinforcement-learning loop (RL loop)

Not gradient RL — an **episodic policy-iteration + structured-memory** loop:

- **Environment**: mGBA Pokémon Red (RAM = observation, 8 buttons = action).
- **Reward / return**: `progress_score = mission_index×100 + map_transitions×10 + unique_coords×0.1 − stuck×5 − recovery_fail×10`.
- **Policy**: ① deterministic `brain.decide()` ② LLM strategies (speedrun / explore / cautious).
- **Loop**: rollout episodes (parallel instances) → evaluate (progress, time-to-Viridian, dominant failure) → diagnose (stuck-score + failure-dex localize *why*) → update knowledge/policy → repeat.

See [`docs/AGENT_OS_TRACKER.md`](docs/AGENT_OS_TRACKER.md) for live progress, data, blockers, TODO, and next actions.

## Status

- ✅ **Phase 0 complete** — foundation built; `typecheck` + **115 tests** + `build` + `lint` all pass.
- ✅ Live mGBA chain reachable; map ids confirmed (`PALLET_TOWN=0`, `REDS_HOUSE_2F=38`).
- 🔴 **Blocker**: live input-bridge — mGBA-HTTP accepts buttons but they aren't applied to
  the game core (game stuck at the Oak intro); mGBA 0.10.5 has no `--script`, so the Lua
  input bridge must be loaded via the GUI. Tracked in the issue.

First target: **reach Viridian City reliably** (Pallet Town → Route 1 → Viridian City).

## Constraints

- Use a **local, legally-obtained ROM only**. No ROMs are downloaded or distributed.
- One live emulator instance per run (see `multi/` for isolated parallel instances).

---
🤖 Built with Claude Code.
