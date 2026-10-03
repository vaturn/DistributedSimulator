// 편집 시나리오(custom)와 룰 감독관의 상호작용: 선택 → 실행 → 재시작(같은 결과) → 내보내기 → 리플레이.
// 화면(main.ts)이 쓰는 순수 함수만 같은 순서로 조립해 확인한다.
import { describe, expect, it } from "vitest";
import FastestModule from "../rules/fastestModule";
import { computeMetrics } from "../src/engine/metrics";
import { compareMetrics } from "../src/engine/report";
import { runHeadless } from "../src/engine/runner";
import type { Scenario } from "../src/engine/types";
import { SCENARIOS } from "../src/scenarios/index";
import { createRegistry } from "../src/supervisor/registry";
import { ruleEntry } from "../src/supervisor/ruleLoader";
import { runResultJson } from "../src/ui/exportResult";
import { loadReplay, replaySessionConfig, replayStopStep } from "../src/ui/replay";
import { addModule, draftToScenario, scenarioToDraft, updateDraft, updateModule } from "../src/ui/scenarioDraft";
import {
  CUSTOM_SCENARIO,
  parseSelectionQuery,
  resolveSessionConfig,
  scenarioOptions,
  scenariosWithCustom,
  supervisorOptions,
  withCustomScenarioName,
  type SessionConfig,
} from "../src/ui/selection";

/** 화면 실행을 흉내 낼 최대 step 수 (테스트 시간을 짧게) */
const MAX_STEPS = 3000;

function customScenario(): Scenario {
  const base = SCENARIOS[0];
  if (!base) throw new Error("내장 시나리오가 없습니다");
  let draft = addModule(scenarioToDraft(base.scenario));
  draft = updateModule(draft, 0, { processTime: 2 });
  draft = updateDraft(draft, { name: "edited", seed: 7 });
  const result = draftToScenario(draft);
  if (!result.ok) throw new Error(`검증 실패: ${JSON.stringify(result.errors)}`);
  return result.scenario;
}

const registry = createRegistry([ruleEntry(FastestModule, "rules/fastestModule.ts")]);

function run(config: SessionConfig, maxSteps = MAX_STEPS) {
  if (!config.createPolicy) throw new Error("정책 감독관이 아닙니다");
  return runHeadless(config.scenario, config.createPolicy(config.seed), { maxSteps });
}

describe("편집 시나리오 + 룰 감독관", () => {
  const custom = customScenario();
  const entries = scenariosWithCustom(SCENARIOS, custom);
  const choices = { supervisors: supervisorOptions(registry.policies), scenarios: scenarioOptions(entries) };

  it("URL 쿼리로 룰 감독관과 편집 시나리오를 고를 수 있다", () => {
    const parsed = parseSelectionQuery(`?supervisor=fastest&scenario=${CUSTOM_SCENARIO}`, choices);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.selection).toEqual({ supervisor: "fastest", scenario: CUSTOM_SCENARIO });
  });

  it("재시작하면 같은 결과, 내보낸 결과를 리플레이하면 지표가 같다", () => {
    const config = withCustomScenarioName(
      resolveSessionConfig({ supervisor: "fastest", scenario: CUSTOM_SCENARIO }, registry.policies, entries),
    );
    expect(config).toMatchObject({ scenarioName: "edited", policyName: "fastest", seed: 7, manual: false });

    const first = run(config);
    const again = run(config);
    expect(again.commandLog).toEqual(first.commandLog);
    expect(first.commandLog.length).toBeGreaterThan(0);

    const json = runResultJson(
      first.world,
      { scenario: config.scenarioName, policy: config.policyName, seed: config.seed, scenarioSpec: config.scenario },
      first.commandLog,
    );
    const loaded = loadReplay(json);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.result.scenarioSpec.modules).toHaveLength(custom.modules.length);

    const replayConfig = replaySessionConfig({ fileName: "edited.json", result: loaded.result });
    const replayed = run(replayConfig, replayStopStep(loaded.result) ?? MAX_STEPS);
    expect(compareMetrics(computeMetrics(replayed.world), computeMetrics(first.world))).toEqual([]);
  });
});
