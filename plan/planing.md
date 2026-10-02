# 작업-모듈 배치 시뮬레이터 기획서 (AI 구현 지침)

> 이 문서는 AI가 시뮬레이터를 구현할 때 따르는 **기준 문서**다.
> 구현 중 이 문서와 다르게 해야 할 이유가 생기면 임의로 바꾸지 말고 사용자에게 먼저 확인한다.
> "미결정 사항"(§9)은 기본값으로 구현하되 설정으로 바꿀 수 있게 만든다.

---

## 1. 목표

- **모듈**(네모)과 **작업**(원)으로 이루어진 시스템을 화면에서 볼 수 있게 시뮬레이션한다.
- 사용자는 **감독관**이 되어 작업을 모듈에 배치하고 옮기며, 완료된 작업 수를 확인한다.
- 나중에는 감독관의 판단을 **알고리즘(정책)으로 바꿔 끼워** 사람과 알고리즘, 또는 알고리즘끼리 성능을 비교할 수 있어야 한다. 이것이 이 시뮬레이터로 "새 CS 기법"을 테스트하는 방식이다.

## 2. 도메인 규칙

### 2.1 용어

| 용어 | 화면 표현 | 설명 |
|---|---|---|
| 모듈 (Module) | 네모 상자 | 작업을 처리해서 **자기 고유의 결과**를 작업에 부여한다. 모듈마다 처리 시간이 다르다. |
| 작업 (Job) | 원 | 목표 결과 집합을 가진다. 목표 결과를 모두 얻으면 완료된다. |
| 결과 (Result) | 원 안 표시(색 조각/아이콘) | 모듈 하나가 하나의 결과 종류를 만든다. 결과 종류는 모듈 종류(type)로 식별한다. |
| 감독관 (Supervisor) | 사용자 또는 정책 | 작업을 모듈에 배치하거나 옮긴다. |
| 대기 구역 (Pool) | 화면 한쪽 영역 | 어느 모듈에도 배치되지 않은 작업이 머무는 곳 |

### 2.2 핵심 규칙

1. 작업이 모듈에 **도착**하면 그 모듈의 `processTime`만큼 처리된다.
2. 처리가 끝나면 작업은 그 모듈의 결과(`module.resultType`)를 **획득**한다.
3. 작업은 `required: Set<ResultType>`(목표 결과)과 `acquired: Set<ResultType>`(획득한 결과)를 가진다.
4. `required ⊆ acquired`가 되는 순간 작업은 **완료**된다. 화면에서 사라지고(페이드아웃) 완료 카운터가 1 증가한다.
5. 작업의 이동과 배치는 **감독관만** 할 수 있다. 작업이 스스로 다음 모듈로 가지 않는다.
6. **배치 판단은 감독관 책임이다(확정).** 엔진은 명령을 수행할 수 없는 경우(없는 작업·모듈, 완료된 작업, `cancelOnMove=false`일 때 처리 중 작업을 다른 곳으로 옮기기)만 거부한다. 비효율적이거나 무의미한 배치(대기열 상한 초과, 필요 없는·이미 얻은 결과, 같은 모듈 재배치)는 **수행하거나 무시하되 warning 이벤트만 남긴다.** 판정은 `rules.canAssign`/`assignAction`/`assignWarnings`에만 둔다.
7. **시각 기록 규칙(확정)**: step 하나는 구간 `[simTime, simTime + dt]`를 진행한다. 진행이 끝나서 생기는 사건(`processFinished`, `jobCompleted`, `completedAt`)은 **step이 끝난 뒤의 시각** `simTime + dt`로 기록한다. 예: 처리 시간 2인 작업을 t=0에 배치하면(dt=0.1) 처리 끝과 완료 시각은 2.0이다(부동소수 오차 수준). step 시작 시점의 사건(명령 적용, `jobSpawned`, `jobArrived`, `processStarted`, `processCancelled`, `warning`)은 `simTime`으로 기록한다. 이 계산은 `rules.stepEndTime`에만 두고, step 8단계의 `simTime` 갱신도 같은 함수를 쓴다.

### 2.3 작업 상태 머신

```
            assign            arrive           processTime 경과
  [POOL] ─────────▶ [MOVING] ───────▶ [PROCESSING] ─────────────▶ [DONE_AT_MODULE]
    ▲                                                                   │
    │                       move / unassign                             │ required ⊆ acquired
    └───────────────────────────────────────────────────────────────────┤
                                                                        ▼
                                                                  [COMPLETED] → 제거
```

- `MOVING`: 이동 애니메이션 중인 상태. 기본 이동 시간은 0이고 설정으로 바꿀 수 있다(§9).
  - **이동 시간 규칙(확정)**: 시각 `t0`에 배치하면 도착 시각은 `t0 + moveTime` 이상인 첫 step 시작 시각이다(dt 격자로 올림). 처리는 도착한 step부터 세므로 처리 완료 시각은 `도착 시각 + processTime`(≈ `t0 + moveTime + processTime`, dt 격자 오차 이내이고 체계적으로 짧아지지 않는다). 이동한 step에는 처리가 진행되지 않는다.
  - `moveTime = 0`이면 배치한 step에 바로 도착해 처리를 시작하고, 완료 시각은 `t0 + processTime`이다.
  - 예(dt = 0.1): `moveTime = 0.1`이면 `t0 + 0.1`에 도착, `moveTime = 0.25`면 `t0 + 0.3`에 도착한다.
- `DONE_AT_MODULE`: 처리는 끝났지만 아직 모듈 위에 있는 상태. 감독관이 옮기기 전까지 **모듈을 점유한다**(기본값, §9 참고).
- `PROCESSING` 중에 옮기면 처리가 **취소**되고 결과를 얻지 못한다(기본값).

### 2.4 모듈 규칙

- `capacity`: 동시에 처리할 수 있는 작업 수. 기본값은 1.
- **용량 N 모듈은 슬롯 N개가 각각 독립적으로 처리하는 병렬 모듈이다(확정).** 각 작업은 자기 `progress`로 `processTime`을 따로 세며, 다른 슬롯의 작업이 끝나기를 기다리지 않는다.
- 꽉 찬 모듈에 배치하면 **모듈 앞 대기열(queue)**에 들어간다. 대기열 길이 상한(`queueLimit`)은 설정 가능하고 기본값은 무제한이다.
- **대기열 상한은 경고 기준이다(확정).** 상한을 넘는 배치도 거부하지 않고 수행하며(대기열 끝에 줄 선다), warning 이벤트만 남긴다. 이동 중인 작업도 자리를 차지한 것으로 센다.
- **같은 모듈 재배치(확정)**: 작업이 이미 있는 모듈에 다시 `assign`하면
  - `DONE_AT_MODULE`: 거부하지 않고 다시 처리한다. 슬롯을 그대로 쓰므로 이동 없이 바로 `PROCESSING`이 되고 `progress`는 0부터 센다. 이미 가진 결과이면 중복 warning을 남긴다.
  - `MOVING`(같은 모듈로 이동 중) / `QUEUED` / `PROCESSING`: 바뀔 것이 없으므로 상태를 바꾸지 않고 "무의미한 명령" warning만 남긴다(거부가 아니다).
- 이동 중(`MOVING`) 작업을 `unassign`하면 이동 시간 없이 즉시 `POOL`로 돌아간다.
- 이미 얻은 결과를 다시 얻으려 하거나, 필요 없는 결과를 주는 모듈에 배치하는 것은 **허용**하되 경고 표시만 한다(시간 낭비도 평가 대상이기 때문).

## 3. 기술 스택

- **TypeScript + Vite**: 브라우저에서 실행하고 설치가 간단하다.
- **렌더링: HTML Canvas 2D**: 원과 사각형만 그리므로 라이브러리 없이 직접 그린다.
- **UI 패널: 순수 DOM**: 처음에는 프레임워크를 쓰지 않는다. 복잡해지면 그때 사용자와 상의한다.
- **테스트: Vitest**: 엔진 로직만 단위 테스트한다.
- 패키지 매니저: npm. 단, 명령은 **Makefile을 통해서만** 실행한다(`make help`). npm scripts와의 약속은 `AGENTS.md`에 있다.
- 화면 없는 실행(CLI): `tsx`

## 4. 아키텍처

**가장 중요한 원칙: 엔진과 화면을 완전히 분리한다.**

```
┌──────────────┐  Command[]   ┌────────────────┐  Snapshot/Event  ┌──────────────┐
│ Supervisor   │ ───────────▶ │ Engine (순수)   │ ───────────────▶ │ Renderer/UI  │
│ - Manual(UI) │ ◀─────────── │ - World state  │                  │ - Canvas     │
│ - Policy(알고)│   WorldView  │ - step(dt)     │                  │ - Panel/지표  │
└──────────────┘              └────────────────┘                  └──────────────┘
```

- **Engine**은 DOM, Canvas, `Date.now()`, `Math.random()`을 쓰지 않는다. 시간은 `simTime`으로만 다루고, 난수는 시드 기반 RNG만 쓴다. 따라서 같은 시나리오, 같은 시드, 같은 명령이면 **항상 같은 결과**가 나온다.
- 모든 상태 변경은 **Command**로만 일어난다. UI에서 드래그해도 결국 Command를 만들어 엔진에 넘긴다.
- Renderer는 엔진 상태를 **읽기만** 한다.

### 4.1 디렉터리 구조

```
sim/
├─ plan/planing.md          # 이 문서
├─ AGENTS.md / CLAUDE.md    # 에이전트 작업 지침 (CLAUDE.md는 AGENTS.md를 불러온다)
├─ Makefile                 # 모든 작업 명령의 진입점
├─ docs/GIT.md              # git 작업 규칙 (커밋, 푸시, make 타깃)
├─ index.html
├─ package.json / tsconfig.json / vite.config.ts
├─ src/
│  ├─ main.ts               # 조립: 엔진 + 감독관 + 렌더러 + 루프
│  ├─ engine/
│  │  ├─ types.ts           # Module, Job, Command, Event, WorldState 타입
│  │  ├─ world.ts           # createWorld(scenario), step(world, dt), apply(world, cmd)
│  │  ├─ rules.ts           # 상태 전이와 완료 판정
│  │  ├─ metrics.ts         # 지표 계산
│  │  └─ rng.ts             # 시드 RNG (mulberry32 등)
│  ├─ supervisor/
│  │  ├─ types.ts           # interface Supervisor { decide(view): Command[] }
│  │  ├─ manual.ts          # UI 입력을 Command로 바꾸는 감독관
│  │  └─ policies/
│  │     ├─ random.ts       # 기준선: 무작위 배치
│  │     └─ greedy.ts       # 예시: 필요한 결과를 주고 가장 빨리 비는 모듈에 배치
│  ├─ render/
│  │  ├─ canvas.ts          # 모듈, 작업, 대기열, 애니메이션 그리기
│  │  ├─ layout.ts          # 모듈 좌표 배치
│  │  └─ input.ts           # 드래그 앤 드롭, 클릭 판정 → manual supervisor
│  ├─ ui/
│  │  ├─ controls.ts        # 재생/일시정지/한 단계/속도/리셋
│  │  ├─ metricsFormat.ts   # 지표 표시 형식 (순수 함수, UI와 CLI 공용)
│  │  └─ metricsPanel.ts    # 완료 수, 처리량 등 (DOM)
│  ├─ cli/
│  │  └─ run.ts             # 화면 없이 실행/정책 비교 (make sim, make compare)
│  └─ scenarios/
│     └─ basic.json         # 예시 시나리오
└─ tests/
   └─ engine.test.ts
```

## 5. 데이터 모델

```ts
type ResultType = string;          // 예: "A", "B", "C"
type ModuleId = string;
type JobId = string;

interface Module {
  id: ModuleId;
  resultType: ResultType;          // 이 모듈이 주는 결과
  processTime: number;             // 시뮬레이션 시간 단위(초)
  capacity: number;                // 기본값 1
  slots: JobId[];                  // 처리 중이거나 DONE_AT_MODULE인 작업
  queue: JobId[];                  // 대기열
  busyTime: number;                // 슬롯 단위 누적 가동 시간: step마다 (처리 중 슬롯 수 × dt)를 더한다
}

type JobState = "POOL" | "MOVING" | "QUEUED" | "PROCESSING" | "DONE_AT_MODULE" | "COMPLETED";

interface Job {
  id: JobId;
  required: Set<ResultType>;
  acquired: Set<ResultType>;
  state: JobState;
  location: { kind: "pool" } | { kind: "module"; moduleId: ModuleId };
  progress: number;                // 현재 처리 경과 시간
  createdAt: number;               // 등장 시각 (simTime)
  completedAt?: number;            // 완료 시각 = 완료된 step이 끝난 뒤의 시각 (simTime + dt, §2.2-7)
}

type Command =
  | { type: "assign"; jobId: JobId; moduleId: ModuleId }   // 대기 구역 또는 다른 모듈 → 모듈
  | { type: "unassign"; jobId: JobId };                    // 모듈 → 대기 구역

type SimEvent =
  | { type: "jobArrived" | "processStarted" | "processFinished" | "jobCompleted" | "processCancelled";
      jobId: JobId; moduleId?: ModuleId; t: number }
  | { type: "jobSpawned"; jobId: JobId; t: number }
  | { type: "warning"; message: string; t: number };

interface WorldState {
  simTime: number;
  modules: Map<ModuleId, Module>;
  jobs: Map<JobId, Job>;
  completedCount: number;
  events: SimEvent[];              // 이번 step에서 발생한 이벤트 (렌더러와 로그가 사용)
  config: SimConfig;
}

// 설정. 기본값은 §9를 따르며 코드에서는 engine/types.ts의 DEFAULT_CONFIG 한 곳에만 둔다.
interface SimConfig {
  dt: number;                      // 기본 0.1
  moveTime: number;                // 기본 0
  occupyWhenDone: boolean;         // 기본 true
  cancelOnMove: boolean;           // 기본 true (false = 처리 중 이동 금지)
  queueLimit: number | null;       // 기본 null (무제한)
  endCondition:                    // 기본 { kind: "time", value: 300 }
    | { kind: "time"; value: number }
    | { kind: "completed"; value: number }
    | { kind: "allDone" };
}

// 시나리오 파일 형식 (§5.1). arrival을 생략하면 도착 없음, capacity를 생략하면 1.
interface Scenario {
  name: string;
  seed: number;
  modules: { id: ModuleId; resultType: ResultType; processTime: number; capacity?: number }[];
  jobs: {
    initial: { required: ResultType[] }[];
    arrival?:
      | { kind: "poisson"; rate: number; requiredPool: ResultType[]; minReq: number; maxReq: number }
      | { kind: "none" };
  };
  config?: Partial<SimConfig>;
}
```

### 5.1 시나리오 파일 (`scenarios/*.json`)

```json
{
  "name": "basic",
  "seed": 42,
  "modules": [
    { "id": "M1", "resultType": "A", "processTime": 2, "capacity": 1 },
    { "id": "M2", "resultType": "B", "processTime": 5, "capacity": 1 },
    { "id": "M3", "resultType": "C", "processTime": 3, "capacity": 2 }
  ],
  "jobs": {
    "initial": [
      { "required": ["A", "B"] },
      { "required": ["B", "C"] }
    ],
    "arrival": { "kind": "poisson", "rate": 0.3, "requiredPool": ["A", "B", "C"], "minReq": 1, "maxReq": 3 }
  },
  "config": {
    "moveTime": 0,
    "occupyWhenDone": true,
    "cancelOnMove": true,
    "endCondition": { "kind": "time", "value": 300 }
  }
}
```

## 6. 시뮬레이션 루프

- **고정 시간 간격(fixed timestep)**을 쓴다. 기본 `dt = 0.1` 시뮬레이션 초.
- 실제 화면 루프(`requestAnimationFrame`)는 `speed` 배율에 맞춰 필요한 만큼 `step(dt)`을 호출하고, 그다음 한 번 그린다.
- `step(dt)` 순서(고정, 바꾸지 말 것):
  1. 감독관에게서 Command를 받아 `apply`한다. 잘못된 명령은 무시하고 `warning` 이벤트를 남긴다.
  2. 새로 도착하는 작업을 생성한다(arrival 설정에 따라).
  3. `MOVING` 작업을 진행시키고, 도착하면 슬롯이나 대기열에 넣는다. step 시작에 남은 이동 시간이 0 이하면 도착(이번 step부터 처리), 아니면 남은 이동 시간에서 dt를 뺀다(§2.3 이동 시간 규칙, `rules.advanceMove`).
  4. 대기열 → 빈 슬롯으로 옮긴다(FIFO).
  5. `PROCESSING` 작업의 `progress += dt`. `progress >= processTime`이면 결과를 획득하고 `DONE_AT_MODULE`로 바꾼다. `processFinished` 시각은 `simTime + dt`(§2.2-7).
  6. 완료를 판정해서 `COMPLETED`로 바꾸고, 슬롯에서 빼고, `completedCount++` 한다. `completedAt`과 `jobCompleted` 시각은 `simTime + dt`.
  7. 지표를 갱신한다. 모듈 `busyTime += 처리 중 슬롯 수 × dt`.
  8. `simTime += dt`
- 정책 감독관은 매 step 호출하고, 수동 감독관은 사용자 입력이 쌓인 만큼 명령을 반환한다.

## 7. 화면 설계

```
┌───────────────────────────────────────────────┬──────────────────┐
│  [대기 구역 Pool]                               │ ▶ ⏸ ⏭ 리셋  속도x1 │
│   ○ ○ ○ ○                                      │ 감독관: [수동 ▾]   │
│                                               │ 시나리오: [basic▾] │
│   ┌─M1(A,2s)─┐   ┌─M2(B,5s)─┐   ┌─M3(C,3s)─┐   │──────────────────│
│   │  ◐ 60%   │   │  ○       │   │ ◑   ○    │   │ 완료: 12          │
│   └──────────┘   └──────────┘   └──────────┘   │ 시간: 84.3s        │
│     대기: ○○        대기:           대기: ○      │ 처리량: 0.14/s     │
│                                               │ 평균 소요: 21.0s    │
│                                    ✓ 완료 12   │ 가동률 M1 80% ...  │
└───────────────────────────────────────────────┴──────────────────┘
```

- **모듈**: 사각형 안에 ID, 결과 종류(색), 처리 시간을 표시한다. 처리 중이면 진행률 바나 테두리 게이지를 보여 준다. 대기열은 상자 아래에 작은 원으로 표시한다.
- **작업**: 원. 목표 결과 개수만큼 **파이 조각**으로 나누고, 얻은 결과 조각은 채우고 얻지 못한 조각은 빈 테두리로 둔다. 결과 종류마다 고정 색을 쓴다.
- **완료**: 원이 커지면서 사라지고, 완료 카운터에 짧은 강조 효과를 준다.
- **조작(수동 감독관)**:
  - 작업을 드래그해서 모듈에 놓으면 `assign`, 대기 구역에 놓으면 `unassign`.
  - 드래그하는 동안 "이 작업에 아직 필요한 결과를 주는 모듈"을 강조 표시한다.
  - 일시정지 중에도 배치할 수 있고, 명령은 다음 step에 적용된다.
- **컨트롤**: 재생, 일시정지, 한 단계(step), 속도(0.5x/1x/2x/5x/10x), 리셋, 감독관 선택(수동/정책들), 시나리오 선택.

## 8. 지표

| 지표 | 정의 |
|---|---|
| 완료 수 | `completedCount` |
| 처리량 | 완료 수 / simTime |
| 평균 소요 시간 | 평균(`completedAt - createdAt`) |
| 모듈 가동률 | 모듈별 `busyTime / (simTime × capacity)`. `busyTime`은 슬롯 단위 가동 시간(처리 중 슬롯 수 × dt의 누적)이라, 용량 2 모듈에서 두 작업이 처리 중이면 step마다 2·dt가 쌓인다. `DONE_AT_MODULE` 점유 시간은 넣지 않는다(점유 낭비로 따로 센다). 범위 0~1 |
| 점유 낭비 | 모듈별 `DONE_AT_MODULE` 상태로 점유된 시간 (감독관이 늦게 옮긴 정도). 슬롯 단위로 누적하고, 처리가 끝난 그 step 구간은 처리 중이었으므로 넣지 않는다 (처리 끝 시각부터 옮겨진 시각까지). `occupyWhenDone=false`이면 0 |
| 대기 시간 | 대기 구역(`POOL`) 체류 시간과 모듈 대기열(`QUEUED`) 체류 시간. 이동(`MOVING`)과 점유(`DONE_AT_MODULE`)는 대기가 아니다. 합계(`poolWaitTime`, `queueWaitTime`)는 진행 중 작업을 포함한 전체 작업 합이고, 평균 대기 시간(`avgWaitTime`)은 평균 소요 시간처럼 **완료 작업**의 평균(대기 구역 + 대기열)이다 |
| 헛된 처리 | 필요 없거나 이미 가진 결과를 위해 처리한 횟수(`uselessProcessCount`, 처리를 **시작할 때** 판정하고 끝까지 처리했을 때 센다) + 처리 도중 취소된 횟수(`cancelledProcessCount`). `wastedProcessCount`는 둘의 합 |

- 구현: 타입은 `engine/types.ts`의 `Metrics`, `MetricsState`(world 안의 누적값), 계산은 `engine/metrics.ts`의 `computeMetrics(world)`(순수 함수). "대기", "점유", "헛된 처리" 판정은 `rules.ts`의 `waitKind`, `isDoneOccupying`, `isWastedProcess`에만 둔다.
- 시간 누적(가동, 점유 낭비, 대기)은 step 7단계(`metrics.updateMetrics`)에서 step 1~6이 끝난 상태를 이번 구간의 상태로 보고 dt씩 더한다. 사건 누적(생성 수, 완료 작업의 소요·대기 합, 처리 시작/끝/취소)은 이벤트가 생길 때(`metrics.recordEvent`, `recordJobSpawned`) 더한다. step 밖에서 `apply`한 명령의 사건도 놓치지 않기 위해서다.
- 비율 지표(처리량, 가동률)는 `simTime = 0`이면 0, 평균 지표는 완료 작업이 없으면 `null`이다.

- 실행이 끝나면(종료 조건 도달) 결과를 JSON으로 내보낼 수 있게 한다. 정책 비교용이다.

## 9. 미결정 사항 (기본값으로 구현하고 설정으로 바꿀 수 있게)

| 항목 | 기본값 | 대안 |
|---|---|---|
| 처리 끝난 작업이 모듈을 계속 점유하는가 (`occupyWhenDone`) | **예**: 감독관이 옮겨야 비워진다 | 자동으로 대기 구역에 복귀 |
| 처리 중 이동 시 (`cancelOnMove`) | 처리 취소, 결과 없음 | 이동 금지 |
| 이동 시간 (`moveTime`) | 0 (즉시). 0보다 크면 도착은 `배치 시각 + moveTime`을 dt 격자로 올린 step 시작, 처리는 도착부터 센다(확정, §2.3) | 거리 비례, 고정값 |
| 결과 획득 순서 제약 | 없음 (순서 무관) | 작업마다 순서 지정 (A→B→C) |
| 모듈 용량 | 1 | 모듈별 지정 |
| 대기열 상한 (`queueLimit`) | 무제한. 상한을 정해도 초과 배치는 **허용 + warning**(확정, §2.2-6) | — |
| 같은 모듈 재배치 | `DONE_AT_MODULE`이면 다시 처리, 그 밖의 상태는 상태 불변 + warning(확정, §2.4) | — |
| 작업 등장 방식 | 초기 작업 + 포아송 도착 | 초기 작업만, 고정 간격 |
| 처리 시간의 무작위성 | 고정값 | 분포(정규/지수) |
| 종료 조건 | 시간 300s | 작업 N개 완료, 모든 작업 완료 |

> 사용자가 이 항목 중 하나를 확정하면 이 표를 갱신한다.

## 10. 구현 단계 (마일스톤)

각 단계는 **실행 가능한 상태**로 끝내고, 다음 단계로 넘어가기 전에 사용자에게 확인을 받는다.

1. **M0 – 프로젝트 셋업**: Vite + TS + Vitest 구성, `AGENTS.md`의 npm scripts 정의, 빈 캔버스 띄우기. `make setup`, `make dev`, `make check`가 동작해야 한다.
2. **M1 – 엔진**: `types`, `world`, `rules`, `rng`를 만든다. 화면 없이 시나리오를 돌려 완료 수가 나오게 한다. 단위 테스트 필수(§11).
3. **M2 – 렌더링**: 모듈, 작업, 대기열, 진행률, 파이 조각을 그린다. 정책 감독관(`greedy`)으로 자동 실행하는 모습을 관찰한다.
4. **M3 – 수동 감독관**: 드래그 앤 드롭으로 배치하고, 대상 모듈을 강조하고, 경고를 표시한다.
5. **M4 – 컨트롤과 지표 패널**: 재생/일시정지/한 단계/속도/리셋, §8의 지표.
6. **M5 – 정책 플러그인과 시나리오**: 감독관 선택 UI, 시나리오 선택, 결과 JSON 내보내기, `src/cli/run.ts`로 `make sim` 동작.
7. **M6 (선택) – 비교 모드**: `make compare`로 같은 시드에서 화면 없이 여러 정책을 돌리고 지표를 표로 비교한다. 리플레이(명령 로그 재생) 기능도 포함한다.

## 11. 테스트 기준 (M1에서 반드시 통과)

- 처리 시간 `t`인 모듈에 배치하면 정확히 `t` 후(dt 오차 이내)에 결과를 얻는다. `t`가 dt의 배수이면 `processFinished`/`completedAt` 시각은 배치 시각 + `t`와 부동소수 오차 수준으로 같다(§2.2-7).
- 용량 N 모듈은 N개 작업을 각자의 `progress`로 병렬 처리하고, `busyTime`은 처리 중 슬롯 수 × dt씩 늘어난다.
- `required`를 모두 얻은 순간 완료되고, 화면과 상태에서 제거되며 `completedCount`가 증가한다.
- 용량이 꽉 찬 모듈에 배치하면 대기열에 들어가고 FIFO로 처리된다.
- `occupyWhenDone = true`이면 옮기기 전까지 다음 작업이 시작되지 않는다.
- 처리 중 `unassign`하면 결과를 얻지 못한다(`cancelOnMove = true`).
- 존재하지 않는 작업이나 모듈을 대상으로 한 명령은 상태를 바꾸지 않고 warning만 남긴다.
- 대기열 상한 초과 배치는 수행되고 warning이 남는다. 같은 모듈 재배치는 `DONE_AT_MODULE`이면 다시 처리하고, 그 밖의 상태는 상태 불변 + warning이다.
- **결정성**: 같은 시나리오, 시드, 명령 로그면 최종 상태가 같다.

## 12. AI 작업 규칙

- 엔진(`src/engine`)에서는 DOM, Canvas, 브라우저 API를 import하지 않는다.
- 새 기능은 먼저 엔진 규칙과 테스트로 만들고, 그다음 화면에 붙인다.
- §9의 기본값을 바꾸거나 새 규칙을 추가하려면 사용자에게 먼저 확인하고, 확정되면 이 문서를 갱신한다.
- 마일스톤 범위를 넘는 기능(예: 3D, 네트워크, 프레임워크 도입)은 임의로 추가하지 않는다.
- 각 마일스톤이 끝나면 `make check` 통과를 확인하고, 실행 방법(`make dev` 등)과 확인할 화면을 사용자에게 알려 준다.
- 세부 작업 규칙은 `AGENTS.md`를 따른다.
