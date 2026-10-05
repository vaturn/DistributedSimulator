# AGENTS.md — 에이전트 작업 지침

이 저장소에서 작업하는 AI 에이전트(Claude Code, Codex 등)를 위한 지침이다.
**기획의 기준 문서는 `plan/planing.md`다.** 작업을 시작하기 전에 반드시 읽고, 이 파일과 내용이 충돌하면 기획서를 따른다.

## 프로젝트 한 줄 요약

모듈(네모)이 작업(원)을 처리해서 결과를 부여하고, 감독관(사용자 또는 정책 알고리즘)이 작업을 모듈에 배치하는 **시각적 시뮬레이터**다. TypeScript, Vite, Canvas 2D, Vitest로 만든다.

## 명령은 Makefile을 기본으로 실행한다

표준 작업(설치, 실행, 테스트, 타입 검사, 검증, 시뮬레이션)은 `npm`, `npx`, `vite`, `vitest`를 직접 부르지 말고 `make` 타깃을 쓴다. **완료 판정은 항상 `make check`로 한다.**

다음은 예외로 직접 실행해도 된다.

- 사용자가 승인한 의존성 추가: `npm install -D <패키지>` (런타임 의존성은 `npm install <패키지>`)
- 결과를 남기지 않는 일회성 조사 명령: 설정 확인(`npx tsc --showConfig`), 버전 확인 등

같은 명령을 반복해서 쓰게 되면 그때 Makefile 타깃으로 만든다(아래 "Makefile 확장 규칙" 참고). 한 번만 쓸 명령은 타깃으로 만들지 않는다.

`make dev`와 `make test-watch`는 끝나지 않는 명령이므로 에이전트는 백그라운드로 실행한다.

| 하고 싶은 일 | 명령 |
|---|---|
| 타깃 목록 보기 | `make help` |
| 의존성 설치 | `make setup` |
| 브라우저로 실행 | `make dev` |
| 테스트 | `make test` (감시 모드: `make test-watch`) |
| 테스트 일부만 실행 | `make test ARGS="tests/rules.test.ts -t canAssign"` |
| 타입 검사 | `make typecheck` |
| **작업 완료 전 검증** | `make check` |
| 화면 없이 실행 | `make sim SCENARIO=basic POLICY=greedy SEED=42` |
| 정책 비교 | `make compare SCENARIO=basic POLICIES=random,greedy SEED=42` |
| 파라미터 격자 실험 | `make sweep SPEC=experiments/ab.ts OUT=docs/experiments` (명세 형식: `experiments/README.md`) |
| 리플레이 | `make replay FILE=out/basic-greedy-42.json` |
| 감독관 룰 목록·로드 오류 (`rules/`) | `make rules` |
| 정리 | `make clean` / `make distclean` |
| git 상태 확인 | `make git-status` |
| 커밋 / 푸시 | `make commit MSG="..."` / `make push` / `make ship MSG="..."` |
| 원격 동기화 | `make sync` |

### Makefile과 npm scripts의 약속

Makefile은 아래 npm scripts를 호출한다. `package.json`(M0에서 생성)에는 반드시 이 이름으로 정의한다.

| npm script | 내용 |
|---|---|
| `dev` | `vite` |
| `build` | `tsc --noEmit && vite build` |
| `preview` | `vite preview` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `typecheck` | `tsc --noEmit` |
| `sim` | `tsx src/cli/run.ts` (화면 없이 실행. 인자: `--scenario`, `--policy`, `--seed`, `--compare`, `--replay`, `--out`, `--list`) |

`sim`과 `compare`는 CLI(`src/cli/run.ts`)가 생기는 M5~M6 전까지 동작하지 않는 것이 정상이다.

### Makefile 확장 규칙

- 새 타깃에는 `## 설명` 주석을 달아 `make help`에 나오게 한다.
- 실제 파일을 만들지 않는 타깃은 `.PHONY`에 추가한다.
- 레시피 들여쓰기는 **탭**이다. 수정한 뒤 `make help`와 `make -n <타깃>`으로 확인한다.
- 파라미터는 `VAR ?= 기본값` 형태로 위쪽 변수 블록에 둔다.

## git 작업

git 작업(커밋, 푸시, 동기화) 전에 반드시 `docs/GIT.md`를 읽고 따른다.

## 아키텍처 규칙 (위반 금지)

1. **엔진은 순수하게 유지한다.** `src/engine/`에서는 DOM, Canvas, `window`, `Date.now()`, `Math.random()`을 쓰지 않는다. 시간은 `simTime`, 난수는 `engine/rng.ts`의 시드 RNG만 쓴다.
2. **상태는 Command로만 바꾼다.** UI 드래그도 정책도 `Command`를 만들어 엔진에 넘긴다. 렌더러는 상태를 읽기만 한다.
3. **결정성을 지킨다.** 같은 시나리오, 시드, 명령 로그는 항상 같은 결과를 내야 한다.
4. **`step()` 순서**(기획서 §6)를 바꾸지 않는다.
5. 의존 방향: `render/ui → engine`, `supervisor → engine`, `rules → supervisor/rule API, engine`, `engine → (없음)`. 엔진이 다른 계층을 import하면 안 된다. 룰(`rules/*.ts`)은 상태를 바꾸지 않고 `src/supervisor/rule`의 API로만 명령을 요청한다.

## 시뮬레이션 규칙 추상화 (위반 금지)

시뮬레이션 규칙은 나중에 바뀐다는 전제로 만든다. 규칙을 바꿀 때 **한 곳만 고치면 시뮬레이터 전체에 같은 규칙이 적용**되어야 한다.

1. **규칙은 한 곳에만 둔다.** 처리 시간, 결과 획득, 완료 판정, 배치 가능 여부, 대기열 순서, 이동 처리 같은 규칙은 `src/engine/rules.ts`(또는 그 아래 모듈)에만 구현한다. 렌더러, UI, 감독관, CLI는 규칙을 직접 계산하지 않고 엔진이 제공하는 함수를 호출한다.
   - 예: UI가 "이 모듈에 놓을 수 있는가"를 표시할 때 직접 판단하지 않고 `rules.canAssign(world, jobId, moduleId)`를 부른다. 정책도 같은 함수를 쓴다.
2. **규칙은 인터페이스 뒤에 둔다.** 바뀔 수 있는 규칙(완료 조건, 대기열 정책, 처리 시간 계산, 이동 시간 등)은 함수 인터페이스로 정의하고, 구현은 교체할 수 있게 한다. `world`는 현재 쓰는 규칙 구현을 `config`로 받는다.
3. **규칙 변경은 설정이나 새 구현으로 한다.** 기획서 §9의 항목처럼 바뀔 수 있는 규칙은 `SimConfig`의 값이나 규칙 구현 교체로 바꾼다. 여러 파일에 `if (config.xxx)` 분기를 흩어 놓지 않는다.
4. **값을 하드코딩하지 않는다.** 결과 종류, 모듈 수, 처리 시간, 용량은 시나리오에서 받는다. 코드에 `"A"`, `"M1"` 같은 특정 값을 가정하지 않는다.
5. **규칙마다 테스트가 있다.** 규칙 구현을 바꾸거나 추가하면, 그 규칙을 직접 검증하는 테스트를 함께 작성한다. 같은 테스트를 여러 규칙 구현에 돌릴 수 있으면 그렇게 한다.
6. **추상화가 어려우면 묻는다.** 규칙을 한 곳에 두기 어렵거나 추상화 구조를 바꿔야 하면, 임시방편으로 우회하지 말고 사용자에게 먼저 확인한다.

## 작업 흐름

1. `plan/planing.md`에서 현재 마일스톤(§10)과 관련 규칙을 확인한다.
2. **작업 계획을 먼저 세운다.** 코드를 고치기 전에 할 일을 단계별 목록으로 정리해 사용자에게 보여 주고, 그 순서대로 진행한다.
   - 각 단계에는 무엇을 바꾸는지(파일/모듈), 어떻게 확인하는지(테스트, `make` 타깃)를 적는다.
   - 진행하다 계획을 바꿔야 하면, 바꾼 계획과 이유를 먼저 알리고 계속한다.
   - 작업이 끝나면 계획의 각 단계를 완료했는지, 건너뛰었는지 보고한다.
3. 엔진 기능은 **테스트를 먼저 또는 함께** 작성한다(`tests/`). 테스트 기준은 기획서 §11에 있다.
4. 그다음 렌더러와 UI에 연결한다.
5. `make check`를 통과시킨다.
6. 사용자에게 보고한다: 무엇을 했는지, `make dev`로 무엇을 확인하면 되는지, 남은 일이 무엇인지.
7. 마일스톤 하나가 끝나면 **멈추고 사용자에게 확인을 받은 뒤** 다음 마일스톤으로 넘어간다.

## 완료 기준

- `make check`가 통과한다. 실패하면 완료라고 보고하지 않고 실패 내용을 그대로 알린다.
- 새 엔진 규칙에는 대응하는 테스트가 있다.
- 시뮬레이션 규칙이 `src/engine/rules.ts` 밖(렌더러, UI, 감독관, CLI)에 중복 구현되어 있지 않다.
- 화면 관련 변경은 `make dev`로 확인할 방법을 함께 적는다.
- 규칙이나 기본값을 바꿨다면 `plan/planing.md`를 함께 갱신한다.

## 사용자에게 먼저 물어볼 것

- 기획서 §9 "미결정 사항"의 기본값을 바꾸는 일
- 기획서에 없는 도메인 규칙을 추가하는 일 (예: 결과 순서 제약, 모듈 고장)
- 새 런타임 의존성 추가 (UI 프레임워크, 렌더링 라이브러리 등). 개발용 도구는 꼭 필요할 때만 추가한다.
- 디렉터리 구조(기획서 §4.1)를 바꾸는 일

## 코드 스타일

- TypeScript `strict` 모드를 켜고, `any`는 쓰지 않는다.
- 도메인 용어는 기획서와 같은 이름을 쓴다: `Module`, `Job`, `ResultType`, `Command`, `Supervisor`, `simTime`.
- 파일 하나에는 한 가지 책임만 둔다. 공용 타입은 `engine/types.ts`에 둔다.
- 주석과 사용자 대상 문서는 한국어로, 식별자는 영어로 쓴다.
- 매직 넘버(색, 크기, dt)는 상수나 `config`로 뺀다.

## 하지 말 것

- 마일스톤 범위를 넘는 기능을 임의로 추가하지 않는다.
- 테스트를 통과시키려고 테스트를 약하게 고치거나 건너뛰지 않는다.
- `node_modules`, `dist`, `out`을 커밋하지 않는다.
