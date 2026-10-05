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

1. 작업이 모듈에 **도착**하면 그 모듈의 `processTime`만큼 처리된다. 모듈에 처리 시간 분포(`processTimeDist`, §9)를 주면 `processTime`은 평균이고, 처리를 시작할 때마다 실제 처리 시간을 시드에서 파생한 처리 시간 전용 난수(도착 RNG와 분리, §5.1)로 뽑는다.
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
    │               move / unassign / 자동 복귀(기본, §9)                 │ required ⊆ acquired
    └───────────────────────────────────────────────────────────────────┤
                                                                        ▼
                                                                  [COMPLETED] → 제거
```

- `MOVING`: 이동 애니메이션 중인 상태. 기본 이동 시간은 0이고 설정으로 바꿀 수 있다(§9).
  - **이동 시간 규칙(확정)**: 시각 `t0`에 배치하면 도착 시각은 `t0 + moveTime` 이상인 첫 step 시작 시각이다(dt 격자로 올림). 처리는 도착한 step부터 세므로 처리 완료 시각은 `도착 시각 + processTime`(≈ `t0 + moveTime + processTime`, dt 격자 오차 이내이고 체계적으로 짧아지지 않는다). 이동한 step에는 처리가 진행되지 않는다.
  - `moveTime = 0`이면 배치한 step에 바로 도착해 처리를 시작하고, 완료 시각은 `t0 + processTime`이다.
  - 예(dt = 0.1): `moveTime = 0.1`이면 `t0 + 0.1`에 도착, `moveTime = 0.25`면 `t0 + 0.3`에 도착한다.
- `DONE_AT_MODULE`: 처리는 끝났지만 아직 모듈 위에 있는 상태.
  - **기본값(`occupyWhenDone = false`, 확정)**: 완료되지 않은 작업은 처리가 끝난 step의 6단계에서 슬롯을 비우고 결과를 가진 채 **자동으로 대기 구역(`POOL`)에 돌아온다**(`jobReturned` 이벤트, 시각 `simTime + dt`). 그래서 step이 끝난 뒤에는 `DONE_AT_MODULE` 작업이 남지 않는다. 비워진 슬롯은 §6 순서대로 **다음 step 4단계**에서 대기열 다음 작업이 채운다(완료로 슬롯이 빌 때와 같다). 대기 구역에 돌아온 작업은 감독관이 다시 배치해야 다음 모듈로 간다(§2.2-5).
  - `occupyWhenDone = true`이면 감독관이 옮기기 전까지 **모듈을 점유한다**(§9 참고).
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
- **화면 시나리오 편집기**: 사이드바 "모듈 편집"에서 순수 DOM으로 현재 시나리오를 고친다(모듈 추가·삭제, 결과 종류·처리 시간·분포·용량, 도착 방식(포아송/묶음/고정 간격)·종료 조건·주요 설정). 검증은 엔진의 `parseScenario`를 그대로 쓰고(규칙 중복 없음), "적용"하면 편집한 시나리오(`custom`, "사용자 편집")로 처음부터 다시 시작한다. 시나리오 JSON 저장/불러오기를 지원하고 마지막 편집은 `localStorage`에 남는다. 순수 로직은 `ui/scenarioDraft.ts`, DOM은 `ui/scenarioEditor.ts`.
- **감독관 룰: `rules/*.ts`**: 정책 감독관은 저장소 루트 `rules/` 폴더에 TypeScript 클래스로 작성한다. `Rule`(`src/supervisor/rule`)을 상속해 `decide(ctx)`를 구현하고 `export default` 하면 감독관으로 등록된다. 룰은 `RuleContext`/`ModuleRef`/`JobRef` 객체로 월드를 읽고 `job.assignTo(module)`/`job.unassign()`으로 명령을 요청만 한다(상태 직접 변경 불가). 모든 판정은 `engine/rules.ts`를 거친다. 난수는 `ctx.random()`(시드 RNG)만 쓴다. 내장 정책 `random`·`greedy`도 `rules/`의 룰이다. 브라우저는 Vite `import.meta.glob`, CLI는 node로 `rules/*.ts`를 읽고, 검사는 `src/supervisor/ruleLoader.ts` 한 곳에서 한다. 작성법은 `rules/README.md`.

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
- 정책 감독관(룰)은 `rules/*.ts`에 둔다(§3). 의존 방향은 `rules → supervisor/rule API, engine`이고, 룰 API는 view를 읽기 전용 참조 객체로 감싸 Command로만 상태 변경을 요청한다.

### 4.1 디렉터리 구조

```
sim/
├─ plan/planing.md          # 이 문서
├─ AGENTS.md / CLAUDE.md    # 에이전트 작업 지침 (CLAUDE.md는 AGENTS.md를 불러온다)
├─ Makefile                 # 모든 작업 명령의 진입점
├─ docs/GIT.md              # git 작업 규칙 (커밋, 푸시, make 타깃)
├─ rules/                   # 감독관 룰 (Rule 하위 클래스를 default export하면 정책으로 등록)
│  ├─ README.md             # 룰 작성법과 API 표
│  ├─ random.ts             # 내장 기준선: 무작위 배치
│  ├─ greedy.ts             # 내장 예시: 필요한 결과를 주고 가장 빨리 비는 모듈에 배치
│  └─ fastestModule.ts      # 사용자용 짧은 예시 (fastest)
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
│  │  ├─ rule/              # 룰 API: Rule, RuleContext, ModuleRef, JobRef, ruleToSupervisor
│  │  ├─ ruleLoader.ts      # rules/ 모듈 → 정책 항목 (검사, 이름 중복 오류)
│  │  ├─ rules.browser.ts   # 브라우저용 rules/*.ts 수집 (import.meta.glob)
│  │  ├─ registry.ts        # 정책 목록: 내장(POLICIES) + createRegistry(룰)
│  │  └─ policies/          # 기존 import 호환용 얇은 래퍼 (rules/random.ts, rules/greedy.ts)
│  ├─ render/
│  │  ├─ canvas.ts          # 모듈, 작업, 대기열, 애니메이션 그리기
│  │  ├─ layout.ts          # 모듈 좌표 배치
│  │  ├─ jobLabel.ts        # 파이 조각 라벨·남은 결과·hover 툴팁·범례 글자 (순수 함수)
│  │  └─ input.ts           # 드래그 앤 드롭, 클릭 판정 → manual supervisor
│  ├─ ui/
│  │  ├─ controls.ts        # 재생/일시정지/한 단계/속도/리셋
│  │  ├─ metricsFormat.ts   # 지표 표시 형식 (순수 함수, UI와 CLI 공용)
│  │  ├─ scenarioDraft.ts   # 시나리오 편집 초안 (순수 함수: 추가·삭제·수정, 검증, JSON 저장/불러오기)
│  │  ├─ scenarioEditor.ts  # 화면 시나리오 편집기 (DOM)
│  │  └─ metricsPanel.ts    # 완료 수, 처리량 등 (DOM)
│  ├─ cli/
│  │  └─ run.ts             # 화면 없이 실행/정책 비교/룰 목록 (make sim, make compare, make rules)
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

// 처리 시간 분포 (§9). 평균은 언제나 모듈 processTime.
type ProcessTimeDist =
  | { kind: "fixed" }                // 기본값(생략 시). 난수를 쓰지 않는다
  | { kind: "exponential" }          // 평균 processTime인 지수 분포
  | { kind: "normal"; cv: number };  // 평균 processTime, 표준편차 cv·processTime (cv > 0, 하한으로 자름)

interface Module {
  id: ModuleId;
  resultType: ResultType;          // 이 모듈이 주는 결과
  processTime: number;             // 평균(기대) 처리 시간, 시뮬레이션 시간 단위(초)
  processTimeDist: ProcessTimeDist; // 시나리오에서 생략하면 { kind: "fixed" }
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
  | { type: "jobArrived" | "processStarted" | "processFinished" | "jobCompleted" | "processCancelled" | "jobReturned";
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
  processDurations: Map<JobId, number>; // 처리 중인 작업의 이번 처리 실제 처리 시간 (처리 시작 때 뽑음, 끝나거나 취소되면 지움)
  // (그 밖에 rules, arrival, rngState(도착 전용), processTimeSeed·processAttempts(처리 시간 공통 난수, §5.1), moves, metricsState 등 내부 상태가 있다: engine/types.ts)
}

// 설정. 기본값은 §9를 따르며 코드에서는 engine/types.ts의 DEFAULT_CONFIG 한 곳에만 둔다.
interface SimConfig {
  dt: number;                      // 기본 0.1
  moveTime: number;                // 기본 0
  occupyWhenDone: boolean;         // 기본 false (처리 끝난 미완료 작업은 자동으로 대기 구역에 복귀)
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
  modules: { id: ModuleId; resultType: ResultType; processTime: number; capacity?: number; processTimeDist?: ProcessTimeDist }[];
  jobs: {
    initial: { required: ResultType[] }[];
    arrival?:
      | { kind: "poisson"; rate: number; requiredPool: ResultType[]; minReq: number; maxReq: number }
      // 몰려서 도착: 묶음이 초당 rate개(포아송), 묶음마다 batchMin~batchMax개(균등)가 같은 step에 생긴다.
      // 평균 작업 도착률 = rate × (batchMin + batchMax) / 2
      | { kind: "batch"; rate: number; batchMin: number; batchMax: number; requiredPool: ResultType[]; minReq: number; maxReq: number }
      // 고정 간격: 시각 k·every(k ≥ 1)마다 count개 (그 시각 이상인 첫 step 시작에 생김). 평균 = count / every
      | { kind: "interval"; every: number; count: number; requiredPool: ResultType[]; minReq: number; maxReq: number }
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
    "occupyWhenDone": false,
    "cancelOnMove": true,
    "endCondition": { "kind": "time", "value": 300 }
  }
}
```

처리 시간 분포와 몰려서 도착을 쓰는 예 (생략하면 위처럼 고정 처리 시간·포아송 도착):

```json
{
  "modules": [
    { "id": "M1", "resultType": "A", "processTime": 2, "processTimeDist": { "kind": "exponential" } },
    { "id": "M2", "resultType": "B", "processTime": 5, "processTimeDist": { "kind": "normal", "cv": 0.3 } }
  ],
  "jobs": {
    "initial": [],
    "arrival": { "kind": "batch", "rate": 0.1, "batchMin": 2, "batchMax": 4, "requiredPool": ["A", "B"], "minReq": 1, "maxReq": 2 }
  }
}
```

- 검증(`parseScenario`): `processTimeDist.kind`는 `fixed`/`exponential`/`normal`, `normal`은 `cv > 0`. `batch`는 `rate ≥ 0`, `batchMin`·`batchMax`는 1 이상의 정수이고 `batchMin ≤ batchMax`. `interval`은 `every > 0`, `count`는 1 이상의 정수. 목표 결과 설정(`requiredPool`, `minReq`, `maxReq`)은 모든 도착 방식이 포아송과 같은 규칙으로 검증한다.

#### 처리 시간 무작위성의 규칙 (확정, `rules.ts`)

- **샘플링 시점·저장 위치**: 처리를 시작할 때(`processStarted`: 도착 즉시 시작, 대기열에서 슬롯으로, 같은 모듈 재처리) `RuleSet.sampleProcessTime`으로 이번 처리의 실제 처리 시간을 한 번 뽑아 `world.processDurations`(작업 id → 시간)에 저장한다. 처리가 끝나거나(`processFinished`) 취소·이동하면 지운다. 재처리·취소 후 재시작은 새로 뽑는다. `Job`에 넣지 않은 이유: 처리 한 번에만 유효한 엔진 내부 값이라 작업 데이터 모델(§5)을 바꾸지 않고 `moves`처럼 world에 둔다.
- **두 가지 처리 시간**: `RuleSet.processTime` = 기대(평균) 처리 시간, `RuleSet.sampleProcessTime` = 이번 처리의 실제 처리 시간. 진행 판정(`isProcessFinished`)과 진행률(`processProgressRatio`)은 실제 처리 시간(`rules.currentProcessDuration`)을 쓴다.
- **감독관은 미래를 모른다**: `remainingProcessTime`과 `estimatedWaitTime`은 처리 중인 작업도 실제 표본이 아니라 `max(0, 기대 처리 시간 − progress)`로 계산한다. 룰 API의 `ModuleRef.processTime`/`processTimeFor`도 기대값이다. 분포가 `fixed`면 실제 값과 같다.
- **분포**: `exponential`은 `−평균·ln(1−u)`(난수 1개), `normal`은 Box-Muller로 `평균·(1 + cv·z)`(난수 2개). 무작위 표본은 하한 `MIN_SAMPLED_PROCESS_TIME = 0.001`초로 자른다(처리 시간이 양수여야 진행률이 정의되고, dt보다 훨씬 작아 결과에는 dt 격자 오차 이하의 영향만 준다. cv ≤ 0.3이면 잘릴 확률 ≈ 0.04%로 평균에 영향이 없고, cv가 크면 평균이 약간 커진다).
- **난수 흐름 분리(공통 난수, 확정)**: 처리 시간 표본은 도착용 월드 RNG(`world.rngState`, 작업 도착만 소비)를 쓰지 않는다. 대신 카운터(해시) 기반 난수를 쓴다: `RuleSet.processTimeRandom(world, job, module, attempt)`가 (처리 시간 시드, 작업 id, 모듈 id, 차수)를 해시(FNV-1a + murmur3 fmix32 결합, `engine/rng.ts`)해 만든 상태에서 mulberry32 흐름을 시작한다. 처리 시간 시드는 `rules.deriveProcessTimeSeed(seed)` = seed와 이름 붙은 상수 `PROCESS_TIME_STREAM_SALT`의 해시 결합이고 `world.processTimeSeed`에 둔다. 차수 `attempt`는 이 작업이 이 모듈에서 처리를 시작한 횟수(0부터, 취소된 시작·재처리도 센다)이며 `world.processAttempts`에 센다(world.ts는 세기와 호출만 한다).
  - **이유**: 같은 흐름을 쓰면 감독관마다 처리 시작 순서가 달라 도착열까지 달라져, 정책 비교가 같은 도착열로 짝지은 비교가 아니게 된다. 단순히 흐름만 분리하면 도착열은 같아지지만 처리 시간 표본은 처리 시작 순서대로 배정되어 작업마다 달라진다. 카운터 방식은 도착열이 감독관과 무관하게 같고(시나리오·seed만으로 정해짐), 같은 작업이 같은 모듈에서 같은 차수로 처리되면 감독관과 무관하게 같은 처리 시간이 나와 분산이 더 줄어든 공정한 비교가 된다. 상태를 이어 쓰지 않으므로 처리 순서에 의존하지 않는다.
- **결정성**: 같은 시나리오·seed·명령이면 같은 결과다. `fixed`(생략 포함)는 처리 시간 난수를 전혀 쓰지 않고 도착 흐름도 그대로라 기존 결과와 비트 단위로 같다.
- **화면**: 모듈 제목은 분포가 있으면 `~2s(지수)`, `~5s(정규 cv0.3)`처럼 평균 앞에 `~`를 붙인다(`render/jobLabel.processTimeLabel`). 시나리오 편집기 모듈 표에 분포(기본/고정/지수/정규)·cv 칸, 작업 도착에 방식(포아송/묶음/고정 간격) 선택이 있다.

### 5.2 대표 시나리오: A·B 순차 vs 즉시

결과 A, B를 주는 모듈 두 개(처리 시간 2초, 용량 1로 같음)에 모든 작업이 A와 B를 둘 다 필요로 하는 상황에서 두 감독관 전략을 비교한다.

- 시나리오 (`src/scenarios/`)
  - `ab-batch` ("A·B 일괄 20개"): 초기 작업 20개, 도착 없음, 종료 조건 `allDone`. 모든 작업 완료 시각(makespan)을 비교한다.
  - `ab-stream` ("A·B 연속 도착"): 초기 작업 4개 + 포아송 도착(rate 0.4개/초), 300초. 작업마다 두 모듈을 한 번씩 거치므로 모듈 하나가 감당하는 작업은 1/2초 = 0.5개/초가 상한이고, 0.4는 그 80% 부하다.
- 전략 (`rules/`). 둘 다 빈 모듈(빈 슬롯이 있고 대기열이 없음)에만 배치하고, 경합하면 먼저 생긴 작업이 우선이다. 차이는 순서 제약 하나다.
  - `sequential` (순차): 작업의 `required` 순서대로만 결과를 받는다(A를 얻은 뒤에야 B).
  - `immediate` (즉시): 남은 결과 중 아무거나, 그 결과를 주는 모듈이 비어 있으면 바로 넣는다.
- 이론값(ab-batch, 작업 N개, 처리 시간 T): 즉시는 두 모듈이 처음부터 쉬지 않아 makespan ≈ N·T, 순차는 시작할 때 B 모듈이 T 동안 놀아서 ≈ N·T + T. 실제 40초 vs 42초로 일치한다.
- 비교 방법

  ```bash
  make compare SCENARIO=ab-batch POLICIES=sequential,immediate
  make compare SCENARIO=ab-stream POLICIES=sequential,immediate SEED=42
  ```

## 6. 시뮬레이션 루프

- **고정 시간 간격(fixed timestep)**을 쓴다. 기본 `dt = 0.1` 시뮬레이션 초.
- 실제 화면 루프(`requestAnimationFrame`)는 `speed` 배율에 맞춰 필요한 만큼 `step(dt)`을 호출하고, 그다음 한 번 그린다.
- `step(dt)` 순서(고정, 바꾸지 말 것):
  1. 감독관에게서 Command를 받아 `apply`한다. 잘못된 명령은 무시하고 `warning` 이벤트를 남긴다.
  2. 새로 도착하는 작업을 생성한다(arrival 설정에 따라).
  3. `MOVING` 작업을 진행시키고, 도착하면 슬롯이나 대기열에 넣는다. step 시작에 남은 이동 시간이 0 이하면 도착(이번 step부터 처리), 아니면 남은 이동 시간에서 dt를 뺀다(§2.3 이동 시간 규칙, `rules.advanceMove`).
  4. 대기열 → 빈 슬롯으로 옮긴다(FIFO).
  5. `PROCESSING` 작업의 `progress += dt`. `progress >= 이번 처리의 실제 처리 시간`(고정 분포면 `processTime`, 처리 시작 때 뽑은 값, §5.1)이면 결과를 획득하고 `DONE_AT_MODULE`로 바꾼다. `processFinished` 시각은 `simTime + dt`(§2.2-7).
  6. 완료를 판정해서 `COMPLETED`로 바꾸고, 슬롯에서 빼고, `completedCount++` 한다. `completedAt`과 `jobCompleted` 시각은 `simTime + dt`. 완료되지 않은 `DONE_AT_MODULE` 작업은 `occupyWhenDone = false`(기본)이면 슬롯에서 빼고 `POOL`로 돌려보내며 `jobReturned`(시각 `simTime + dt`)를 남긴다(`rules.releaseWhenDone`). 이 단계에서 빈 슬롯은 다음 step 4단계에서 채운다.
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
- **작업**: 원. 목표 결과 개수만큼 **파이 조각**으로 나누고 조각마다 결과 라벨(결과 이름 앞 글자)을 쓴다. 얻은 결과 조각은 결과 색으로 채우고 라벨에 ✓를 붙인다. 아직 남은 결과 조각은 옅은 색으로 두고 라벨을 보여 준다. 결과 종류마다 고정 색을 쓴다. 남은 결과 판정은 `rules.remainingResults`만 쓴다.
- **범례**: 대기 구역 제목 옆에 결과 종류별 색·라벨과 "채움✓ = 얻음 · 옅은 칸 = 남음" 설명을 보여 준다.
- **hover 툴팁**: 마우스를 작업 위에 올리면(모든 감독관 모드, 리플레이 포함) 작업 정보(필요·얻은·남은 결과, 상태와 진행률, 경과 시간, 남은 결과를 주는 모듈)를 툴팁으로 보여 주고 남은 결과를 주는 모듈을 은은하게 강조한다. 드래그 배치는 수동 감독관일 때만 한다.
- **자동 복귀**: 기본값(`occupyWhenDone=false`)에서 처리가 끝났지만 완료되지 않은 작업은 그 step에 대기 구역으로 돌아간다(`jobReturned` 이벤트). 화면에서는 대기 구역에 다시 나타난다(별도 애니메이션 없음). `occupyWhenDone=true`이면 모듈에 점선 링으로 남는다.
- **완료**: 원이 커지면서 사라지고, 완료 카운터에 짧은 강조 효과를 준다.
- **조작(수동 감독관)**:
  - 작업을 드래그해서 모듈에 놓으면 `assign`, 대기 구역에 놓으면 `unassign`.
  - 드래그하는 동안 "이 작업에 아직 필요한 결과를 주는 모듈"을 강조 표시한다.
  - 일시정지 중에도 배치할 수 있고, 명령은 다음 step에 적용된다.
- **컨트롤**: 재생, 일시정지, 한 단계(step), 속도(0.5x/1x/2x/5x/10x), 리셋, 감독관 선택(수동/정책들), 시나리오 선택.
  - 감독관 목록은 `createRegistry(BROWSER_RULES.entries)`로 만든다: 내장 정책 + `rules/*.ts` 룰. 룰 로드 오류는 콘솔 경고와 토스트로 알리고, 룰의 `ctx.log`는 콘솔 디버그로 내보낸다.
- **모듈 편집(시나리오 편집기)**: 모듈 추가·삭제, 결과 종류·처리 시간·용량, 도착·종료 조건·주요 설정을 고치고 "적용"하면 처음부터 다시 시작한다(감독관 유지, 시드는 시나리오 seed). 잘못된 값은 칸 옆에 `parseScenario` 오류로 표시한다. 시나리오 JSON 저장/불러오기를 지원한다. 편집한 시나리오도 감독관 선택·리셋·결과 내보내기·리플레이가 내장 시나리오와 똑같이 동작한다.

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
| 처리 끝난 작업이 모듈을 계속 점유하는가 (`occupyWhenDone`) | **아니오**: 자동으로 대기 구역에 복귀 (확정, §2.3) | 감독관이 옮겨야 비워진다 (`true`) |
| 처리 중 이동 시 (`cancelOnMove`) | 처리 취소, 결과 없음 | 이동 금지 |
| 이동 시간 (`moveTime`) | 0 (즉시). 0보다 크면 도착은 `배치 시각 + moveTime`을 dt 격자로 올린 step 시작, 처리는 도착부터 센다(확정, §2.3) | 거리 비례, 고정값 |
| 결과 획득 순서 제약 | 없음 (순서 무관) | 작업마다 순서 지정 (A→B→C) |
| 모듈 용량 | 1 | 모듈별 지정 |
| 대기열 상한 (`queueLimit`) | 무제한. 상한을 정해도 초과 배치는 **허용 + warning**(확정, §2.2-6) | — |
| 같은 모듈 재배치 | `DONE_AT_MODULE`이면 다시 처리, 그 밖의 상태는 상태 불변 + warning(확정, §2.4) | — |
| 작업 등장 방식 | 초기 작업 + 포아송 도착 | 초기 작업만(`arrival` 생략 또는 `none`). **구현됨**: 몰려서 도착 `{ kind: "batch", rate, batchMin, batchMax, ... }`(평균 작업 도착률 = rate × (batchMin+batchMax)/2), 고정 간격 `{ kind: "interval", every, count, ... }` (§5, §5.1) |
| 처리 시간의 무작위성 | 고정값 (`processTimeDist` 생략 = `fixed`) | **구현됨**: 모듈별 `processTimeDist: { kind: "exponential" }` 또는 `{ kind: "normal", cv }` (평균 = processTime, 처리 시작 때 샘플링, 감독관 예상치는 기대값, §5.1). 난수는 도착 RNG와 분리된 (작업, 모듈, 차수) 해시 기반 공통 난수(§5.1): 감독관이 달라도 도착열과 같은 작업·차수의 처리 시간이 같다 |
| 종료 조건 | 시간 300s | 작업 N개 완료, 모든 작업 완료 |

> 사용자가 이 항목 중 하나를 확정하면 이 표를 갱신한다.

## 10. 구현 단계 (마일스톤)

각 단계는 **실행 가능한 상태**로 끝내고, 다음 단계로 넘어가기 전에 사용자에게 확인을 받는다.

1. **M0 – 프로젝트 셋업** (완료): Vite + TS + Vitest 구성, `AGENTS.md`의 npm scripts 정의, 빈 캔버스 띄우기. `make setup`, `make dev`, `make check`가 동작해야 한다.
2. **M1 – 엔진** (완료): `types`, `world`, `rules`, `rng`를 만든다. 화면 없이 시나리오를 돌려 완료 수가 나오게 한다. 단위 테스트 필수(§11).
3. **M2 – 렌더링** (완료): 모듈, 작업, 대기열, 진행률, 파이 조각을 그린다. 정책 감독관(`greedy`)으로 자동 실행하는 모습을 관찰한다.
4. **M3 – 수동 감독관** (완료): 드래그 앤 드롭으로 배치하고, 대상 모듈을 강조하고, 경고를 표시한다.
5. **M4 – 컨트롤과 지표 패널** (완료): 재생/일시정지/한 단계/속도/리셋, §8의 지표.
6. **M5 – 정책 플러그인과 시나리오** (완료): 감독관 선택 UI, 시나리오 선택, 결과 JSON 내보내기, `src/cli/run.ts`로 `make sim` 동작.
7. **M6 (선택) – 비교 모드** (완료): `make compare`로 같은 시드에서 화면 없이 여러 정책을 돌리고 지표를 표로 비교한다. 리플레이(명령 로그 재생) 기능도 포함한다.
   - 구현: `make compare`는 정책별 지표를 표로 출력하고 `out/<시나리오>-<정책>-<시드>.json`(정책마다)과 `out/<시나리오>-compare-<시드>.json`을 저장한다. 결과 JSON에는 시나리오 명세와 명령 로그가 들어간다(`engine/report.ts`).
   - `make replay FILE=...`은 결과 JSON의 시나리오·시드·명령 로그로 다시 돌려 저장된 지표와 일치하는지 알린다.
   - 화면: "결과 JSON 불러오기"로 같은 실행을 재생하고 끝나면 원본 지표와 비교해 표시한다. 리플레이 중 감독관·시나리오 select는 "리플레이" 표시 옵션을 보이고, 값을 고르거나 "리플레이 종료"를 누르면 일반 모드로 돌아간다.

## 11. 테스트 기준 (M1에서 반드시 통과)

- 처리 시간 `t`인 모듈에 배치하면 정확히 `t` 후(dt 오차 이내)에 결과를 얻는다. `t`가 dt의 배수이면 `processFinished`/`completedAt` 시각은 배치 시각 + `t`와 부동소수 오차 수준으로 같다(§2.2-7).
- 용량 N 모듈은 N개 작업을 각자의 `progress`로 병렬 처리하고, `busyTime`은 처리 중 슬롯 수 × dt씩 늘어난다.
- `required`를 모두 얻은 순간 완료되고, 화면과 상태에서 제거되며 `completedCount`가 증가한다.
- 용량이 꽉 찬 모듈에 배치하면 대기열에 들어가고 FIFO로 처리된다.
- `occupyWhenDone = false`(기본)이면 완료되지 않은 작업은 처리가 끝난 step에 슬롯을 비우고 결과를 가진 채 `POOL`로 돌아오며(`jobReturned`), 대기열 다음 작업은 다음 step에 시작한다. 점유 낭비(`doneOccupiedTime`)는 0이다.
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
