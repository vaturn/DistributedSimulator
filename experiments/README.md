# experiments/ — 파라미터 격자 실험 명세

이 폴더의 `*.ts` 파일 하나가 실험 하나다. 시나리오 파라미터(작업 수, 도착률, 처리 시간 등)를 바꿔 가며 여러 정책을 같은 조건으로 실행하고, 시드별 평균·표준편차와 정책 간 차이를 표로 만든다.

```bash
make sweep SPEC=experiments/ab.ts                      # 결과 표를 터미널에 출력
make sweep SPEC=experiments/ab.ts OUT=docs/experiments # <OUT>/<name>.csv, <name>.md 저장
```

## 1. 명세 형식

`export default`로 아래 객체를 내보낸다. 타입은 `src/cli/sweep.ts`의 `ExperimentSpec`이다(`satisfies ExperimentSpec`로 검사).

```ts
import type { ExperimentSpec, SweepCase } from "../src/cli/sweep";
import { parseScenario } from "../src/engine/scenario";

export default {
  name: "ab",                          // 결과 파일 이름 (영문, 숫자, _, -)
  description: "실험 설명",             // 보고서 머리말
  policies: ["immediate", "sequential"], // 비교할 정책 (make rules에 나오는 이름)
  baseline: "immediate",               // 차이(%)의 기준 정책 (생략하면 policies[0])
  seeds: [1, 2, 3],                    // 기본 시드 목록
  cases: (): SweepCase[] =>            // 케이스 생성 코드로 파라미터 격자를 만든다
    [2, 5, 10].map((n) => ({
      group: "일괄 작업 수",            // 보고서에서 표 하나
      label: `N=${n}`,                 // 그룹 안에서 고유한 이름
      params: { N: n },                // 표·CSV에 나오는 파라미터 열
      scenario: parseScenario({ /* 시나리오 JSON과 같은 모양 */ }),
      seeds: [1],                      // (선택) 확률 요소가 없으면 시드 하나만
      // skip: "이유",                 // (선택) 실행하지 않고 보고서에 이유만 남긴다
    })),
  summarize: (result) => "# 요약",      // (선택) 보고서 맨 위에 붙일 글 (result: SweepResult)
} satisfies ExperimentSpec;
```

- 시나리오는 `parseScenario`로 검증해서 넣는다. 형식이 틀리면 명세를 불러올 때 바로 오류가 난다.
- `parseScenario`는 모르는 필드를 버린다. 엔진에 아직 없는 기능(새 필드)을 쓰는 케이스는 파싱 결과에 그 필드가 남는지 확인하고, 없으면 `skip`으로 표시한다(`experiments/ab.ts`의 `supportsDist`, `supportsBatch` 참고).
- 정책 이름은 내장 정책과 `rules/`의 룰 이름을 쓴다(`make rules`).

## 2. 실행과 결과

- 모든 (케이스, 정책, 시드)를 `runHeadless`로 끝까지 실행하고 `computeMetrics`의 지표를 모은다. 진행 상황은 stderr에 나온다.
- 모은 지표: `makespan`(종료 시 simTime. allDone 종료면 모든 작업 완료 시각), `completed`, `spawned`, `throughput`, `avgLeadTime`, `avgWaitTime`, 모듈별 가동률.
- `<name>.md`: `summarize` 결과 + 그룹별 표(정책별 평균 ± 표준편차, 기준 정책 대비 차이 %) + 실행하지 않은 케이스.
- `<name>.csv`: (케이스, 정책)당 한 줄. 파라미터 열, 지표별 `_mean`/`_std`, 모듈별 `util_<id>_mean`/`_std`.
- 같은 명세는 항상 같은 결과를 낸다(시드 RNG만 쓴다).

## 3. 실험 목록

| 파일 | 내용 | 결과 |
|---|---|---|
| `ab.ts` | A·B 두 모듈, 모든 작업이 A·B를 다 필요로 할 때 순차 vs 즉시 (작업 수, 부하, 처리 시간 차이, 처리 시간 무작위성, 몰려서 도착) | `docs/experiments/ab.md`, `ab.csv` |
