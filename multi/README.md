# 여러 전략 동시 실행 (multi)

<!-- DOC-SYNC: 2026-07-15 확인 — 아래 예시와 `multi/lib.sh`의 `REPO="$HOME/Desktop/pss-mgba"`는 이 저장소의 옛 경로/이름을 하드코딩하고 있음. 현재 클론 경로는 `/Users/leesangmin/Projects/pokemon-agent-os`(GitHub 원격도 `nori00000/pokemon-agent-os`)이고 `~/Desktop/pss-mgba`는 이 머신에 존재하지 않음(MISSING_SOURCE). `multi/setup.sh|start.sh|stop.sh`를 실제로 쓰려면 `multi/lib.sh`의 `REPO`를 현재 클론 경로로 고치거나 스크립트 위치 기준 상대경로로 바꿔야 함 — 어느 쪽이 맞는지는 사용자 판단 필요해 코드 자동수정은 보류. -->

같은 모델로 **서로 다른 전략 프롬프트 3개**를 각각의 에뮬레이터에서 동시에
돌려 비교하기 위한 도구 모음입니다.

원본 하네스는 "에뮬레이터 1대만"을 전제로 포트·세이브·기록 경로가 전부
고정돼 있어서, 한 폴더에서 그냥 3번 띄우면 서로 충돌합니다. 이 `multi/`는
인스턴스마다 **독립된 작업 폴더 + 독립 포트 세트**를 만들어 충돌을 없앱니다.

## 구조 한눈에

인스턴스 하나 = 3단 체인입니다.

```
mGBA(에뮬레이터 창)  --소켓-->  mGBA-http(다리)  --HTTP-->  harness(AI 에이전트)
```

| 인스턴스 | 소켓 포트 | mGBA-http | 메트릭 | 작업 폴더 |
|---|---|---|---|---|
| a | 8888 | 5001 | 9464 | `~/Desktop/pss-mgba-runs/a` |
| b | 8889 | 5002 | 9465 | `~/Desktop/pss-mgba-runs/b` |
| c | 8890 | 5003 | 9466 | `~/Desktop/pss-mgba-runs/c` |

- 세 인스턴스는 **같은 AI 모델/프록시**(`~/Desktop/pss-mgba/.env`의 `AI_*`)를
  공유합니다. 다른 건 오직 `strategy.md`(전략 프롬프트)뿐입니다.
- 무거운 파일(110MB mGBA-http 바이너리)은 심볼릭 링크로 공유하고, 세이브와
  기록(`.pss-mgba/`)은 폴더별로 완전히 분리됩니다.
- 세 인스턴스 모두 **지금 세이브 체크포인트**(`pokemon-red.sav`)에서 똑같이
  출발한 뒤 전략에 따라 갈라집니다. (공정 비교)

## 사용법 (3단계)

### 1. 최초 1회 셋업

```bash
cd ~/Desktop/pss-mgba
chmod +x multi/setup.sh multi/start.sh multi/stop.sh   # 최초 1회만
multi/setup.sh
```

`~/Desktop/pss-mgba-runs/{a,b,c}` 폴더가 생기고, 각 폴더에 ROM·세이브·전략
파일·`.env`가 채워집니다. 출력 예시:

```
[a] scaffolding /Users/.../pss-mgba-runs/a  (socket 8888 / http 5001 / metrics 9464)
[b] scaffolding /Users/.../pss-mgba-runs/b  (socket 8889 / http 5002 / metrics 9465)
[c] scaffolding /Users/.../pss-mgba-runs/c  (socket 8890 / http 5003 / metrics 9466)
Done. Instances ready under /Users/.../pss-mgba-runs/{a,b,c}.
```

### 2. 전략 편집 (선택)

기본 전략은 a=스피드런 / b=탐험 / c=신중입니다. 바꾸려면 각 폴더의
`strategy.md`를 편집하세요. (셋업을 다시 돌려도 편집한 `strategy.md`는
덮어쓰지 않습니다.)

```bash
open ~/Desktop/pss-mgba-runs/a/strategy.md
```

### 3. 실행 / 정지

```bash
multi/start.sh all     # 기본 2개(a,b) 시작 (에뮬레이터 창 2개가 뜸)
multi/start.sh a       # 하나만 시작
multi/start.sh c       # (선택) 3번째도 추가로 시작
multi/stop.sh all      # 기본 2개 정지
multi/stop.sh b        # 하나만 정지
```

> 기본 동시 실행 개수는 16GB 메모리를 고려해 **2개(a,b)**입니다.
> `multi/start.sh c`로 3번째를 추가할 수 있고, 기본값은
> `multi/lib.sh`의 `INSTANCES="a b"`에서 바꿉니다.

진행 상황 보기:

```bash
tail -f ~/Desktop/pss-mgba-runs/a/logs/harness.log
```

각 인스턴스의 지표는 브라우저/포트로 확인:
`http://127.0.0.1:9464/metrics` (a), `:9465` (b), `:9466` (c).

## 다른 세션에서 각자 돌리기

각 인스턴스는 **폴더·포트·세이브·기록이 완전히 독립**이라, 서로 다른 터미널
이나 서로 다른 Claude Code 세션에서 하나씩 띄워도 충돌하지 않습니다. 이 대화의
맥락도 필요 없습니다 — 다른 세션은 그냥 이 레포의 `multi/` 스크립트만 쓰면
됩니다.

**처음 1회 (아무 세션에서나 한 번만)**:

```bash
cd ~/Desktop/pss-mgba && multi/setup.sh
```

**그 다음, 세션마다 하나씩**:

```bash
# 세션 1 (터미널 1 또는 Claude 세션 1)
cd ~/Desktop/pss-mgba && multi/start.sh a
tail -f ~/Desktop/pss-mgba-runs/a/logs/harness.log

# 세션 2 (터미널 2 또는 Claude 세션 2)
cd ~/Desktop/pss-mgba && multi/start.sh b
tail -f ~/Desktop/pss-mgba-runs/b/logs/harness.log
```

정지도 세션별로 독립:

```bash
multi/stop.sh a      # 세션 1에서 a만 정지
multi/stop.sh b      # 세션 2에서 b만 정지
```

포인트:
- `start.sh`는 `nohup`으로 띄우므로 **세션/터미널을 닫아도 인스턴스는 계속
  돕니다.** 멈추려면 반드시 `multi/stop.sh <id>`를 쓰세요.
- 어느 세션에서 시작했는지와 무관하게, 정지는 어느 세션에서든
  `multi/stop.sh a`로 가능합니다(PID가 `runs/a/logs/`에 저장됨).
- 다른 Claude 세션에게는 "`~/Desktop/pss-mgba/multi/README.md` 읽고 인스턴스
  b를 start 해줘"라고만 하면 됩니다.

## ⚠️ 메모리(16GB) 주의

이 노트북(m4-air, 16GB)에서 3개 동시 구동은 무겁습니다. 에뮬레이터 3 +
다리 3 + Node 하네스 3 + 동시에 로컬 AI 프록시(`127.0.0.1:8765`)로 3갈래
요청이 갑니다. 느리면 `multi/start.sh a b`처럼 2개만 돌리거나, m4-studio
(128GB)에서 돌리는 걸 권장합니다.

## 트러블슈팅

- **`mGBA socket on :8888 타임아웃`**: 에뮬레이터 창이 떴는지 확인.
  `~/Desktop/pss-mgba-runs/a/logs/mgba.log` 확인.
- **`mGBA-http on :5001 타임아웃`**: 포트가 이미 사용 중일 수 있음.
  `lsof -i :5001` 로 점유 프로세스 확인 후 `multi/stop.sh all`.
- **harness가 바로 죽음**: 로컬 AI 프록시(`127.0.0.1:8765`)가 떠 있는지
  확인. `~/Desktop/pss-mgba-runs/a/logs/harness.log`에 연결 오류가 보입니다.
- **세이브를 새로 시작하고 싶다**: 해당 폴더의 `pokemon-red.sav`를 지우거나
  `multi/setup.sh`를 다시 실행해 현재 체크포인트로 리셋.
- **완전 초기화**: `multi/stop.sh all` 후 `rm -rf ~/Desktop/pss-mgba-runs`,
  다시 `multi/setup.sh`.

## 동작 원리 (왜 이렇게 안전한가)

원본 코드의 `.env`와 `.pss-mgba/traces`는 **현재 작업 디렉토리(CWD) 기준**
상대 경로입니다. 그래서 각 하네스를 자기 폴더(`runs/a`, `runs/b`, `runs/c`)를
CWD로 두고 실행하면, env·기록·세이브가 코드 수정 없이 자동으로 분리됩니다.
mGBA-http는 자기 폴더의 `appsettings.json`(포트만 다름)을 읽고, mGBA는
포트가 박힌 자기 `mGBASocketServer.lua`를 로드합니다.

전략 주입은 원본에 작은 옵션 하나만 추가했습니다: `STRATEGY_PROMPT_FILE`
환경변수가 있으면 그 파일 내용을 기본 지시문 **뒤에** 덧붙입니다(안전·이동
규칙은 그대로 유지). 미설정 시 원본 단일 실행과 100% 동일합니다.
