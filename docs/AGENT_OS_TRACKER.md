# Pokemon Red Agent OS — 진행 추적 & 강화학습 루프 (RL loop)

> 목적(Purpose): 데이터·블로커·투두·다음액션을 한 곳에. 단계별로(step-by-step) 진행.
> 작업 머신: m4-air (16GB). 코드: `~/Desktop/pss-mgba/src/agent-os/`.
> 스펙(Spec): `~/Downloads/POKEMONDEV_AGENT_OS.md`.
<!-- DOC-SYNC: 2026-07-17 확인 — 위 "작업 머신"·경로는 이 파일 최초 작성 시점(m4-air, ~/Desktop/pss-mgba) 스냅샷. 현재 클론 경로는 `/Users/leesangmin/Projects/pokemon-agent-os`(호스트 `m4-studio`, 실측 `hostname -s`)이며 `~/Desktop/pss-mgba`는 이 머신에 없음(MISSING_SOURCE, multi/README.md의 기존 DOC-SYNC 주석과 동일 근거). 아래 §0 이하는 이슈 #14를 미러링하는 append-only 로그라 원문 보존, 헤더만 참고용으로 정정. -->

---

## 0. 한 줄 (TL;DR)

기존 LLM 하니스(`minpeter/pss-mgba`) 위에 **결정론적(deterministic) Agent OS 레이어**를 얹어, "LLM이 기억하는" 대신 "RAM=진실, 지식=외부화, 이동/복구=결정론" 구조로 포켓몬 레드를 Viridian City까지 안정적으로 도달시키는 프로젝트. **Phase 0(기반+테스트) 완료.** ~~라이브 입력 브리지 고장~~ → **해소됨(2026-06-06).**

## ⭐ 라이브 돌파 (BREAKTHROUGH, 2026-06-06)

- ✅ **입력 브리지 복구**: mGBA 클린 재시작 + lua 1회 로드(이중 로드 금지). 옛 하니스 종료 + 브리지 재시작.
- ✅ **오크 인트로 통과**: A로 대화 진행, **이름 입력 화면은 Start로 확정**(중요: dialog 핸들러는 이름화면에서 A가 아니라 Start). map 0→38.
- ✅ **이동 실증**: 오버월드 이동은 `tap`이 아니라 **`hold`**라야 걸음(코드 수정 완료: 방향=hold, A/B/Start=tap).
- ✅ **좌표계 일치 확인**: 라이브 calibration 결과 Up=Δy−1, Down=Δy+, Left=Δx−1, Right=Δx+ → `directionToTarget` 축 매핑과 정확히 일치.
- ✅ **결정론 에이전트 라이브 작동(LLM 미사용)**: 50스텝 만에 **침실(38)→1층(37)** 자율 이동(계단 워프), mission_02 완료→mission_03, 평가리포트 자동 생성, stuck 6회 정확 감지. 1층 현관 좌표 미보정으로 wall_loop → 다음 스텝은 좌표 보정.
- 가드레일 유지: typecheck/test 115/lint 전부 PASS.

### RL 루프 회전 기록 (iterations)

- **iter-1**: 침실(38)→1층(37) 성공. 1층 현관 미보정 → wall_loop. 진단: calibrate exit triggers.
- **보정**: 1층 문 워프 실측 = **REDS_HOUSE_1F (2,7)+Down → PALLET_TOWN (5,5)**. spatial_graph `calibrated:true`. 정밀도 버그 발견·수정: **hold 18→10 (1타일 정밀)**.
- **iter-2**: 팰릿(0)에서 재실행 → 팰릿↔집(37) **20회 왕복**, `failed_map_transition x10`. **근본원인: 스폰(5,5)이 집 현관 바로 아래라 "북쪽으로 Up" 단순 축이동이 집 문으로 직진→재입장 반복.** = **맵 내부 장애물 우회(intra-map obstacle avoidance) 부재** (BFS는 맵-간 경로만, 타일 충돌 회피 없음).
- **다음 선택지(NEXT, 사용자 결정)**:
  1. **웨이포인트 보강(quick)**: spatial_graph exit에 중간 안전타일(waypoints) 추가 → navigator가 집 문을 피해 우회. 맵별 수동이지만 빠름.
  2. **A* 충돌 경로탐색(real feature)**: 매 스텝 RAM에서 타일 충돌맵을 읽어 맵 내부 A* 경로탐색. 일반적·견고하지만 신규 모듈.
  3. **체크포인트**: 전 구간 실증 완료 상태로 일단 마감.

### iter-3 (A* 정석 구현, 2026-06-06)

- ✅ **A* 충돌 경로탐색 구현**: `pathfinder.ts`(OccupancyGrid + A*). **범프 학습**(이동실패→타일 blocked) + **원치않은-워프 학습**(의도 안한 맵 전환→출발타일 blocked). brain.navigate가 A* 우선 사용. 테스트 **118개** 통과, lint PASS.
- iter-3 라이브: 팰릿↔집 왕복 지속(stuck_events 10→1로 급감했지만 도달 X). **진단: 팰릿 북쪽 Route1 출구 좌표(seed 8,0)가 틀려 A*의 목표 자체가 오류** → 에이전트가 집 근처를 맴돔.
- 팰릿 출구 탐색: 상단 y=2까지만 도달, x=5~8 위는 나무벽. **스크린샷 확인 = 출구는 나무 울타리의 틈(플레이어 (5,2) 옆, x≈4 추정)**. (5,2) Up 막힘 → 다음 정확 보정: x=4 열에서 Up 시도해 map 0→12 전환 타일 확정.
- **다음 정확한 시작점(NEXT)**: 팰릿 (≈4, 1)에서 Up → map 0→ROUTE_1(12) 전환 좌표 실측 → spatial_graph PALLET_TOWN.north_exit + exit trigger 보정(calibrated:true) → `pnpm os` 재실행. 그 뒤 ROUTE_1 출구도 동일 방식 보정 → Viridian.
- **현 상태 요약**: 시스템(입력·이동·워프·A*·학습·로깅·평가·RL루프) 전부 실증 완료. Viridian까지는 **맵별 출구좌표 보정의 반복**만 남음(인프라는 완성).

### iter-4: 팰릿 출구 실측 (2026-06-06)

- 팰릿 상단 전수 조사: **x=1~9는 y=2에서 위 막힘(나무벽). x=10만 y=2→1 통과하나 (10,1)에서 위 막힘(막다른 틈)**. → 팰릿 walkable 상단 경계 = y=2, 예외 notch (10,1).
- **Route 1 출구를 top walk-off로 못 찾음** → seed (8,0)은 오류 확정. 블라인드 프로빙 수확체감.
- **권장 다음 경로**: 스펙 §7 권고대로 **pret/pokered 맵 헤더에서 Pallet→Route1 connection 좌표를 컴파일**(WebFetch github.com/pret/pokered, data/maps 또는 maps/PalletTown 헤더의 connection/warp). 블라인드 탐색보다 일반적·정확. 모든 맵 출구를 한 번에 확보 가능.
- 대안: 체계적 전수 탐색 도구(맵 경계 BFS 스캐너)를 calibration 모드에 추가.

### iter-5: 🎯 돌파 — "출구 미발견"의 진짜 원인 = 스토리 게이트 (2026-06-06)

- **flood-fill 스캐너 구현**: `scanner.ts`(OccupancyGrid+A* 재사용, frontier 순회, 전환 시 출구 기록 후 복귀, 알려진 warp pre-block). `pnpm os:scan`. 테스트 118 통과.
- 스캐너가 walkable=1로 즉시 종료 → 디버깅 중 **결정적 발견**: 플레이어가 (10,1)에서 입력이 전혀 안 먹음. **스크린샷 = "OAK: It's unsafe! Wild POKéMON live..."** = 그 유명한 **오크 박사 정지 이벤트**.
- **진실**: 내가 못 찾던 "팰릿 Route1 출구"는 좌표 문제가 아니라 **게임의 스토리 게이트**였음. 북쪽 도로 **x=10이 맞음**. 단 **스타터 포켓몬 없이 북쪽으로 가면 오크가 막고 연구소로 끌고 감**. (10,1)에서 에이전트/스캐너가 "갇힌" 진짜 이유 = 이 대화창이 떠서 이동 프리즈.
- **라이브 진행**: A 연타로 오크 이벤트 진행 → 플레이어가 (10,1)→(9,11)→**연구소(map 40) 진입** → "There are 3 POKéMON here!" **스타터 선택 화면 도달**.
- spatial_graph 정정: PALLET north_exit (10,0), 스토리 게이트 명시.
- **올바른 경로 확정**: leave house → 북쪽(x=10) → 오크 정지 → 연구소(40) → **스타터 선택** → 라이벌 배틀 → Route1(x=10) → Viridian. (mission_graph는 이미 oak_event/starter_selection 보유 — MVP 미션이 이를 건너뛴 게 문제였음.)
- **부수 학습**: 방향키 첫 입력은 "회전"만(이동X) — bump 학습이 이를 막힘으로 오판하면 안 됨(scanner는 facing 인지 재시도로 처리, runner도 동일 적용 필요). dialog 핸들러는 이벤트 대화를 A로 진행해야 함.

### iter-6: 🐢 스타터 SQUIRTLE 획득 (2026-06-06)

- 오크 연구소(map 40)에서 **스타터 선택 라이브 수행**. pret OaksLab objects로 공 좌표 실측: **Charmander (6,3) 좌 · Squirtle (7,3) 중앙 · Bulbasaur (8,3) 우** (흔한 "오른쪽=스쿼틀" 통념은 틀림 — pret가 잘못된 선택을 막음).
- 시퀀스: 오크 긴 연설 A로 진행 → "Now AAAA, which?" → 조작권 → (7,4)로 이동(스쿼틀 공 아래) → A → "SQUIRTLE/TINYTURTLE No.007" 도감 확인 → YES → **"AAAA received a SQUIRTLE!"**. **검증: party_count(0xD163)=1, species1(0xD164)=177(=Squirtle 내부인덱스)**.
- 라이벌(Blue)이 Bulbasaur 선택. 플레이어 (7,5)까지 내려감, 라이벌이 (7,6)에서 길막음.
- **다음**: 라이벌 배틀(연구소 출구 트리거 타일 접근 — 라이벌 우회 필요) → mash-A 배틀(Squirtle Tackle) → 연구소 나가기 → 팰릿 북쪽(x=10) Route1 (이제 게이트 해제됨) → Route1 종단 → **Viridian**.
- RAM 주소 추가 확보: party_count=0xD163, party_species1=0xD164, level1=0xD18C, curHP1=0xD16D, enemyHP=0xCFE7, battle_flag=0xD057(=2 트레이너 배틀).
- **🏆 라이벌 배틀 승리**: 연구소 출구 접근 시 라이벌 "Wait!" → 트레이너 배틀(Bulbasaur Lv5) 발동. **함정 발견: mash-A가 Tackle 대신 Tail Whip을 골라 데미지 0** → 적 HP를 RAM(0xCFE7)으로 직접 모니터해보니 실제론 깎이고 있었음(초록 HP바 렌더링이 만땅처럼 보임). Squirtle Tackle로 Bulbasaur KO(enemyHP=0), **Squirtle Lv5→Lv6**(maxHP 20→22), 라이벌 "WHAT? Unbelievable!" → battle=0 복귀. **스타터 스토리 게이트 완전 통과.** 이제 팰릿 북쪽 x=10 Route1 통로 열림.
- **배틀 정책 개선점**: mash-A는 비신뢰(HP바 오인·Tail Whip 선택) → 배틀 에이전트는 적 HP(0xCFE7)·내 HP(0xD16D)를 RAM으로 읽고 데미지 무브를 명시 선택해야 함.

### iter-7: 랩→팰릿→Route1 자동화 + Route1 등반 (2026-06-06)

- **코드 수정 2건**(요청): (1) `learnOccupancy` unwanted-warp 블로킹을 null-map 가드 앞으로 이동(미등록 맵 워프도 출발타일 학습). (2) spatial_graph에 **OAKS_LAB 노드**(map40, 팰릿 복귀 warp (4,11)→(12,12)) + mission `mission_06b_leave_oaks_lab`. 테스트 132 통과.
- **효과 실증**: 에이전트가 **랩(40)→팰릿(0) 자동 탈출**, 랩 재입장 177→6회로 급감, **Route1(12) 자동 진입**(팰릿 x=10 도로). 두 수정 모두 작동.
- **Route1 미로 등반**: 수동 측면스윕 클라이머로 **y=28→20 북상**(약 1/4 등반). Route1은 **지그재그 절벽(ledge) 미로** — 각 "선반"마다 북상 갭이 다른 x에 있음. 우측에 갭 多. 고정바이어스 클라이머·A*(북출구 seed (5,0) 미보정) 둘 다 각 선반서 막힘.
- **현재 위치**: ROUTE_1 (4,20). Viridian은 y≈0(상단). 약 20타일 더 등반 필요.
- **Viridian 도달 다음 단계(NEXT)**: Route1 전용 **스캐너 보정**(`pnpm os:scan` in Route1) — 전체 미로 flood-fill로 walkable 타일·진짜 Viridian 북출구 좌표 발견 → spatial_graph 갱신 → 에이전트가 A*로 미로 완주. (단 Route1 풀숲 야생배틀 처리 + 큰 맵이라 스캔 시간 큼.) 또는 pret Route1 .blk/connection 데이터로 북출구 좌표 직접 보정.
- **배틀 정책 추가 개선**: Route1 야생배틀은 RUN(메뉴 RUN 선택)이 빠름 — 배틀 에이전트에 wild(D057=1)면 RUN, trainer(=2)면 fight 분기 권장.

### 🧭 계획 변경(2026-06-06): RAM 메모리맵 파싱 → walkability 마스크 → A* (정석 내비)

**문제**: 범프(bump) 학습은 벽을 한 칸씩 부딪혀 발견 → 느리고, 매 실행 grid 리셋으로 재탐색, **미로(Route1 지그재그 절벽)에서 갇힘**(실증: y28→14에서 정체). A*의 목표좌표도 미보정이면 무의미.

**해법**: 매 스텝 **RAM에서 실제 타일/충돌맵을 읽어 walkability 마스크**를 만들고 OccupancyGrid에 **선반영(pre-seed)** → A*가 첫 시도에 정확한 경로 산출(부딪힐 필요 없음).

**Pokémon Red RAM 소스**:
- `wCurMapTileset` = **0xD367** (현재 타일셋 id).
- `wTileMap` = **0xC3A0** (화면 20×18=360바이트 타일 id; 플레이어 중심 슬라이딩 윈도우).
- 타일셋별 **walkable 타일 리스트**: pret `data/tilesets/*_collision.asm`에서 컴파일(타일셋별 통행가능 tile id 집합).
- 지형 보조: 풀숲(야생인카운터) 타일, **ledge(한방향 절벽)** = 일방향 엣지로 특수처리.

**파이프라인(매 스텝)**:
1. `wCurMapTileset` + `wTileMap` 읽기 → 화면 타일 id 그리드.
2. 각 타일: walkable = (tile id ∈ 타일셋 collision 리스트) → mask.
3. 화면좌표 → 맵좌표(플레이어 x/y + 스크롤 오프셋) 변환.
4. OccupancyGrid에 free/blocked로 마스킹(부딪히기 전에 미리).
5. A*가 실제 충돌맵 위에서 경로 산출 → 미로 정확 통과. 맵별 마스크 영속화.

**구현 위치**: 신규 `src/agent-os/memory-map.ts` (RAM 타일 읽기 + 타일셋 collision 테이블 + 마스크 빌더), os-runner의 runStep에서 매 스텝 OccupancyGrid에 마스크 적용. `mgba-http`의 `read8` 반복 또는 `read range`(/core/readrange) 활용.

**효과**: Route1(및 전 맵) 미로를 정확히 통과 → Viridian 자동 도달. 범프학습은 폴백/검증용으로 유지.

**현재 등반 상태**: Route1 (10,14), y28→14 도달. 메모리맵 마스킹 도입 시 여기서 막힌 y=14 선반의 갭을 RAM으로 즉시 파악해 통과 가능.

---

<!-- DOC-SYNC: 2026-07-14 확인 — 아래 §1~§4("실측 데이터"·"블로커 #1: 입력 브리지 미적용/오크 인트로 정지"·TODO의 "오크 인트로 통과"·"좌표 보정" 미체크)는 위 iter-1~iter-7(2026-06-06) 돌파 이전 시점의 스냅샷으로 보이며, 이후 이터레이션(입력 브리지 복구·오크 통과·스타터 획득·좌표 보정 완료)과 내용이 어긋난다. 이슈 #14를 그대로 미러링한 append-only 로그라 원문은 보존하고, 최신 상태는 위 "⭐ 라이브 돌파" 절과 루트 README §Deterministic Agent OS Layer를 따를 것. 단 §3의 ISSUE #2~#4(동시 실행 충돌, `multi/start.sh`의 `--script` 의존, Agent OS의 cwd 의존)는 재확인 결과 코드상 여전히 유효(`multi/start.sh:24`에 `--script` 잔존 확인). -->

## 1. 진행 상황 (Progress) — DONE ✅

- **Phase 0 기반 빌드 완료** (`src/agent-os/`):
  - `game-state.ts` — RAM 관찰 → `GameState` 정규화 + 가중치 stuck_score(spec §12) + 실패분류.
  - `knowledge.ts` — spatial/mission/failure JSON 로더 + BFS 라우팅(`findMapRoute`, `nextExitToward`, `directionToTarget`).
  - `brain.ts` — 결정론적 Coordinator `decide()` → Navigation/Recovery/Battle/Dialog/Menu (spec §15.1, LLM 미사용).
  - `io.ts` — runtime_state.json writer, agent_steps.jsonl logger, progress_score(§17), evaluation report(§19).
  - `os-runner.ts` — 라이브 루프 `runDeterministic` + `runCalibration`(보정 모드).
  - 데이터: `knowledge/spatial_graph.json`, `mission_graph.json`, `failure_dex.json`, `checkpoints/manifest.json`.
  - 테스트: `tests/agent-os/agent-os.test.ts`.
- **가드레일 전부 통과 (verified)**: `typecheck` PASS / `test` 115 passed / `build` PASS / `lint(agent-os)` PASS.
- **실행 스크립트**: `pnpm os`, `pnpm os:calibrate`.
- **라이브 체인 도달 확인**: mGBA-http 5001 응답, `getgametitle=POKEMON RED`.

## 2. 실측 데이터 (Data / findings)

| 항목 | 값 | 근거 |
|---|---|---|
| 현재 맵 | 38 = REDS_HOUSE_2F | RAM 0xD35E |
| 좌표 | x=3, y=6 (D362/D361) | RAM read |
| 화면 상태 | **오크 박사 인트로** "POKéMON legend is about to unfold!" | 스크린샷 /tmp/pkmn_shot.png |
| 확인된 맵ID | PALLET_TOWN=0, REDS_HOUSE_2F=38 | 트레이스 + 라이브 |
| 프레임 | 진행 중(에뮬 정상) | currentframe 290336→290399 |
| 입력 도달 | mGBA-http까지 OK(`getall`=Up) | curl |
| 입력 적용 | **게임 코어에 적용 안 됨** (facing 안 바뀜) | hold/tap 후 facing=0 불변 |

## 3. 🔴 블로커 & 이슈 (Blockers / Issues)

- **BLOCKER #1 — 입력 브리지(input bridge) 미적용**: mGBA-http가 버튼을 받지만(getall 확인) **게임 코어에 주입 안 됨**. 게임이 오크 인트로에서 정지. 옛 하니스도 83분간 같은 화면에서 멈춤 = 동일 원인. RAM 읽기는 정상 → lua 소켓은 살아있으나 **입력 적용 콜백이 비활성**으로 추정.
  - 원인 후보: mGBA 0.10.5는 `--script` CLI 미지원 → lua를 **GUI(Tools→Scripting)에서 수동 로드**해야 함. 자동 로드 실패 시 입력 안 먹음.
- **ISSUE #2 — 동시 실행 충돌(concurrency)**: 옛 `pnpm dev`(PID 64505) + `tsx src/index.ts`가 인스턴스 a 포트(5001/8888)에서 계속 도는 중. `multi/` 인스턴스 격리로 해결 설계됨.
- **ISSUE #3 — `multi/start.sh`의 `--script` 의존**: line 24가 `mgba --script`를 쓰는데 0.10.5엔 그 옵션이 없어 b의 소켓(8889)이 안 열릴 위험. → 수동 lua 로드 또는 스크립트 수정 필요.
- **ISSUE #4 — Agent OS의 cwd 의존**: `src/agent-os`는 cwd의 `knowledge/`를 읽음. multi 인스턴스 폴더(`runs/b`)에서 돌리려면 knowledge 복사 또는 경로를 repo 루트 기준으로 수정 필요.

## 4. ✅ 투두 리스트 (TODO)

- [x] Phase 0 Agent OS 기반 + 테스트(115) + 가드레일
- [x] 보정 모드(calibration) 구현 + 라이브 체인 도달 확인
- [ ] **BLOCKER: 입력 브리지 복구** — 각 인스턴스 mGBA 창에서 Tools→Scripting으로 `mGBASocketServer.lua` 수동 로드 → tap 시 facing 변하는지 검증 (사용자 GUI 액션 필요)
- [ ] 오크 인트로 통과(A 연타) → 플레이어 조작권 확보
- [ ] 좌표 보정(`pnpm os:calibrate`) — button→Δxy 검증, 실제 출구 좌표 수집 → `spatial_graph.json` `calibrated:true`
- [ ] Agent OS를 multi의 한 "정책(policy)"으로 연결 (cwd/knowledge 경로 처리)
- [ ] 1라운드 에피소드: a(LLM)·b(LLM/OS) 동시 실행 → 메트릭 비교
- [ ] RL 루프 1회전: 평가 → 진단 → 정책/지식 갱신 → 반복
- [ ] (Deferred) 배틀정책 고도화(party/move RAM), save-state 트리, Critic 에이전트

## 5. 🔁 강화학습 루프 설계 (RL loop design)

고전적 gradient RL(가중치 학습)이 아니라, **에피소드 기반 정책-반복 + 구조화 메모리 개선**(evolutionary policy search) 루프. 매핑:

| RL 개념 | 이 프로젝트에서 |
|---|---|
| Environment | mGBA의 포켓몬 레드 (RAM=관찰, 버튼=행동) |
| State/관찰 | `GameState` (map,x,y,mode,battle/dialog/menu) — 작게 유지 |
| Action | 8버튼 (Up/Down/Left/Right/A/B/Start/Select) |
| Reward/Return | `progress_score`(§17)=mission_index×100 + map_transitions×10 + unique_coords×0.1 − stuck×5 − recovery_fail×10. (희소 마일스톤 + 조밀 탐험 shaping) |
| Policy π | ① 결정론 Agent OS(`brain.decide`) ② LLM 전략(a=스피드런/b=탐험/c=신중, `strategy.md`) |
| Episode | 세이브 체크포인트→종료(Viridian 도달/최대스텝/사망), `agent_steps.jsonl`+evaluation_report로 기록 |

**루프 (improvement cycle):**
1. **Rollout**: N개 에피소드 실행 (multi 인스턴스 a/b/c = 정책 공간 병렬 탐험).
2. **Evaluate**: progress_score, time_to_viridian, stuck_events, dominant failure_type 비교.
3. **Diagnose (credit assignment)**: stuck_score + failure_dex로 **어디서·왜** 실패했는지 국소화.
4. **Update**: 지식 보정(좌표), 정책 조정(strategy.md/brain 규칙), recovery 트리 개선. 최고 정책의 체크포인트가 다음 라운드 시드.
5. **Repeat** + 매 라운드 메트릭을 이 이슈에 누적.

**탐험 vs 활용**: multi 병렬 = 전략공간 탐험, 최고 유지·나머지 변이(evolutionary).

## 6. ➡️ 다음 액션 (Next actions, 우선순위 순)

1. **입력 브리지 복구 (사용자 + 나 협업)**: b 인스턴스 mGBA 창에서 Tools→Scripting → `dofile(".../runs/b/mGBASocketServer.lua")` 로드. 그 후 내가 `tap` 1회 → facing 변화 검증.
2. 검증되면: 오크 인트로 통과 → `pnpm os:calibrate`(cwd=runs/b) → 좌표 보정.
3. Agent OS를 b의 정책으로 연결, 첫 에피소드 실행, evaluation_report 비교.
4. 결과를 이 이슈 코멘트로 누적, RL 루프 2회전.

---
🤖 작성: Claude Code (Agent OS 빌드 세션). 인스턴스 담당: **b** (a는 다른 세션).
