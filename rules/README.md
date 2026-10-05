# rules/ — 감독관 룰

이 폴더의 `*.ts` 파일 하나가 정책 감독관 하나다. `Rule`을 상속한 클래스를 `export default` 하면 감독관으로 등록되어 화면의 감독관 선택(통합 후)과 CLI(`make sim POLICY=<이름>`, `make compare POLICIES=a,b`)에서 쓸 수 있다.

## 1. 파일 만들기

```ts
// rules/fastestModule.ts
import { Rule, type RuleContext } from "../src/supervisor/rule";

export default class FastestModule extends Rule {
  name = "fastest";               // 고유 식별자: 영문, 숫자, _, - (CLI와 결과 파일 이름에 쓴다)
  label = "가장 빨리 비는 모듈";   // 화면에 보이는 이름 (생략하면 name)

  decide(ctx: RuleContext) {
    for (const job of ctx.poolJobs()) {
      const target = ctx.modules()
        .filter((m) => job.needs(m.resultType))
        .sort((a, b) => a.estimatedWait() - b.estimatedWait())[0];
      if (target) job.assignTo(target);
    }
  }
}
```

확인:

```bash
make rules                                              # 읽힌 룰 목록과 로드 오류
make sim POLICY=fastest                                 # 룰 하나로 실행
make compare SCENARIO=basic POLICIES=greedy,fastest SEED=42
make typecheck                                          # rules/도 타입 검사 대상
```

### 예시: 순서 제약만 다른 두 룰 (`sequential.ts`, `immediate.ts`)

대표 시나리오 `ab-batch`/`ab-stream`(plan/planing.md §5.2)에서 비교하는 룰이다. 둘 다 빈 모듈(`freeSlots() > 0`이고 `queueLength() === 0`)에만 배치하고, 대기 구역 작업을 생성 순으로 보며, 같은 step에 이미 요청한 모듈은 슬롯을 쓴 것으로 센다.

- `sequential`: 작업의 `required()` 순서에서 아직 얻지 못한 첫 결과만 받는다. 그 결과를 주는 빈 모듈이 없으면 기다린다.
- `immediate`: `remaining()` 중 아무 결과나, 그 결과를 주는 빈 모듈이 있으면(시나리오 순서로 첫 모듈) 바로 넣는다.

```bash
make compare SCENARIO=ab-batch POLICIES=sequential,immediate
```

## 2. 동작 방식

- 매 step마다 `decide(ctx)`가 불린다. `ctx`로 월드를 읽고 작업에 `assignTo`/`unassign`을 **요청**한다. 요청은 step이 시작될 때 엔진에 Command로 넘어가고, 상태는 그 step이 진행되면서 바뀐다. 그래서 `assignTo` 직후에도 `job.state`는 그대로다.
- `init(ctx)`(선택)는 첫 `decide` 직전에 한 번 불린다. 첫 step의 `ctx`를 받으므로 여기서 한 요청도 첫 step에 들어간다.
- 룰 인스턴스는 실행(seed)마다 새로 만든다. 클래스 필드에 상태를 두어도 실행끼리 섞이지 않는다. 생성자 인자는 없어야 한다.
- 참조 객체(`ModuleRef`, `JobRef`)는 **읽기 전용**이다. 엔진 상태에 닿는 필드가 없고, 배열은 복사본을 돌려준다. 같은 step 안에서는 같은 id면 같은 객체다(`target === m` 비교 가능). step이 바뀌면 새 객체를 받는다.
- 모든 판정(배치 가능 여부, 필요한 결과, 처리 시간, 예상 대기 시간)은 `src/engine/rules.ts`를 그대로 부른다. 규칙이 바뀌면 룰 코드는 그대로 두어도 새 규칙을 따른다.

### 같은 작업에 여러 번 요청하면: 마지막 요청만 남는다

`job.assignTo(a); job.assignTo(b);`이면 `b`로 가는 명령 하나만 나간다. 명령 순서는 마지막 요청 시점 기준이다(앞 요청은 지워지고 맨 뒤에 붙는다). `assignTo` 다음 `unassign`도 마찬가지로 `unassign`만 남는다.

### 규칙이 거부하는 요청은: 버리고 로그에 남긴다

`assignTo`/`unassign`은 요청 시점에 `rules.canAssign`/`canUnassign`으로 검사한다. 거부되면 명령을 만들지 않고 `false`를 돌려주며 룰 로그에 사유를 남긴다(엔진 warning도 생기지 않는다). 거부된 요청은 앞서 받아들인 같은 작업의 요청을 지우지 않는다. 미리 확인하려면 `module.canAccept(job)`, `job.canUnassign()`을 쓴다.

## 3. API

### RuleContext (`ctx`)

| 멤버 | 설명 |
|---|---|
| `time` | 현재 시뮬레이션 시각 (`simTime`, 초) |
| `dt` | step 간격(초) |
| `modules()` | 모든 모듈 `ModuleRef[]` (시나리오 순서) |
| `module(id)` | id로 모듈 찾기. 없으면 `undefined` |
| `jobs()` | 모든 작업 `JobRef[]` (생성 순서, 완료된 작업 포함) |
| `poolJobs()` | 대기 구역 작업 (`POOL`) |
| `queuedJobs()` | 모듈 대기열 작업 (`QUEUED`) |
| `processingJobs()` | 처리 중 작업 (`PROCESSING`) |
| `doneJobs()` | 처리 끝나 슬롯을 점유 중인 작업 (`DONE_AT_MODULE`, `occupyWhenDone=true`일 때만 생긴다) |
| `resultTypes()` | 모듈이 주는 결과 종류 (중복 없이 시나리오 순서) |
| `random()` | `[0,1)` 시드 난수 |
| `log(message)` | 디버그 메시지 남기기 |

### ModuleRef

| 멤버 | 설명 |
|---|---|
| `id`, `resultType`, `capacity` | 모듈 정보 |
| `processTime` | 시나리오에 정의된 평균(기대) 처리 시간(초) |
| `processTimeDist` | 처리 시간 분포 (복사본): `{ kind: "fixed" }`, `{ kind: "exponential" }`, `{ kind: "normal", cv }`. fixed가 아니면 실제 처리 시간은 처리할 때마다 달라지고 미리 알 수 없다 |
| `processTimeFor(job)` | 이 작업의 기대(평균) 처리 시간 (규칙 `processTime` 경유). 이번 처리의 실제 처리 시간은 알려 주지 않는다 |
| `isIdle()` | 슬롯도 대기열도 비어 있는가 |
| `freeSlots()` | 지금 비어 있는 슬롯 수 |
| `queueLength()` | 대기열 길이 |
| `processingJobs()` | 지금 처리 중인 작업 |
| `estimatedWait(job?)` | 새 작업이 처리를 시작하기까지 예상 대기 시간(초). 기대 처리 시간 기준(처리 중인 작업은 `max(0, 기대 처리 시간 − 경과)`). 이번 step에 이 모듈로 요청한 작업도 줄에 넣어 계산한다. `job`을 주면 그 작업 자신은 뺀다 |
| `canAccept(job)` | 이 작업을 배치할 수 있는가 (`rules.canAssign`) |
| `isUsefulFor(job)` | 이 모듈의 처리가 작업에 아직 없는 필요한 결과를 주는가 (`rules.usefulResults`) |

### JobRef

| 멤버 | 설명 |
|---|---|
| `id`, `state`, `createdAt` | 작업 정보 (`state`: `POOL`, `MOVING`, `QUEUED`, `PROCESSING`, `DONE_AT_MODULE`, `COMPLETED`) |
| `required()` / `acquired()` | 필요한 결과 / 이미 얻은 결과 (복사본) |
| `remaining()` | 아직 얻지 못한 필요한 결과 (`rules.remainingResults`) |
| `needs(resultType)` | 이 결과가 아직 필요한가 |
| `location()` | 있는 모듈(이동 중이면 목적지). 대기 구역이면 `null` |
| `waitTime()` | 지금까지 대기한 시간(대기 구역 + 대기열 누적, 초). 완료된 작업은 0 |
| `canUnassign()` | 대기 구역으로 돌려보낼 수 있는가 (`rules.canUnassign`) |
| `assignTo(module)` | 모듈에 배치 요청. 받아들여지면 `true` |
| `unassign()` | 대기 구역으로 회수 요청. 받아들여지면 `true` |

> `job.needs(m.resultType)`는 "모듈은 자기 resultType 하나를 준다"는 현재 규칙을 가정한다. 규칙이 바뀌어도 맞게 동작하려면 `m.isUsefulFor(job)`을 쓴다.

## 4. 결정성 (꼭 지킬 것)

같은 시나리오와 seed면 항상 같은 결과가 나와야 비교와 리플레이가 된다.

- `Math.random()` 대신 **`ctx.random()`** 을 쓴다. 감독관마다 seed로 만든 RNG를 실행 내내 이어 쓴다.
- `Date.now()`, `performance.now()` 대신 **`ctx.time`** 을 쓴다.
- DOM, `window`, node API(`fs` 등)를 쓰지 않는다. 룰은 브라우저와 CLI 양쪽에서 돈다.
- 전역 변수에 상태를 두지 않는다. 상태는 클래스 필드에 둔다(실행마다 새 인스턴스).

## 5. 이름 규칙과 오류

- `name`은 영문, 숫자, `_`, `-`만 쓴다. 다른 룰이나 내장 정책(`random`, `greedy`)과 겹치면 안 되고, `manual`은 예약어다.
- 문제가 있는 파일(default export 없음, `Rule`을 상속하지 않음, 이름 형식 오류, 이름 중복, import 실패)은 건너뛰고 나머지는 계속 읽는다. `make rules`가 목록과 함께 오류를 보여 준다. `make sim`/`make compare`는 오류를 경고로 출력하고 실행을 계속한다.
- 이름이 겹치면 파일 경로 순서로 앞 파일이 이긴다. 내장 정책과 이름이 겹치면 내장 정책이 이긴다.
- `decide`에서 예외가 나면 실행이 멈춘다(오류를 숨기지 않는다).
