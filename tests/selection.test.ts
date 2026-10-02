// 감독관·시나리오 선택 순수 로직 테스트 (기획서 §7, §10 M5). DOM 없이 검증한다.
import { describe, expect, it } from "vitest";
import type { Scenario } from "../src/engine/types";
import type { Supervisor } from "../src/supervisor/types";
import {
  DEFAULT_SCENARIO,
  DEFAULT_SUPERVISOR,
  MANUAL_SUPERVISOR,
  parseSelectionQuery,
  resolveSessionConfig,
  scenarioOptions,
  selectionToQuery,
  supervisorOptions,
  type PolicyLike,
  type ScenarioLike,
} from "../src/ui/selection";
import { makeScenario } from "./helpers";

/** create(seed)에 넘어온 시드를 기록하는 가짜 정책 */
function fakePolicy(name: string, seeds: number[]): PolicyLike {
  return {
    name,
    label: `${name} 정책`,
    create(seed: number): Supervisor {
      seeds.push(seed);
      return { name, decide: () => [] };
    },
  };
}

function scenarioEntry(name: string, seed: number): ScenarioLike {
  const scenario: Scenario = { ...makeScenario({ modules: [], initial: [], seed }), name };
  return { name, label: `${name} 시나리오`, scenario };
}

const seeds: number[] = [];
const POLICIES = [fakePolicy("random", seeds), fakePolicy("greedy", seeds)];
const SCENARIOS = [scenarioEntry("basic", 42), scenarioEntry("busy", 7)];
const CHOICES = { supervisors: supervisorOptions(POLICIES), scenarios: scenarioOptions(SCENARIOS) };

describe("선택 옵션", () => {
  it("감독관 옵션은 수동이 맨 앞이고 정책은 registry 순서", () => {
    expect(CHOICES.supervisors.map((o) => o.value)).toEqual([MANUAL_SUPERVISOR, "random", "greedy"]);
    expect(CHOICES.supervisors[0]?.label).toBe("수동");
    expect(CHOICES.scenarios).toEqual([
      { value: "basic", label: "basic 시나리오" },
      { value: "busy", label: "busy 시나리오" },
    ]);
  });
});

describe("parseSelectionQuery", () => {
  it("정상 값은 그대로 쓴다", () => {
    const r = parseSelectionQuery("?supervisor=greedy&scenario=busy", CHOICES);
    expect(r.selection).toEqual({ supervisor: "greedy", scenario: "busy" });
    expect(r.warnings).toEqual([]);
  });

  it("쿼리가 없거나 비어 있으면 기본값(manual, basic)이고 경고가 없다", () => {
    for (const search of ["", "?", "?supervisor=&scenario=", "?other=1"]) {
      const r = parseSelectionQuery(search, CHOICES);
      expect(r.selection).toEqual({ supervisor: DEFAULT_SUPERVISOR, scenario: DEFAULT_SCENARIO });
      expect(r.warnings).toEqual([]);
    }
  });

  it("하나만 있으면 나머지는 기본값", () => {
    expect(parseSelectionQuery("?scenario=busy", CHOICES).selection).toEqual({ supervisor: "manual", scenario: "busy" });
    expect(parseSelectionQuery("?supervisor=random", CHOICES).selection).toEqual({ supervisor: "random", scenario: "basic" });
  });

  it("알 수 없는 값은 기본값으로 바꾸고 값마다 경고한다", () => {
    const r = parseSelectionQuery("?supervisor=genius&scenario=nope", CHOICES);
    expect(r.selection).toEqual({ supervisor: "manual", scenario: "basic" });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain("genius");
    expect(r.warnings[1]).toContain("nope");
  });

  it("기본 시나리오가 목록에 없으면 첫 시나리오를 쓴다", () => {
    const choices = { ...CHOICES, scenarios: scenarioOptions([scenarioEntry("only", 1)]) };
    expect(parseSelectionQuery("", choices).selection.scenario).toBe("only");
  });
});

describe("selectionToQuery", () => {
  it("선택을 쿼리에 쓰고 다른 값은 남긴다", () => {
    const q = selectionToQuery("?debug=1&supervisor=manual", { supervisor: "greedy", scenario: "busy" });
    const params = new URLSearchParams(q);
    expect(q.startsWith("?")).toBe(true);
    expect(params.get("debug")).toBe("1");
    expect(params.get("supervisor")).toBe("greedy");
    expect(params.get("scenario")).toBe("busy");
  });

  it("쓴 쿼리를 다시 읽으면 같은 선택이다", () => {
    const sel = { supervisor: "random", scenario: "busy" };
    expect(parseSelectionQuery(selectionToQuery("", sel), CHOICES).selection).toEqual(sel);
  });
});

describe("resolveSessionConfig", () => {
  it("수동이면 정책 생성기가 없고 이름은 manual, 시드는 시나리오 seed", () => {
    const c = resolveSessionConfig({ supervisor: "manual", scenario: "busy" }, POLICIES, SCENARIOS);
    expect(c.manual).toBe(true);
    expect(c.createPolicy).toBeNull();
    expect(c.policyName).toBe("manual");
    expect(c.scenarioName).toBe("busy");
    expect(c.seed).toBe(7);
    expect(c.scenario).toBe(SCENARIOS[1]?.scenario);
  });

  it("정책이면 registry의 create를 시나리오 seed로 부른다", () => {
    seeds.length = 0;
    const c = resolveSessionConfig({ supervisor: "greedy", scenario: "basic" }, POLICIES, SCENARIOS);
    expect(c.manual).toBe(false);
    expect(c.policyName).toBe("greedy");
    const sup = c.createPolicy?.(c.seed);
    expect(sup?.name).toBe("greedy");
    expect(seeds).toEqual([42]);
  });

  it("목록에 없는 값이면 오류", () => {
    expect(() => resolveSessionConfig({ supervisor: "x", scenario: "basic" }, POLICIES, SCENARIOS)).toThrow();
    expect(() => resolveSessionConfig({ supervisor: "manual", scenario: "x" }, POLICIES, SCENARIOS)).toThrow();
  });
});
