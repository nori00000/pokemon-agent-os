# Pokemon Red Agent OS — Executable Runbook v1

작성 목적: 기존 설계 문서를 실제 Codex CLI가 단계별로 실행할 수 있는 Runbook으로 전환한다.  
대상 문서:
- `POKEMONDEV_AGENT_OS_WORKFLOW.md`
- `POKEMONDEV_USER_CASES_UPGRADE.md`
- `POKEMONDEV_DEEP_EVAL_UPGRADE.md`

핵심 목표:
1. GitHub Issue 기반 작업 통제
2. 로컬 ROM + mGBA 제어 확인
3. RAM state reader 구축
4. max_steps episode runner 구축
5. evidence package 생성
6. loop-aware wrapper / anti-spam / anti-loop 구축
7. reward 계산
8. failure → issue → policy patch → PR 루프 구축
9. Viridian City 도달을 첫 실행 목표로 설정

중요:
- ROM은 사용자가 합법적으로 보유한 로컬 파일만 사용한다.
- Codex는 ROM을 다운로드하거나 인터넷에서 찾지 않는다.
- 구현은 큰 재작성보다 작은 작동 루프를 우선한다.

---

# 0. Execution Philosophy

이 프로젝트는 “똑똑한 LLM”을 만드는 프로젝트가 아니다.

```text
dumb agent
↓
bounded episode
↓
evidence logs
↓
failure classification
↓
issue / PR
↓
policy update
↓
next run
```

즉:

> 실패가 코드와 이슈와 PR로 흐르게 만드는 하네스 프로젝트다.

---

# 1. Repository Bootstrapping

## 1.1 Codex가 먼저 해야 할 일

```bash
pwd
ls -la
git status
gh repo view
gh issue list --limit 20
```

실패하면:

```text
logs/debug_notes.md
```

에 기록한다.

예:

```md
## Bootstrap Failure

- command:
- error:
- suspected cause:
- next action:
```

---

## 1.2 Required Directories

없으면 생성한다.

```bash
mkdir -p knowledge
mkdir -p memory/policies
mkdir -p logs/evaluation_reports
mkdir -p logs/screenshots
mkdir -p logs/ascii_maps
mkdir -p checkpoints/states
mkdir -p runs
mkdir -p src/state
mkdir -p src/env
mkdir -p src/planner
mkdir -p src/agents
mkdir -p src/action
mkdir -p src/evaluation
mkdir -p src/github
mkdir -p src/monitor
mkdir -p docs/decision_records
```

---

## 1.3 Required Placeholder Files

```bash
touch logs/debug_notes.md
touch logs/agent_steps.jsonl
touch logs/transitions.jsonl
touch logs/reward_logs.jsonl
touch logs/recovery_logs.jsonl
touch logs/battle_logs.jsonl
touch logs/state_snapshots.jsonl
```

초기 JSON 파일 생성:

```bash
cat > memory/runtime_state.json <<'JSON'
{
  "current_map": null,
  "map_raw_id": null,
  "x": null,
  "y": null,
  "mode": "unknown",
  "current_mission": "bootstrap",
  "current_subgoal": "verify_rom_control",
  "in_battle": false,
  "in_dialog": false,
  "in_menu": false,
  "last_action": null,
  "forbidden_actions": [],
  "stuck_score": 0,
  "recovery_mode": false
}
JSON

cat > memory/mission_state.json <<'JSON'
{
  "current_mission": "mission_00_boot_game",
  "completed_missions": [],
  "active_micro_goal": "verify_player_control",
  "last_success_evidence": null
}
JSON

cat > memory/failure_dex.json <<'JSON'
{
  "wall_loop": {
    "evidence": ["same_position_count_high", "repeated_action_same_direction", "screen_hash_repeated"],
    "threshold": 0.7,
    "recoveries": ["forbid_repeated_direction", "try_lateral_move", "backtrack_to_last_progress_coordinate", "reset_subgoal"]
  },
  "dialog_loop": {
    "evidence": ["dialog_state_true_for_many_steps", "same_text_box_repeated", "no_map_or_position_change"],
    "threshold": 0.7,
    "recoveries": ["press_A", "press_B", "wait", "detect_dialog_closed"]
  },
  "menu_loop": {
    "evidence": ["menu_state_true", "no_position_change", "START_or_A_repeated"],
    "threshold": 0.7,
    "recoveries": ["press_B_until_closed"]
  },
  "battle_loop": {
    "evidence": ["battle_state_true_for_many_turns", "enemy_hp_not_changing", "same_move_repeated_without_effect"],
    "threshold": 0.7,
    "recoveries": ["switch_to_battle_policy", "change_move", "use_item_if_needed"]
  },
  "failed_map_transition": {
    "evidence": ["at_exit_coordinate", "map_id_not_changed", "same_transition_attempt_repeated"],
    "threshold": 0.7,
    "recoveries": ["step_back", "realign_to_trigger_coordinate", "retry_transition", "choose_alternative_exit"]
  }
}
JSON
```

---

# 2. GitHub Issue Control Plane

## 2.1 Create Labels

Codex must run label setup first.

```bash
cat > /tmp/pokemondev_create_labels.sh <<'SH'
gh label create "area:state" --description "RAM state reader and normalized game state" --color "1d76db" || true
gh label create "area:memory" --description "Runtime memory, failure memory, recovery memory" --color "5319e7" || true
gh label create "area:knowledge" --description "Static Pokemon Red world knowledge" --color "0e8a16" || true
gh label create "area:navigation" --description "Spatial graph and deterministic movement" --color "0052cc" || true
gh label create "area:battle" --description "Battle state and battle policy" --color "d93f0b" || true
gh label create "area:recovery" --description "Stuck detection and recovery policy" --color "b60205" || true
gh label create "area:evaluation" --description "Metrics, reports, dashboards" --color "fbca04" || true
gh label create "area:workflow" --description "GitHub issue workflow and automation" --color "c5def5" || true
gh label create "area:docs" --description "Documentation and handoff documents" --color "bfdadc" || true
gh label create "type:bug" --description "Bug or regression" --color "d73a4a" || true
gh label create "type:task" --description "Implementation task" --color "0075ca" || true
gh label create "type:experiment" --description "Experiment with measurable result" --color "a2eeef" || true
gh label create "type:research" --description "Research or source review" --color "7057ff" || true
gh label create "type:decision" --description "Architecture decision record" --color "fef2c0" || true
gh label create "type:milestone" --description "Major project milestone" --color "ffcc00" || true
gh label create "priority:p0" --description "Critical path" --color "b60205" || true
gh label create "priority:p1" --description "High priority" --color "d93f0b" || true
gh label create "priority:p2" --description "Medium priority" --color "fbca04" || true
gh label create "priority:p3" --description "Low priority" --color "0e8a16" || true
gh label create "status:todo" --description "Not started" --color "ededed" || true
gh label create "status:in-progress" --description "Currently being worked on" --color "1d76db" || true
gh label create "status:blocked" --description "Blocked by missing info or dependency" --color "b60205" || true
gh label create "status:needs-review" --description "Needs human or agent review" --color "fbca04" || true
gh label create "status:done" --description "Completed" --color "0e8a16" || true
gh label create "rl:observation" --description "Observation/state representation issue" --color "c2e0c6" || true
gh label create "rl:action" --description "Action selection or execution issue" --color "bfd4f2" || true
gh label create "rl:reward" --description "Reward/progress scoring issue" --color "f9d0c4" || true
gh label create "rl:policy" --description "Policy improvement issue" --color "d4c5f9" || true
gh label create "rl:evaluation" --description "Run evaluation and learning loop issue" --color "fff5b1" || true
SH

bash /tmp/pokemondev_create_labels.sh
```

---

## 2.2 Create Milestone Issues

Codex must check existing issues first.

```bash
gh issue list --search "[MILESTONE]" --limit 50
```

If missing, create:

```bash
gh issue create   --title "[MILESTONE] 00 GitHub issue control plane"   --label "type:milestone,area:workflow,priority:p0,status:todo"   --body "Set up GitHub Issues as project control plane. Acceptance: labels exist, milestones exist, Codex comments before and after implementation."

gh issue create   --title "[MILESTONE] 01 ROM boot and input control"   --label "type:milestone,area:state,priority:p0,status:todo"   --body "Verify local Pokémon Red ROM boots in mGBA and agent can send button input. Do not download ROMs."

gh issue create   --title "[MILESTONE] 02 RAM State Reader"   --label "type:milestone,area:state,priority:p0,status:todo,rl:observation"   --body "Read current map id, x/y, block x/y, battle/dialog/menu state if possible. Write memory/runtime_state.json and logs/state_snapshots.jsonl."

gh issue create   --title "[MILESTONE] 03 Episode runner and evidence logs"   --label "type:milestone,area:evaluation,priority:p0,status:todo,rl:evaluation"   --body "Implement max_steps episode runner. Produce agent_steps.jsonl, transitions.jsonl, reward_logs.jsonl, screenshots, summary.md."

gh issue create   --title "[MILESTONE] 04 Loop-aware wrapper"   --label "type:milestone,area:recovery,priority:p0,status:todo,rl:policy"   --body "Implement anti-spam, anti-loop, no-progress, failed-transition, menu/dialog/battle loop detection."

gh issue create   --title "[MILESTONE] 05 Micro-goal graph to Viridian"   --label "type:milestone,area:knowledge,area:navigation,priority:p0,status:todo"   --body "Implement micro-goal graph from player control to Viridian City, including Oak event, starter, rival battle, Route 1."

gh issue create   --title "[MILESTONE] 06 PR steering loop"   --label "type:milestone,area:workflow,priority:p1,status:todo"   --body "After each failed run, create/update issue and propose policy patch PR with evidence package."
```

---

# 3. ROM / Emulator Setup Contract

Codex must not guess the ROM path.

Expected env var:

```bash
export POKEMON_RED_ROM="/absolute/path/to/Pokemon Red.gb"
```

Codex must check:

```bash
test -f "$POKEMON_RED_ROM" && echo "ROM exists" || echo "ROM missing"
```

If missing:

- Do not continue to ROM execution.
- Mark relevant GitHub issue blocked.
- Write `logs/debug_notes.md`.

Example blocked comment:

```bash
gh issue comment ISSUE_NUMBER --body "Blocked: POKEMON_RED_ROM is not set or file does not exist. Please set export POKEMON_RED_ROM=/absolute/path/to/local/legal/rom.gb"
```

---

# 4. State Reader Implementation Contract

Create adapter abstraction.

```text
src/state/state_reader.ts
```

Interface:

```ts
export type GameState = {
  step: number;
  timestamp: string;
  mapRawId: number | null;
  mapId: string | null;
  x: number | null;
  y: number | null;
  blockX: number | null;
  blockY: number | null;
  inBattle: boolean;
  inDialog: boolean;
  inMenu: boolean;
  party?: unknown[];
  screenHash?: string;
};

export interface StateReader {
  readState(): Promise<GameState>;
}
```

If actual RAM bridge is not available yet, create:

```text
src/state/mock_state_reader.ts
```

But mark issue blocked/partial.

Pass criteria:

- `memory/runtime_state.json` updates after each read.
- `logs/state_snapshots.jsonl` appends each state.
- State reader can be swapped without changing planner.

---

# 5. Episode Runner

Create:

```text
src/evaluation/episode_runner.ts
```

Inputs:

```json
{
  "episode_id": "run_YYYYMMDD_HHMMSS",
  "goal": "reach_viridian_city",
  "max_steps": 2000,
  "screenshot_interval": 100,
  "llm_supervisor_interval": 100
}
```

Loop:

```text
for step in max_steps:
  state = readState()
  mode = coordinator.route(state)
  action = policy.choose(state)
  execute(action)
  next_state = readState()
  reward = calculateReward(state, action, next_state)
  log transition
  update stuck detectors
  if success: stop
  if hard failure: stop
```

Outputs:

```text
runs/run_ID/summary.md
runs/run_ID/agent_steps.jsonl
runs/run_ID/transitions.jsonl
runs/run_ID/reward_logs.jsonl
runs/run_ID/failure_report.md
runs/run_ID/screenshots/
runs/run_ID/suggested_policy_patch.md
```

---

# 6. Loop-aware Wrapper

Create:

```text
src/env/loop_aware_wrapper.ts
```

Detectors:

```text
action_spam
position_loop
screen_loop
no_progress
failed_map_transition
dialog_loop
menu_loop
battle_loop
```

Detector output:

```json
{
  "stuck_score": 0.82,
  "failure_type": "wall_loop",
  "evidence": {
    "same_position_count": 14,
    "repeated_action": "UP",
    "same_screen_count": 11
  },
  "recommended_recovery": "try_lateral_move"
}
```

Pass criteria:

- same action repeated beyond threshold triggers anti-spam.
- same x/y repeated beyond threshold triggers position_loop.
- stuck_score appears in `logs/agent_steps.jsonl`.

---

# 7. Reward Calculator

Create:

```text
src/evaluation/reward.ts
```

Reward v3:

```text
total_reward =
  strategic_reward
+ mission_reward
+ event_reward
+ navigation_reward
+ battle_reward
+ recovery_reward
+ anti_loop_penalty
+ anti_spam_penalty
```

Implementation should output component breakdown.

Schema:

```json
{
  "reward_total": 3.2,
  "components": {
    "strategic_reward": 0,
    "mission_reward": 0,
    "event_reward": 0,
    "navigation_reward": 2,
    "battle_reward": 0,
    "recovery_reward": 0,
    "anti_loop_penalty": 0,
    "anti_spam_penalty": 0
  }
}
```

Pass criteria:

- reward_logs.jsonl contains every step.
- evaluation report sums total reward.
- negative reward appears for loop/spam.

---

# 8. Micro-goal Graph

Create:

```text
knowledge/micro_goals_viridian.json
```

Content:

```json
{
  "goal": "reach_viridian_city",
  "micro_goals": [
    {
      "id": "verify_player_control",
      "success_condition": ["state_read_success", "button_input_changes_state"],
      "max_steps": 100
    },
    {
      "id": "leave_bedroom",
      "success_condition": ["map_changed_or_location_downstairs"],
      "max_steps": 300
    },
    {
      "id": "leave_player_house",
      "success_condition": ["map_id_is_pallet_town"],
      "max_steps": 300
    },
    {
      "id": "trigger_oak_event",
      "success_condition": ["oak_dialog_or_forced_movement_or_lab_entry"],
      "max_steps": 500
    },
    {
      "id": "choose_starter",
      "success_condition": ["party_count_increased"],
      "max_steps": 500
    },
    {
      "id": "handle_rival_battle",
      "success_condition": ["battle_ended_and_control_restored"],
      "max_steps": 800
    },
    {
      "id": "exit_pallet_town_north",
      "success_condition": ["map_id_is_route_1"],
      "max_steps": 500
    },
    {
      "id": "traverse_route_1",
      "success_condition": ["map_id_is_viridian_city"],
      "max_steps": 1000
    }
  ]
}
```

Pass criteria:

- current active micro-goal is saved in `memory/mission_state.json`.
- evaluation report includes highest micro-goal reached.

---

# 9. Macro Actions

Create:

```text
src/action/macro_actions.ts
```

Required macro actions:

```text
go_to_coordinate
go_to_exit
advance_dialog_until_closed
escape_wild_battle
close_menu
recover_from_wall_loop
realign_transition
```

Each macro action must have:

```text
max_steps
success_condition
failure_condition
evidence_log
```

Pass criteria:

- macro action logs start/end.
- macro action failure creates failure evidence.
- primitive actions are still logged.

---

# 10. Evidence Package Builder

Create:

```text
src/evaluation/evidence_package.ts
```

At episode end, build:

```text
runs/run_ID/
├─ summary.md
├─ config.json
├─ agent_steps.jsonl
├─ transitions.jsonl
├─ reward_logs.jsonl
├─ recovery_logs.jsonl
├─ screenshots/
├─ failure_report.md
└─ suggested_policy_patch.md
```

Failure report template:

```md
# Failure Report

## Episode
- id:
- goal:
- max_steps:
- stopped_reason:

## Top Failure
- type:
- first_step:
- max_stuck_score:

## Evidence
- same_position_count:
- repeated_action:
- same_screen_count:
- map_id:
- x/y:

## Diagnosis

## Suggested Policy Patch

## Suggested GitHub Issue
```

---

# 11. GitHub Issue / PR Automation

Create:

```text
src/github/issue_workflow.ts
```

Minimum functions:

```ts
createFailureIssue(reportPath)
commentEpisodeResult(issueNumber, summaryPath)
createPolicyBranch(failureType)
commitPolicyPatch(files, message)
createPolicyPR(title, body)
```

If automation is too risky, generate shell commands in:

```text
runs/run_ID/github_actions.md
```

Pass criteria:

- failed episode creates or suggests a GitHub issue.
- policy patch is either committed to a branch or written as suggested patch.
- PR body includes evidence.

---

# 12. PR Steering Policy

PR must not be created for every tiny failure.

Create PR when:

```text
same failure type appears in >= 2 episodes
or
failure blocks p0 milestone
or
max_steps exceeded with clear evidence
or
human requests policy PR
```

Otherwise:

- create issue only
- collect more evidence

---

# 13. Frame Rate Experiment

Create issue:

```text
[EXPERIMENT] Compare 60fps vs 240fps vs 640fps with fixed decision tick
```

Experiment design:

```text
same ROM state
same policy version
same max_steps
different emulator_fps
same decision_tick
compare:
  total_reward
  stuck_events
  time_to_viridian
  loop frequency
```

Important:

- Emulator FPS is not decision FPS.
- LLM supervisor should not run per frame.

---

# 14. Definition of Done

This Runbook is successful when:

```text
1. gh labels and milestone issues exist.
2. ROM path is checked safely.
3. StateReader abstraction exists.
4. EpisodeRunner can run max_steps.
5. logs/agent_steps.jsonl is produced.
6. logs/transitions.jsonl is produced.
7. logs/reward_logs.jsonl is produced.
8. loop-aware wrapper detects at least action_spam and position_loop.
9. micro_goals_viridian.json exists.
10. evidence package is generated after episode.
11. failed episode creates or suggests GitHub issue.
12. Codex comments progress on issue.
```

---

# 15. Final Codex Command

```bash
codex "Read ./POKEMONDEV_EXECUTABLE_RUNBOOK.md completely. Execute it step by step. First set up GitHub labels and milestone issues with gh CLI. Then create the required folders and placeholder files. Verify POKEMON_RED_ROM is set but do not download ROMs. Implement StateReader abstraction, EpisodeRunner with max_steps, runtime_state writer, agent_steps/transitions/reward logs, loop-aware wrapper with anti-spam and position-loop detection, reward calculator v3, micro_goals_viridian.json, macro_action skeletons, evidence package builder, and GitHub issue/PR workflow skeleton. Work one issue at a time, comment on the issue before and after changes, and update logs/debug_notes.md after each test."
```

---

# 16. Short Codex Command

```bash
codex "Read ./POKEMONDEV_EXECUTABLE_RUNBOOK.md and implement the first executable loop: GitHub issue control plane, repo folders, ROM path check, StateReader abstraction, max_steps EpisodeRunner, JSONL logs, loop-aware anti-spam/position-loop detection, reward v3 logging, micro-goals to Viridian, evidence package builder, and issue update workflow. Use local ROM only."
```
