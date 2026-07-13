# Grokemon Integration Upgrade for PokemonDev Agent OS

작성 목적: `INONONO66/grokemon` 저장소를 코드/문서 수준에서 분석해, 기존 PokemonDev Agent OS 설계를 더 실행 가능하고 안전한 구조로 보강한다.

핵심 결론:
`grokemon`의 본질은 “LLM이 포켓몬을 플레이한다”가 아니라, **LLM이 제한된 도구를 통해 한 턴에 하나의 안전한 명령만 제안하고, 하네스가 입력 안정화·모드 판정·전이 검증·증거 기록·복구 힌트를 담당하는 구조**다.

---

## 1. 기존 답변의 부족한 점

이전 답변은 grokemon README를 기반으로 큰 방향은 잡았지만 다음이 부족했다.

1. `session authority` 개념을 충분히 반영하지 못했다.
2. `InputGate`가 단순 대기 장치가 아니라 **입력 트랜잭션 관리자**라는 점을 덜 강조했다.
3. `TransitionDetector`를 reward/stuck/recovery의 핵심 입력으로 끌어오지 못했다.
4. `mode-gated tools`를 정책 수준이 아니라 코드 계약 수준으로 강제해야 한다는 점이 약했다.
5. `MapMemory`의 walkability grid, unknown-as-walkable, collision learning, NPC replanning을 충분히 반영하지 못했다.
6. `session state`와 raw domain evidence가 충돌할 때, 어느 쪽이 권위인지 명시하지 못했다.
7. `check:session-authority` 같은 안전성 검사를 우리 Runbook의 Definition of Done에 넣지 못했다.

---

## 2. Grokemon에서 반드시 가져올 구조

## 2.1 CommandAgentRunner 중심 구조

README에 따르면 grokemon의 흐름은 다음이다.

```text
Grok
↓
OpenAI-compatible chat model
↓
CommandAgentRunner
↓
session observation + mode-filtered tools
↓
CommandExecutor
↓
InputGate-settled button presses
↓
mGBA-http
↓
RAM, screenshots, frames
↓
Pokemon Red
```

우리 프로젝트도 너무 많은 agent를 MVP에 만들기보다, 먼저 아래 7개 컴포넌트로 축소해야 한다.

```text
CommandAgentRunner
ObservationBuilder
ModeGatedToolFactory
CommandExecutor
InputGate
Supervisor
EvidenceRecorder
```

확장 모듈:

```text
NavigationPolicy
BattlePolicy
DialogPolicy
RecoveryPolicy
PRSteeringAgent
```

---

## 2.2 One Game Action Per Turn

grokemon은 한 턴에서 첫 game-action tool 결과 후 runner가 interrupt한다.

우리 계약:

```text
LLM은 한 턴에 하나의 game action만 제안할 수 있다.
여러 tool call을 생성하더라도 첫 valid game-action 이후 나머지는 무시하거나 다음 턴으로 넘긴다.
```

이유:

- runaway command 방지
- 원인-결과 추적 가능
- reward attribution 가능
- failure evidence가 명확해짐

---

## 2.3 Mode-gated Tools

grokemon의 `resolveTools()` 구조는 모드별로 도구 표면을 제한한다.

예시:

```text
battle:
  memory + wait + battle tools

dialog / naming:
  memory + dialog tools

menu / overworld / title:
  memory + wait + overworld tools
```

우리도 아래 계약을 둔다.

```text
battle mode:
  navigation tool 금지

dialog mode:
  navigation tool 금지
  battle tool 금지

overworld mode:
  battle tool 금지
  dialog tool 금지

menu mode:
  기본적으로 close_menu / wait / memory만 노출
```

중요:
이건 prompt rule이 아니라 code-level gating이어야 한다.

---

## 2.4 InputGate는 필수다

grokemon의 InputGate는 단순 `sleep`이 아니다.

역할:

```text
1. 입력 전 mini-state 읽기
2. 현재 상태에서 해당 버튼이 허용되는지 검증
3. 버튼 입력
4. 입력 이후 settle될 때까지 polling
5. before/after state transition 검출
6. input result 기록
```

우리 구현 계약:

```ts
type InputResult = {
  before: MiniState;
  after: MiniState;
  executed: boolean;
  intent: InputIntent;
  reason?: string;
  transition: StateTransition;
}
```

입력 거부 사유:

```text
walk-animation
joy-ignore
text-window
mode-mismatch
tool-not-allowed
```

---

## 2.5 TransitionDetector를 reward와 failure의 핵심으로 사용

grokemon의 transition detector는 최소 4개 전이를 구분한다.

```text
mode transition
map transition
movement transition
none
```

우리 강화학습 로그도 이걸 중심으로 재구성한다.

```json
{
  "before": {"mode": "overworld", "mapId": 1, "x": 5, "y": 7},
  "action": "UP",
  "after": {"mode": "overworld", "mapId": 1, "x": 5, "y": 6},
  "transition": {
    "kind": "movement",
    "from": {"x": 5, "y": 7},
    "to": {"x": 5, "y": 6}
  },
  "reward": 0.4
}
```

Reward는 action 자체가 아니라 transition kind에 강하게 연결한다.

```text
movement toward target → positive
map transition toward goal → high positive
mode transition into battle unexpectedly → conditional negative/neutral
none transition after movement action → possible wall / spam evidence
```

---

## 2.6 SessionState Authority

grokemon의 `SessionState` 타입 주석은 매우 중요하다.

핵심:

```text
SessionState.mode is authoritative for tools, observations, executors, supervisor decisions, and command routing.
Raw domain readers may provide evidence, but disagreement is diagnostic data and must not become a competing downstream authority.
```

우리 말로:

> 도구 노출, 관찰 생성, executor, supervisor, command routing의 기준은 하나의 authoritative session mode여야 한다. RAM reader나 screenshot detector가 다른 mode를 암시하면 그것은 대체 권위가 아니라 diagnostic event다.

따라서 우리도 `session_state.json`을 둔다.

```json
{
  "mode": "overworld",
  "phase": "synced",
  "mini_state": {},
  "events": [
    {
      "kind": "mode-mismatch",
      "evidence_source": "screenshot_detector",
      "evidence_mode": "dialog",
      "authoritative_mode": "overworld"
    }
  ]
}
```

---

## 3. Session Authority Guard를 우리 프로젝트에 추가

grokemon은 `scripts/check-session-authority.ts`로 다음 책임을 allowlist 기반으로 검사한다.

검사 대상:

```text
low-level-input
readiness-polling
duplicate-refresh-state
auto-loop-authority
agent-controller-bypass
tool-gating-authority
```

우리도 유사한 guard를 만든다.

파일:

```text
scripts/check-session-authority.ts
```

또는 Python 기반이면:

```text
scripts/check_session_authority.py
```

## 3.1 우리 allowlist 설계

### low-level-input

버튼 입력을 직접 실행할 수 있는 파일:

```text
src/session/input_gate.ts
src/mgba/mgba_http_client.ts
src/cli/manual_press.ts
```

그 외 파일에서 `pressButton`, `tapButton`, `holdButton` 직접 호출 금지.

### readiness-polling

`joyIgnore`, `walkCounter`, `windowY`를 직접 polling할 수 있는 파일:

```text
src/session/input_gate.ts
src/state/mini_state_reader.ts
src/game/memory_map.ts
```

### tool-gating-authority

모드별 tool 노출을 결정할 수 있는 파일:

```text
src/template/tools.ts
src/agent/mode_gated_tool_factory.ts
```

### auto-loop-authority

대화/전투 narration 자동 진행을 할 수 있는 파일:

```text
src/session/auto_handler.ts
src/executor/dialog_executor.ts
src/executor/battle_executor.ts
```

### duplicate-refresh-state

전체 state refresh를 직접 부를 수 있는 파일:

```text
src/agent/command_agent_runner.ts
src/session/game_session.ts
```

---

## 4. MapMemory / Walkability를 더 구체화

grokemon의 Game Layer 문서에서 MapMemory는 다음을 한다.

```text
20x18 screen tilemap을 읽음
2x2 tile block을 분류
map별 record에 "y,x" key로 저장
walkabilityGrid() 생성
known walkable/grass → true
known wall → false
door/warp → true
water → false
unknown → true
NPC occupied → false
```

우리 프로젝트에도 이 구조를 그대로 가져온다.

파일:

```text
src/game/map_memory.ts
src/game/map_memory_store.ts
src/game/tileset_data.ts
knowledge/map_masks.json
```

중요한 정책:

```text
unknown tiles are treated as walkable
actual walls are learned on collision
NPC occupied tiles are temporary blocked
door/warp wall tiles are passable
```

이 정책은 “지도 전체를 완벽히 알 때까지 기다리는 것”보다 훨씬 실행 가능하다.

---

## 5. Navigation 개선: A* + edge transition + warp handling

grokemon executor 문서에서 navigation은 다음 특징을 가진다.

```text
A* on boolean grid from MapMemory.walkabilityGrid()
unknown unexplored tiles treated as walkable
actual walls learned on collision
door/warp wall tiles treated as walkable
warp goal이면 adjacent tile로 pathfind 후 push into goal
outdoor map connection이면 edge tile에서 한 칸 더 걸어 map transition 유도
random-walking NPC가 막으면 wait → sprite refresh → replan 최대 3회
```

우리 Runbook의 NavigationAgent는 이 수준까지 올라가야 한다.

MVP 순서:

1. 현재 map의 walkability grid 생성
2. target coordinate 설정
3. A* path 계산
4. 다음 primitive action 실행
5. transition kind 확인
6. none이면 collision 후보로 기록
7. collision 누적 시 blocked tile 업데이트
8. NPC block이면 wait/replan
9. exit edge면 step off edge 시도
10. map transition 확인

---

## 6. Dialog Detection 개선

grokemon은 dialog active를 `rWY < 144`로 보고, dialog 종료는 `rWY >= 144` 연속 2회 확인을 요구한다.

우리도 false positive를 줄이기 위해 다음 정책을 둔다.

```text
dialog_active:
  windowY < 144

dialog_closed:
  windowY >= 144 for 2 consecutive reads
```

즉, 한 번 숨겨졌다고 바로 dialog 종료로 보면 안 된다.

---

## 7. Battle Executor 개선

grokemon의 battle executor에서 중요한 점:

1. battle action 후 narration을 자동 진행한다.
2. `wIsInBattle`이 0이 되거나 battle menu arrow tile이 다시 나타날 때까지 A를 누른다.
3. Gen 1 move cursor는 턴 사이에 유지되므로 현재 cursor 위치를 읽고 이동해야 한다.
4. trainer defeat animation 중 `wIsInBattle`이 유지될 수 있으므로 최대 40번 A로 battle exit를 기다린다.
5. post-battle dialog는 최대 5라운드 처리한다.

우리 BattlePolicy에 추가:

```text
Do not assume battle menu cursor starts at 0.
Read current menu cursor when possible.
After selecting battle action, auto-advance narration safely.
Stop if:
  battle ended
  battle menu returned
  choice appeared
  naming screen appeared
  new battle started
```

---

## 8. EvidenceRecorder 개선

grokemon은 runs 아래에 turn logs, screenshots, session events, map memory, command history를 저장한다.

우리 evidence package에 추가:

```text
runs/<run-id>/
├─ turn_logs.jsonl
├─ input_results.jsonl
├─ session_events.jsonl
├─ command_history.jsonl
├─ map_memory.json
├─ screenshots/
├─ supervisor_hints.jsonl
├─ transition_trace.jsonl
├─ authority_violations.json
├─ failure_report.md
└─ suggested_policy_patch.md
```

특히 `input_results.jsonl`이 필요하다.

각 입력은 다음을 기록해야 한다.

```json
{
  "button": "UP",
  "frames": 5,
  "source": "agent",
  "executed": true,
  "reason": null,
  "before": {},
  "after": {},
  "transition": {"kind": "movement"},
  "settle_timed_out": false,
  "polls": 3
}
```

---

## 9. Supervisor 재정의

이전 문서의 RecoveryAgent, CriticAgent, PRSteeringAgent를 MVP에서 따로 다 만들지 말고 Supervisor로 묶는다.

```text
Supervisor
├─ stuck detection
├─ goal ledger
├─ adviser hints
├─ intervention loop
├─ failure classification
├─ next experiment suggestion
└─ PR steering trigger
```

Supervisor 출력:

```json
{
  "hint": "Repeated UP produced no movement. Forbid UP for 10 turns and try LEFT/RIGHT.",
  "failure_type": "wall_loop",
  "confidence": 0.86,
  "forbidden_actions": [{"action": "UP", "until_step": 120}],
  "recommended_macro_action": "recover_from_wall_loop",
  "should_create_issue": true,
  "should_create_pr": false
}
```

---

## 10. 우리 Runbook에 추가할 새 Milestones

### M07 — Session Authority Guard

Acceptance:

```text
pnpm run check:session-authority 또는 동일 스크립트 통과
low-level input direct call이 allowlist 밖에 없을 것
tool gating authority가 한 곳에 있을 것
readiness polling이 InputGate 중심일 것
```

### M08 — InputGate Transaction Logging

Acceptance:

```text
input_results.jsonl 생성
executed/rejected input 구분
rejected reason 기록
transition kind 기록
settle timeout 기록
```

### M09 — Mode-gated Tool Contract

Acceptance:

```text
battle mode에서 navigation tool 노출 금지
dialog mode에서 battle/navigation tool 노출 금지
overworld mode에서 battle/dialog tool 노출 금지
test로 검증
```

### M10 — Transition-based Reward

Acceptance:

```text
transition kind에 따라 reward 부여
none transition 반복 시 wall_loop evidence 증가
map transition 성공 시 reward 증가
mode transition 로그 기록
```

### M11 — MapMemory A* Navigation

Acceptance:

```text
walkabilityGrid 생성
unknown tile walkable 처리
collision tile blocked 업데이트
NPC block 시 wait/replan
edge connection step-off 처리
```

---

## 11. Codex 명령어

```bash
codex "Read ./POKEMONDEV_EXECUTABLE_RUNBOOK.md and add the Grokemon integration upgrade. Refactor the MVP around CommandAgentRunner, ObservationBuilder, ModeGatedToolFactory, CommandExecutor, InputGate, Supervisor, and EvidenceRecorder. Add SessionState as the authoritative mode source, implement or stub check-session-authority, log InputGate transactions to input_results.jsonl, enforce one game action per turn, enforce mode-gated tools, use TransitionDetector output for reward/stuck scoring, and extend EvidencePackage with session_events, command_history, input_results, map_memory, supervisor_hints, and transition_trace. Use local ROM only; do not download ROMs."
```

---

## 12. 핵심 문장

최종적으로 우리가 가져가야 할 문장은 이것이다.

```text
LLM is not the player.
LLM is a constrained command proposer.

The harness is the player.
The harness owns state authority, input safety, tool gating, transition evidence, recovery, and logs.
```

한국어:

```text
LLM은 플레이어가 아니다.
LLM은 제한된 명령 제안자다.

진짜 플레이어는 하네스다.
하네스가 상태 권위, 입력 안전성, 도구 제한, 상태 전이 증거, 복구, 로그를 소유한다.
```
