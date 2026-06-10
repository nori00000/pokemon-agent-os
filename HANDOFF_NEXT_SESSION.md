# Pokemon Agent OS — 다음 세션 핸드오프 (2026-06-06)

> 작성: m4-air, 세션 종료 시점. GitHub `nori00000/pokemon-agent-os` 이슈 #1~#13 + #4 코멘트 기록 기반.
> **다음 세션 첫 액션: 아래 "§1 한 줄 + 할 일"만 보고 시작.**

---

## 0. ⚠️ 메모리 제약 (가장 중요 — 먼저 읽기)

이 노트북은 **m4-air, 16GB**다. **하네스 인스턴스는 한 번에 단 하나만 돌린다.**
- mGBA(에뮬) + mGBA-http(브리지) + Node 하네스 + 로컬 AI 프록시가 동시에 물린다. 2개 이상은 무겁고, **모델 백엔드(`:8000` claude-browser)가 단일 세션이라 2개 동시 구동 자체가 안 된다**(§3.2).
- 그래서 다음 세션은 **a/b/c 중 하나만** 띄운다. 디버그 대상은 **c(새 EpisodeRunner)** 이므로, **b를 멈추고 c만** 돌린다.

---

## 1. 한 줄 + 할 일

**한 줄:** grokemon 리팩터(7컴포넌트 + EpisodeRunner 루프 + 별도 entry `src/episode-main.ts`)는 **코드·유닛테스트(133개) 전부 통과**했지만, **새 entry를 실제 에뮬레이터로 돌리면 step 1에서 영원히 멈춘다**(라이브 모델 호출 미완료). 레거시 `src/index.ts`(=b)는 같은 백엔드로 정상 동작.

**할 일 (두 갈래, 서로 보완):**
1. **(디버그) 라이브 hang 잡기** — c의 첫 모델 요청 본문을 동작하는 b의 요청과 **직접 캡처·비교**한다. 추측 정렬은 3번 실패했으니 이제 실제 요청을 계측한다. (§6)
2. **(계획 추가) RAM 메모리맵 기반 파싱 + 마스킹** — 스크린샷 픽셀 의존을 줄이고, Pokemon Red 알려진 RAM 주소에서 타일맵/워크어빌리티/모드를 **결정론적으로 파싱**해 관측을 **마스킹**한다. GROKEMON MapMemory 방향이자, **hang이 이미지 페이로드 문제라면 이걸로 우회·검증도 된다.** (§6.5)

---

## 2. 머신·경로·포트

| 항목 | 값 |
|---|---|
| 코드 repo | `~/Desktop/pss-mgba` (git remote = `minpeter/pss-mgba`, **푸시 권한 없음**) |
| 런 작업폴더 | `~/Desktop/pss-mgba-runs/{a,b,c}` (각자 .env·ROM·세이브·mgba-http 독립) |
| GitHub 통제 | `nori00000/pokemon-agent-os` (이슈/PR은 **반드시 `gh ... -R nori00000/pokemon-agent-os`**) |
| 인스턴스 a | socket 8888 / http 5001 / metrics 9464 |
| 인스턴스 b | socket 8889 / http 5002 / metrics 9465 (레거시 `src/index.ts`, **동작함**) |
| 인스턴스 c | socket 8890 / http 5003 / metrics 9466 (새 `src/episode-main.ts`, **step1 hang**) |
| AI 백엔드 | `runs/*/.env`의 `AI_BASE_URL=http://127.0.0.1:8000/v1`, `AI_MODEL=claude-browser` (단일 Python 서버, 한 번에 하나) |
| 로컬 ROM | `~/Desktop/pss-mgba/pokemon-red.gb` (git 미추적). **다운로드 금지.** |

---

## 3. ⚠️ 운영 함정 3가지 (이거 모르면 헤맨다)

### 3.1 mGBA `--script` 미지원 → 인스턴스 기동이 반자동
- 이 맥 mGBA는 **0.10.5**, `--script` 옵션 없음(`brew` stable 최신도 0.10.5; `--script`는 0.11-dev/HEAD에만).
- `multi/start.sh`는 `--script`로 Lua 소켓서버를 자동 로드하도록 설계됨 → **이 맥에선 에뮬이 안 뜬다.**
- **기동 절차(인스턴스 X):**
  1. 에뮬 수동: `nohup /opt/homebrew/bin/mGBA ~/Desktop/pss-mgba-runs/X/pokemon-red.gb > ~/Desktop/pss-mgba-runs/X/logs/mgba.log 2>&1 & echo $! > ~/Desktop/pss-mgba-runs/X/logs/mgba.pid`
  2. **사람이 GUI로** 그 창에서 `Tools → Scripting → Load script` → `~/Desktop/pss-mgba-runs/X/mGBASocketServer.lua` 로드. 콘솔 `Listening on port 88XX` 확인.
  3. `lsof -nP -i :88XX | grep LISTEN`로 **올바른 창(PID)** 바인드 검증.
  4. 브리지: `( cd ~/Desktop/pss-mgba-runs/X/mgba-http && nohup ./mGBA-http > ../logs/mgba-http.log 2>&1 & )` → `:50XX` 대기.
  5. 하네스: cwd=런폴더, `tsx` 실행 (b=`src/index.ts`, c=`src/episode-main.ts`).

### 3.2 단일 claude-browser 백엔드(`:8000`) = 한 번에 하나
- a/b/c 모두 같은 `:8000` claude-browser로 모델 호출. 실제 브라우저 세션 브리지라 **동시 2개 불가**(starvation).
- **함정:** Node 하네스는 부모/자식 2프로세스. 모델 연결(`:8000` ESTABLISHED)은 **자식**이 잡는다. 부모만 `lsof`하면 "연결 없음" **오진**(오늘 이걸로 헤맸다).

### 3.3 git commit / `rtk` 차단
- `git add/commit/push`는 분류기가 차단 → **커밋 사용자 수동.** 모든 변경은 working tree에만.
- `pkill`/`kill -9` 복합도 막힐 수 있음 → **plain `kill <pid>`**.

---

## 4. 지금까지 한 일 (GitHub #4 기록 요약)

### 완료·검증된 코드 자산 (전부 working tree, 미커밋)
- **grokemon 7컴포넌트**: `src/session/{session-state,input-gate,transition-detector,supervisor}.ts`, `src/agent/{command-agent-runner,observation-builder,mode-gated-tool-factory}.ts`, `src/executor/command-executor.ts`, `src/game/map-memory.ts`(스텁)
- **`src/evaluation/`**: `episode-runner.ts`(실제 `run()` 루프), `evidence-recorder.ts`, `reward.ts`, `run-config.ts`(`emulator_fps` 60/240/640, 기본 240)
- **`scripts/check-session-authority.ts`** (`pnpm check:session-authority`)
- **`src/episode-main.ts`** (별도 production entry, `pnpm episode`) — **라이브에서 멈춤**
- 테스트: `tests/episode-runner.test.ts`, `tests/grokemon-contracts.test.ts`, `tests/map-memory.test.ts`
- 레거시 `src/index.ts`는 **변경 안 함** (b 정상 동작)

### 정적 검증 (마지막 라운드)
- `pnpm typecheck` ✅ / `pnpm check:session-authority` ✅ / `pnpm test` ✅ **20 files, 133 tests** / 변경파일 biome ✅

### GitHub 이슈 (`nori00000/pokemon-agent-os`)
- #1~#7 마일스톤 00~06 / #8 Session Authority / #9 InputGate Logging / #10 Transition Reward / #11 MapMemory A* / #13 [EXPERIMENT] 60/240/640fps
- **#4 = Episode runner** — 3라운드 root-cause/fix 코멘트 누적(핵심).

---

## 5. ❌ 미해결 버그 — 정확한 상태

### 증상 (3번의 라이브 시도에서 불변)
- `runs/c/runs/run_*_episode/agent_steps.jsonl`에 **딱 1줄**: `{"kind":"observation","session_mode":"dialog","step":1}` 후 **영원히 멈춤.**
- `reward_logs/transitions/input_results` = 0줄.
- c의 **자식 node가 `:8000`에 ESTABLISHED** (모델 호출 도달) → **백엔드가 응답 안 줌.** 에러도 없음.
- **같은 `:8000`이 b 요청엔 ~15초 내 정상 응답.**

### 시도했고 실패한 것 (반복 금지)
1. "코드 hang, 모델 미도달" → ❌ 오진(자식이 연결돼 있었음).
2. **hang-fix**: turn 시작 `send(createObservedInput)` → `send(createTurnPrompt)` + `beforeTurn` `steer`(레거시 방식) → 라이브 여전히 멈춤.
3. **align-to-legacy**: `beforeTurn`이 `captureMgbaObservation` + `createObservedInput({observation,recentActions,stuckMemory,text})`로 레거시 페이로드 일치, 툴 스키마도 맞춤 → **여전히 step1 멈춤.**
4. **경합 가설** → ❌ 폐기. b 완전 정지·브라우저 FREE에서도 c 동일하게 멈춤.

### 좁혀진 차이 (b 동작 vs c 멈춤)
| 항목 | 레거시 b (`src/index.ts`) | c (`src/episode-main.ts`) |
|---|---|---|
| hooks | `beforeTurn` **+ `afterStep`** | `beforeTurn`만 |
| 세션 이름 | `"pokemon-run"` | `"pokemon-episode-run"` |
| 스트림 소비 | `streamSupervisedRun({run})` | `CommandAgentRunner.run()` → `run.stream()` |
| 툴 execute | 직접 mGBA 실행 | queue-only — InputGate가 나중 실행 |

→ 관측/툴 스키마는 맞췄는데도 멈춤 → 남은 용의자: **`afterStep` 부재 / 세션 이름 / `CommandAgentRunner` stream 소비 방식 / `@minpeter/pss-runtime` Agent가 EpisodeRunner 루프로 구동될 때의 차이.**

---

## 6. 다음 세션 할 일 — (A) 라이브 hang 디버그

> "또 추측해서 codex로 고치기"가 아니다. **실제 요청을 계측해서 차이를 눈으로 본다.**

1. **준비**: b 돌고 있으면 정지(brower 해제). `runs/b/logs/harness.pid`의 **부모+자식 plain `kill`**. b의 mGBA+브리지는 살려두면 재기동 시 GUI 재로드 불필요.
2. **심어둔 디버그 로그 확인**: align 라운드에서 `src/episode-main.ts`에 `console.error("[episode-main debug] …")`(첫 steered 페이로드의 part 수/image 여부/text·image·total 바이트)를 넣어뒀다. **그런데 마지막 라이브 run에서 `runs/c/logs/episode.log`가 0바이트 = 그 라인이 안 찍혔다.** → 코드가 steer 지점에 도달조차 못 했거나 stderr가 그 로그로 안 갔다는 **핵심 단서.** 이 라인이 실제로 찍히는지/어디로 가는지부터 확인.
3. **요청 본문 캡처·비교**: b의 동작 요청과 c의 멈춤 요청을 **본문 레벨 비교**(이미지 인코딩, 메시지 순서, tools/tool_choice 직렬화, system prompt 크기 등). 방법: `:8000` 백엔드 요청 로깅 / 모델 provider 레이어에 outgoing 덤프 미들웨어 / 양쪽 `console.error` 요약 비교.
4. **`afterStep` 가설**: 레거시는 `afterStep`에서도 re-steer. 런타임이 첫 모델 스냅샷 시작에 `afterStep` 등록을 필요로 하는지 검증.
5. **라이브 검증**: c 단독 실행 → `agent_steps.jsonl`이 **2줄 이상** + `transitions/reward_logs` 기록되면 성공.

---

## 6.5. 다음 세션 할 일 — (B) ★계획 추가★ RAM 메모리맵 기반 파싱 + 마스킹

**무엇:** 스크린샷 픽셀을 LLM이 읽게 하는 대신, **Pokemon Red의 알려진 RAM 주소(메모리 맵)에서 게임 상태를 결정론적으로 파싱**하고, 그 결과로 **관측을 마스킹**한다.

**파싱 대상 (RAM, GROKEMON 문서 §4 + 런북 #3 RAM State Reader 참조):**
- 화면 타일맵 **20×18** (`mgba-http`/소켓의 `core.readRange`로 읽기) → **2×2 블록 메타타일 분류** → walkable/wall/grass/water/door·warp.
- 플레이어 좌표 `x/y`, `mapId`(맵 전이 판정), 블록 좌표.
- 모드 플래그: dialog active = `windowY(rWY) < 144` (종료는 `>=144` 연속 2회), `wIsInBattle`, 메뉴 상태.
- 스프라이트/NPC 점유 타일(임시 blocked).

**마스킹 (왜 중요):**
- RAM에서 얻은 walkable/blocked/object grid로 **관측을 마스킹/구조화**한다. 예: (a) 스크린샷에 결정론적 오버레이(레거시의 빨간 가이드라인을 RAM 기반으로 정확화), (b) 화면 밖/비관련 영역 마스킹, (c) 스크린샷을 줄이거나 **구조화 텍스트 관측(walkability grid + 모드 + 좌표)으로 대체/병행.**
- **hang 연결고리:** 라이브 hang이 **거대/특정 이미지 페이로드** 때문이라면, 이미지를 줄이고 RAM 파싱 텍스트로 대체하는 것만으로 **우회 검증**이 된다. (§6의 디버그와 별개로, 또는 함께.)

**어디에 얹나 (기존 자산 재사용, 큰 재작성 금지):**
- `src/game/map-memory.ts` (현재 스텁: unknown=walkable, collision=blocked, NPC=blocked, door/warp=passable) → **실제 RAM 타일맵 파싱으로 채우기.**
- `src/pokemon-state.ts`, `src/observation.ts`, `src/observation-bookkeeping.ts` (기존 상태/관측 읽기) 위에 어댑터.
- `src/agent/observation-builder.ts` (모델-facing 관측 생성)에 마스킹/구조화 옵션 추가.
- mGBA 소켓 명령: `.local-tools/mgba-http/mGBASocketServer.lua`의 `core.read8/read16/readRange/screenshot`.

**연결 이슈:** #3 RAM State Reader, #11 MapMemory A*(walkabilityGrid가 선행), #10 Transition reward(RAM x/y/map 의존). → 새 이슈로 "[task] RAM memory-map parsing + observation masking"을 `-R nori00000/pokemon-agent-os`로 만들고 #3/#11과 연결 권장.

**참고 (Pokemon Red RAM 주소):** 타일맵·좌표·battle/dialog 플래그는 공개 디스어셈블리(pokered) 기준 주소가 있다. GROKEMON 문서의 walkability 규칙(unknown=walkable, collision 학습, door/warp passable)을 그대로 따른다.

---

## 6.6. 다음 세션 할 일 — (C) ★정책 루프 닫기 + anti-local-optima 설계 원칙★

**현 상태:** 정책 루프가 **안 닫혀 있다** — 증거수집(관측→실행→transition→reward→분류→**로그**)만 있고 **피드백(정책 반영)** 이 없다. 실측 근거:
- **인-런 개방**: `supervisor.evaluateInput`가 `forbidden_actions`/`recommended_macro_action`을 만들지만 `episode-runner.ts:263`에서 **로그만**. `#chooseCommands` context엔 안 들어감 → 다음 행동에 반영 안 됨.
- **크로스-런 개방**: `src/github/` 없음(issue/PR 자동화 미구현), `memory/policies`·`failure_dex.json` 없음 → 런 간 학습 0.
- **분류 1종**: `supervisor.ts`는 wall_loop만, `should_create_issue/pr` 하드코딩 false.
- **reward farmable**: `reward.ts` 이동마다 +0.4, potential/novelty/micro-goal 진전 보상 전무.

**닫는 작업:**
1. **인-런 피드백**: hint의 `forbidden_actions`/`recommended_macro_action`을 `#chooseCommands` context→에이전트 프롬프트/툴게이팅에 주입. (#5)
2. **분류 확장**: dialog/menu/failed_map_transition + 임계/연속횟수. (#5)
3. **크로스-런**: `src/github/issue_workflow.ts`(failure→#코멘트→`suggested_policy_patch.md`) + PR steering. 코드 repo=minpeter라 PR 대신 nori 이슈+패치파일. (#6/#7)
4. **정책 영속**: `memory/failure_dex.json`·`memory/policies/`에 학습 forbidden/recovery 저장→다음 런 로드. (#10/#11)

### ★Anti-Local-Optima 설계 원칙★ (위 작업의 기준 — 지엽 최적화 방지)
> 지엽 최적화 = proxy(밀집보상·마지막실패제거·인스턴스별 reward)와 진짜 목표(희소·전역 비리디안)의 분리.

1. **희소 주축 + farm-불가 보조**: 진짜 목적함수 = 도달 **최고 micro-goal/맵**(희소·단조). dense는 **potential shaping**(Φ=−서브골거리, reward+=γΦ'−Φ → 배회 합=0) + **count-based novelty**(map+좌표 방문수 감쇠)만. → 현 `reward.ts` +0.4/이동 farm 차단.
2. **정체 시 목표 레벨로 에스컬레이트**: 국소 패치(forbidden)에 **상한**. K회 패치·매크로 Δ=0 → 서브골 재선택(L3). (`ouroboros-drift` 패턴)
3. **frontier 탐색(Go-Explore)**: 최원거리 frontier 기억→복귀 후 탐색. stuck_score↑ 시 탐색 temperature/ε↑.
4. **연합(a/b/c)은 평균 말고 다양성**: 선택기준=전역 진전(furthest), 국소 reward 아님. **정책 averaging 금지**. 공유는 정책 아닌 **증거(failure_dex+frontier)**. 꼴찌를 1등 frontier에서 **재시드**(PBT). 행동 커버리지(MAP-Elites).
5. **크로스-런 트리거 = 매크로 정체**("N 에피소드 최고 micro-goal Δ=0"), "같은 실패 ≥2" 아님.
6. **토대 = 결정론 관측(B)**: RAM 좌표/맵 위에서 reward·novelty·진전 계산(인식 노이즈 최적화 방지).

> 키워드 3개: **potential-based reward shaping** / **Go-Explore frontier** / **PBT+Quality-Diversity(MAP-Elites)**.

## 6.7. 다음 세션 할 일 — (D) 공개 레포 업로드 + AI 평가 대비
교훈 "점수≠코드". **실질 강점 드러내고 실질 갭 메우기**(score theater 금지). 상세는 `FINAL_PLAN.md §3(D)`.
- **(필수)** 재현 가능한 working run + evidence package 1개(새 경로 미동작이면 **레거시 b의 진전 run evidence라도**). "동작 증거 0"이 최대 감점.
- README=논문(thesis+아키텍처+evidence 서사) / 재현성(ROM 계약·`--script` 함정·`pnpm`·.env.example) / 엔지니어링 트레일(이슈·#4 코멘트·debug_notes=강점이니 드러내기) / 테스트 133 명시 / **honest limitations 섹션**.
- ⚠️ 공개 전 **secrets·개인경로 스캔, ROM .gitignore, remote가 공개용 nori 레포인지** 확인.

> **전체 최종 계획·우선순위·실행순서·DoD는 `FINAL_PLAN.md` 참조.** (A→B→C→D, 한 세션 한 트랙)

## 7. 실행/검증 명령 (단독, c 기준)
```bash
# (에뮬+브리지는 §3.1로 띄우고 GUI Lua 로드 후)
cd ~/Desktop/pss-mgba-runs/c && EMULATOR_FPS=240 ~/Desktop/pss-mgba/node_modules/.bin/tsx ~/Desktop/pss-mgba/src/episode-main.ts > logs/episode.log 2>&1 &
# 진행 확인(핵심): 2 이상이면 성공
wc -l ~/Desktop/pss-mgba-runs/c/runs/run_*_episode/agent_steps.jsonl
```
정적 검증: `cd ~/Desktop/pss-mgba && pnpm typecheck && pnpm check:session-authority && pnpm test`

---

## 8. 봐야 할 파일
- `src/episode-main.ts` — **버그 위치.** `createEpisodeAgentRunFactory`, `[episode-main debug]` 로그.
- `src/index.ts` (~31~160) — **동작하는 레거시 기준** (hooks beforeTurn+afterStep, `streamSupervisedRun`).
- `src/evaluation/episode-runner.ts` — `run()` 루프.
- `src/agent/command-agent-runner.ts` — `run.stream()` 소비.
- `src/game/map-memory.ts`, `src/pokemon-state.ts`, `src/observation.ts` — **RAM 파싱+마스킹(B) 작업 대상.**
- `.local-tools/mgba-http/mGBASocketServer.lua` — 소켓 명령(readRange/read8/screenshot).
- `logs/debug_notes.md` + GitHub #4 코멘트 — 3라운드 기록.

---

## 9. 현재 살아있는 상태 (핸드오프 작성 시점)
- **b 레거시 하네스 가동 중**(정상). a도 다른 세션에서 가동 중일 수 있음.
- **c의 mGBA+브리지(8890/5003) idle로 떠 있을 수 있음** — 다음 세션이 c 디버그면 재사용, 아니면 `runs/c/logs/`의 mgba/mgba-http pid 정지.
- c episode-main 프로세스는 정지됨.

> **핵심:** 코드·유닛 133개 통과. 막힌 건 **새 entry의 라이브 모델호출 한 군데**. (A) 실제 요청을 캡처해 b와 비교 + (B) RAM 메모리맵 파싱·마스킹으로 관측을 결정론화(이미지 우회 겸).
