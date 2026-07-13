# Pokemon Agent OS — 최종 계획 (2026-06-06)

> 전체 코드·계획 리뷰 종합. 운영 핸드오프는 `HANDOFF_NEXT_SESSION.md`, 마일스톤은 GitHub `nori00000/pokemon-agent-os` #1~#13.
> **메모리 제약: m4-air 16GB → 한 세션에 인스턴스 하나만. 트랙도 한 번에 하나씩.**

## 0. 도메인 표준 키워드 3개 (착수 전 명명 — 이게 품질을 가른다)
1. **Potential-based reward shaping** (Ng 1999) — 밀집 보상을 farm 불가능하게 만드는 정석.
2. **Go-Explore / frontier 기반 탐색** — 국소 basin 탈출(경계 복귀 후 탐색)의 정석.
3. **Population-Based Training + Quality-Diversity(MAP-Elites)** — 연합(a/b/c) 다양성으로 국소최적 탈출.
> (하네스 축: "evidence-driven failure→issue→policy loop". 평가 축: "reproducible evidence package".)

---

## 1. 한 줄 진단 (현재 상태)
LLM-as-constrained-proposer + harness-as-player 구조로 **코드·유닛 133개는 통과**. 그러나 ① 새 entry가 **라이브에서 step1 hang**, ② **정책 루프가 안 닫힘**(증거수집만, 피드백 없음), ③ **reward가 farmable**(지엽 최적화 유발), ④ **공개레포/AI평가 대비 미정비**. 레거시(b)는 정상 동작.

---

## 2. 리뷰 핵심 결함 (코드 실측 근거)

| # | 결함 | 근거 | 영향 |
|---|---|---|---|
| R1 | episode-main 라이브 hang (step1) | `runs/c/.../agent_steps.jsonl` 1줄, `:8000` 무응답 | **새 경로 end-to-end 0회 성공** |
| R2 | 정책 루프 개방(인-런) | `supervisor` hint를 `episode-runner.ts:263`에서 로그만, `#chooseCommands`에 forbidden 미주입 | 학습 신호가 행동에 반영 안 됨 |
| R3 | 정책 루프 개방(크로스-런) | `src/github/` 없음, failure→issue→PR 미구현, `memory/policies`·`failure_dex.json` 없음 | 런 간 학습 0 |
| R4 | reward farmable | `reward.ts`: 이동마다 +0.4, potential/novelty/micro-goal 진전 보상 없음 | 지엽 최적화·reward hacking |
| R5 | goal이 문자열뿐 | `run-config.ts:26` `goal:"reach_viridian_city"`, micro-goal 사다리 미연결 | 전역 목표가 보상/성공조건에 안 들어감 |
| R6 | MapMemory 미급전 | `map-memory.ts`는 자료구조만, RAM 피더 없음 | walkability/A* 못 삶 |
| R7 | 분류 1종 | `supervisor.ts` wall_loop만, should_create_*=false 하드코딩 | 실패유형·트리거 빈약 |

---

## 3. 4개 트랙 (의존순서 = A → B → C, D는 병행/마감)

### (A) 라이브 hang 해소 — **최우선·차단요인**
모든 라이브 검증의 전제. 추측 정렬 3회 실패 → **실제 요청 본문 계측**.
- `[episode-main debug]` 로그가 왜 안 찍히는지부터(steer 도달 여부) → b의 동작 요청 vs c 요청 **본문 비교**(이미지 인코딩/메시지 순서/tools 직렬화) → `afterStep` 부재/세션명/stream 소비 방식 검증.
- 성공 기준: c 단독 실행 시 `agent_steps.jsonl` ≥2줄 + transitions/reward 기록.
- (상세: HANDOFF §6)

### (B) RAM 메모리맵 파싱 + 마스킹 — **토대**
스크린샷 의존을 줄이고 결정론 관측. R6 해소 + A의 우회 검증 겸.
- `map-memory.ts`에 RAM 타일맵(20×18, 2×2 블록) 파서 급전 → walkabilityGrid 실가동.
- 모드 판정 결정론화: dialog `rWY<144`(종료 `≥144`×2), `wIsInBattle`, 메뉴.
- ObservationBuilder에 **마스킹/구조화 옵션**(walkability grid+좌표+모드를 텍스트/오버레이로). 이미지 축소 시 A의 페이로드-hang도 검증.
- (상세: HANDOFF §6.5)

### (C) 정책 루프 닫기 + anti-local-optima — **핵심 가치**
R2·R3·R4·R5·R7 해소. **설계 원칙(§4)을 반드시 기준으로.**
1. **인-런 피드백**: supervisor hint의 `forbidden_actions`/`recommended_macro_action`을 `#chooseCommands` context→에이전트 프롬프트/툴게이팅에 주입. (#5)
2. **목표 레벨 에스컬레이션**: L1 forbidden → L2 lateral/backtrack → **L3 서브골 재선택**(K회 패치해도 매크로 Δ=0이면 강제). (`ouroboros-drift` 스킬 패턴)
3. **크로스-런**: `src/github/issue_workflow.ts`(failure→#코멘트→`suggested_policy_patch.md`) + PR steering. 코드 repo=minpeter라 **PR 대신 nori 이슈+패치파일**. (#6/#7)
4. **정책 영속**: `memory/failure_dex.json`·`memory/policies/`에 학습 forbidden/recovery 저장→다음 런 로드. (#10/#11)
5. **분류 확장**: dialog/menu/failed_map_transition + 임계/연속횟수. (#5)

### (D) 공개 레포 업로드 + AI 평가 대비 — **마감·병행**
교훈 "점수≠코드"(oba-hackathon). 실질 강점을 드러내고 실질 갭을 메운다(score theater 금지).
- **(필수) 최소 1개 재현 가능한 working run + evidence package**: 현재 새 경로 미동작 → **최소한 레거시(b)로라도 비리디안 진전 run의 evidence(스크린샷·transitions·summary)** 를 repo에 포함. "동작 증거 0"이 가장 큰 감점.
- **README = 논문**: 한 줄 thesis("LLM은 플레이어가 아니다, 하네스가 플레이어") + 아키텍처 다이어그램(7컴포넌트+루프) + **evidence/loop가 핵심 서사**.
- **재현성**: ROM 합법 보유 계약, `--script` 함정·기동 절차, `pnpm` 명령, .env.example.
- **엔지니어링 트레일 = 강점**: 이슈 #1~#13 + #4의 3라운드 root-cause 코멘트 + `debug_notes.md`(정직한 실패→수정) = AI 평가에 강한 신호. 숨기지 말고 **드러내기**.
- **테스트 133개**·typecheck·authority guard = 품질 신호로 README에 명시.
- **honest limitations 섹션**: 라이브 hang·정책루프 미완을 솔직히 + 다음 단계. (정직성은 AI 평가에 가점)
- ⚠️ 공개 전 **secrets/경로/개인정보 스캔**, ROM 미포함(.gitignore) 확인, remote가 minpeter가 아니라 **공개용 nori 레포**인지 확인.

---

## 4. ★Anti-Local-Optima 설계 원칙★ (C·D 작업의 기준)
> 지엽 최적화 = proxy(밀집보상·마지막실패제거·인스턴스별 reward)와 진짜 목표(희소·전역 비리디안)의 분리.

1. **희소 주축 + farm-불가 보조**: 진짜 목적함수 = 도달한 **최고 micro-goal/맵**(희소·단조). dense는 **potential shaping**만(Φ=−서브골거리, reward+=γΦ'−Φ → 배회 합=0) + **count-based novelty**(map+좌표 방문수로 감쇠). → 현 `reward.ts`의 +0.4/이동 farm 차단.
2. **정체 시 목표 레벨로 에스컬레이트**: 국소 패치(forbidden)에 **상한**. K회 패치·매크로 Δ=0 → 서브골 재선택(L3). 무한 국소 패치 금지.
3. **frontier 탐색(Go-Explore)**: 최원거리 frontier 상태 기억→"복귀 후 탐색". stuck_score↑ 시 매크로-액션 temperature/ε↑(정체 시 탐색↑).
4. **연합은 평균 말고 다양성**: a/b/c 선택기준 = **전역 진전(furthest)**, 국소 reward 아님. **정책 averaging 금지**(basin 붕괴). 공유는 **정책이 아니라 증거**(failure_dex + frontier). 꼴찌를 1등 frontier에서 **재시드**(PBT). 행동 아카이브 커버리지(MAP-Elites) 최적화.
5. **크로스-런 트리거 = 매크로 정체**: PR/정책패치는 "같은 실패 ≥2"가 아니라 **"N 에피소드 최고 micro-goal Δ=0"** 에 묶기. (전역 멈춤인데 국소 실패만 고치는 함정 차단)
6. **토대=결정론 관측(B)**: 인식 노이즈 위 보상은 헛것 최적화. RAM 결정론 좌표/맵 위에서 reward·novelty·진전 계산.

---

## 5. 권장 실행 순서 (한 세션 = 한 트랙)
1. **세션 1 — (A)**: 라이브 hang 잡기(요청 캡처). **차단요인이라 최우선.** 안 풀리면 (B)의 이미지 축소로 우회 시도.
2. **세션 2 — (B)**: RAM 파서 급전 → MapMemory/walkability 실가동 + 마스킹 관측.
3. **세션 3 — (C)**: 정책 루프 닫기, **§4 원칙 적용**(potential reward + micro-goal 주축 + 인-런 forbidden 주입 + failure_dex 영속).
4. **세션 4 — (C 연합/크로스-런)**: issue_workflow + PR steering(매크로 정체 트리거) + 인스턴스 간 frontier/failure_dex 공유.
5. **세션 5 — (D)**: 공개레포 정비(README/evidence/limitations/secrets 스캔) → AI 평가 제출.
> 각 트랙 끝에 GitHub 해당 이슈에 evidence 코멘트 + `debug_notes.md` 갱신(평가 트레일로도 쓰임).

---

## 6. 성공 기준 (Definition of Done, 갱신)
- (A) c가 step≥2 진행, transitions/reward 기록.
- (B) walkabilityGrid가 실제 RAM에서 생성, 마스킹 관측 동작.
- (C) forbidden_actions가 다음 행동에 반영(인-런 폐쇄) + failure_dex 영속(크로스-런 폐쇄) + reward가 potential/novelty/micro-goal 기반(farm 불가).
- (C-연합) 인스턴스가 전역 진전 기준 선택·frontier 공유·재시드.
- (D) 재현 가능한 working evidence package + thesis 명확 README + honest limitations + secrets 클린.
- **전역**: 최소 1회 비리디안 방향 매크로 진전이 evidence로 증명.
