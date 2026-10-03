// 시나리오 편집기의 순수 로직 테스트: 초안 생성·조작, parseScenario 검증 오류, 왕복 보존, requiredPool 자동 동기화.
import { describe, expect, it } from "vitest";
import { parseScenario } from "../src/engine/scenario";
import type { Scenario } from "../src/engine/types";
import { SCENARIOS } from "../src/scenarios/index";
import {
  addModule,
  autoRequiredPool,
  draftToScenario,
  errorFromException,
  loadCustomScenario,
  loadScenarioJson,
  nextModuleId,
  parseInitialJobsText,
  pathMatches,
  removeModule,
  sameDraft,
  saveCustomScenario,
  scenarioJson,
  scenarioToDraft,
  updateArrival,
  updateDraft,
  updateModule,
  type DraftResult,
  type ScenarioDraft,
  type StorageLike,
} from "../src/ui/scenarioDraft";
import { CUSTOM_SCENARIO, scenariosWithCustom, withCustomScenarioName, resolveSessionConfig } from "../src/ui/selection";

function builtin(index = 0): Scenario {
  const entry = SCENARIOS[index];
  if (!entry) throw new Error("내장 시나리오가 없습니다");
  return entry.scenario;
}

function ok(result: DraftResult): Scenario {
  if (!result.ok) throw new Error(`검증 실패: ${JSON.stringify(result.errors)}`);
  return result.scenario;
}

function errorPaths(result: DraftResult): (string | null)[] {
  return result.ok ? [] : result.errors.map((e) => e.path);
}

/** 도착 없는 작은 시나리오 (모듈 resultType과 다른 순서의 requiredPool 등을 시험) */
const SMALL: Scenario = {
  name: "small",
  seed: 1,
  modules: [
    { id: "X", resultType: "p", processTime: 1 },
    { id: "Y", resultType: "q", processTime: 2, capacity: 3 },
  ],
  jobs: { initial: [{ required: ["p"] }] },
};

describe("초안 왕복", () => {
  it("모든 내장 시나리오를 초안으로 바꿨다 되돌려도 동일하다", () => {
    for (const entry of SCENARIOS) {
      const back = ok(draftToScenario(scenarioToDraft(entry.scenario)));
      expect(back).toEqual(entry.scenario);
    }
  });

  it("생략된 capacity·arrival·config도 그대로 보존한다", () => {
    expect(ok(draftToScenario(scenarioToDraft(SMALL)))).toEqual(SMALL);
    const none: Scenario = { ...SMALL, jobs: { ...SMALL.jobs, arrival: { kind: "none" } }, config: {} };
    expect(ok(draftToScenario(scenarioToDraft(none)))).toEqual(none);
  });

  it("편집기에서 다루지 않는 설정(dt, queueLimit)도 보존한다", () => {
    const s: Scenario = { ...SMALL, config: { dt: 0.05, queueLimit: 2, endCondition: { kind: "allDone" } } };
    expect(ok(draftToScenario(scenarioToDraft(s)))).toEqual(s);
  });

  it("초안 생성은 원래 시나리오를 바꾸지 않는다", () => {
    const s = builtin();
    const copy = structuredClone(s);
    const d = updateModule(scenarioToDraft(s), 0, { processTime: 99 });
    ok(draftToScenario(d));
    expect(s).toEqual(copy);
  });

  it("JSON 저장 텍스트를 다시 불러오면 같은 시나리오다", () => {
    for (const entry of SCENARIOS) {
      const loaded = loadScenarioJson(scenarioJson(entry.scenario));
      expect(loaded).toEqual({ ok: true, scenario: entry.scenario });
    }
  });
});

describe("모듈 추가·삭제·수정", () => {
  it("추가한 모듈 id는 기존 id와 겹치지 않는다", () => {
    let d = scenarioToDraft(builtin());
    for (let i = 0; i < 5; i++) d = addModule(d);
    const ids = d.modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ok(draftToScenario(d)).modules).toHaveLength(builtin().modules.length + 5);
  });

  it("nextModuleId는 숫자 없는 id, 중간이 빈 id 목록에서도 고유하다", () => {
    for (const ids of [[], ["X"], ["X", "X2"], ["M1", "M3"], ["M1", "M2", "M3", "M4"], ["a9", "a2", "a3"]]) {
      const id = nextModuleId(ids);
      expect(ids).not.toContain(id);
      expect(id.trim()).not.toBe("");
    }
  });

  it("추가한 모듈은 마지막 모듈의 결과·처리 시간·용량을 따른다", () => {
    const d = addModule(scenarioToDraft(SMALL));
    expect(d.modules[2]).toMatchObject({ resultType: "q", processTime: 2, capacity: 3 });
  });

  it("삭제와 수정이 반영된다", () => {
    const s = builtin();
    let d = removeModule(scenarioToDraft(s), 0);
    expect(d.modules.map((m) => m.id)).toEqual(s.modules.slice(1).map((m) => m.id));
    expect(removeModule(d, 99)).toBe(d);
    const second = s.modules[1];
    if (!second) throw new Error("모듈이 부족합니다");
    const edited = updateModule(scenarioToDraft(s), 1, { processTime: 7.5, capacity: 4, resultType: "zz" });
    const modules = ok(draftToScenario(updateDraft(edited, { initial: [] }))).modules;
    expect(modules[1]).toEqual({ ...second, processTime: 7.5, capacity: 4, resultType: "zz" });
  });
});

describe("잘못된 값은 parseScenario 오류로 보고한다", () => {
  const d = scenarioToDraft(builtin());

  it("processTime 0", () => {
    expect(errorPaths(draftToScenario(updateModule(d, 1, { processTime: 0 })))).toEqual(["modules[1].processTime"]);
  });

  it("capacity 0", () => {
    expect(errorPaths(draftToScenario(updateModule(d, 2, { capacity: 0 })))).toEqual(["modules[2].capacity"]);
  });

  it("빈 결과 종류", () => {
    expect(errorPaths(draftToScenario(updateModule(d, 0, { resultType: "  " })))).toEqual(["modules[0].resultType"]);
  });

  it("id 중복", () => {
    const first = d.modules[0];
    if (!first) throw new Error("모듈이 없습니다");
    expect(errorPaths(draftToScenario(updateModule(d, 1, { id: first.id })))).toEqual(["modules[1].id"]);
  });

  it("숫자가 아닌 입력(NaN)", () => {
    expect(errorPaths(draftToScenario(updateModule(d, 0, { processTime: Number.NaN })))).toEqual([
      "modules[0].processTime",
    ]);
  });

  it("여러 모듈의 칸 오류를 한꺼번에 돌려준다", () => {
    const bad = updateModule(updateModule(d, 0, { processTime: 0 }), 2, { capacity: 0 });
    expect(errorPaths(draftToScenario(bad))).toEqual(["modules[0].processTime", "modules[2].capacity"]);
  });

  it("오류 메시지는 parseScenario의 메시지와 같다 (검증 규칙을 새로 만들지 않는다)", () => {
    const raw = { ...builtin(), modules: [{ id: "Z", resultType: "A", processTime: 0 }] };
    let expected = "";
    try {
      parseScenario(raw);
    } catch (e) {
      expected = errorFromException(e).message;
    }
    const result = draftToScenario(updateModule(d, 0, { processTime: 0 }));
    expect(result.ok ? null : result.errors[0]?.message).toBe(expected);
  });

  it("모듈을 모두 지우면 모듈 오류", () => {
    let empty: ScenarioDraft = d;
    while (empty.modules.length > 0) empty = removeModule(empty, 0);
    expect(errorPaths(draftToScenario(empty))).toEqual(["modules"]);
  });

  it("초기 작업이 만들 수 없는 결과를 요구하면 오류", () => {
    const bad = updateDraft(d, { initial: parseInitialJobsText("A, B\nnope") });
    expect(errorPaths(draftToScenario(bad))).toEqual(["jobs.initial[1].required"]);
  });

  it("도착 설정 오류 (minReq > maxReq, 음수 도착률)", () => {
    expect(errorPaths(draftToScenario(updateArrival(d, { minReq: 3, maxReq: 2 })))).toEqual(["jobs.arrival"]);
    expect(errorPaths(draftToScenario(updateArrival(d, { rate: -1 })))).toEqual(["jobs.arrival.rate"]);
  });

  it("종료 조건 값 오류", () => {
    expect(errorPaths(draftToScenario(updateDraft(d, { end: { kind: "time", value: 0 } })))).toEqual([
      "config.endCondition.value",
    ]);
  });
});

describe("requiredPool 자동 동기화", () => {
  it("기본은 자동: 모듈 결과 종류를 바꾸면 requiredPool이 따라간다", () => {
    const d = scenarioToDraft(builtin());
    expect(d.arrival.autoPool).toBe(true);
    // 결과 종류를 새 값으로 바꾸고 초기 작업도 맞춘다.
    const firstType = d.modules[0]?.resultType ?? "";
    const renamed = `${firstType}-new`;
    let edited = updateModule(d, 0, { resultType: renamed });
    edited = updateDraft(edited, { initial: [[renamed]] });
    const s = ok(draftToScenario(edited));
    expect(s.jobs.arrival?.kind === "poisson" ? s.jobs.arrival.requiredPool : []).toEqual(
      autoRequiredPool(edited.modules),
    );
    expect(autoRequiredPool(edited.modules)).toContain(renamed);
  });

  it("모듈 순서·중복 제거로 목록을 만든다", () => {
    const d = scenarioToDraft(builtin(2));
    const pool = autoRequiredPool(d.modules);
    expect(new Set(pool).size).toBe(pool.length);
    expect(pool).toEqual([...new Set(d.modules.map((m) => m.resultType))]);
  });

  it("자동을 끄면 수동 목록을 쓰고, 끌 때 지금 자동 목록으로 시작한다", () => {
    const d = scenarioToDraft(builtin());
    const manual = updateArrival(d, { autoPool: false });
    expect(manual.arrival.requiredPool).toEqual(autoRequiredPool(d.modules));
    const first = autoRequiredPool(d.modules)[0] ?? "";
    const one = updateArrival(manual, { requiredPool: [first], minReq: 1, maxReq: 1 });
    const s = ok(draftToScenario(one));
    expect(s.jobs.arrival).toMatchObject({ kind: "poisson", requiredPool: [first] });
  });

  it("원래 requiredPool이 자동 목록과 다르면 수동으로 시작해 그대로 보존한다", () => {
    const s: Scenario = {
      ...SMALL,
      jobs: { ...SMALL.jobs, arrival: { kind: "poisson", rate: 1, requiredPool: ["q", "p"], minReq: 1, maxReq: 2 } },
    };
    const d = scenarioToDraft(s);
    expect(d.arrival.autoPool).toBe(false);
    expect(ok(draftToScenario(d))).toEqual(s);
  });

  it("도착을 켜고 끌 수 있다", () => {
    const off = updateArrival(scenarioToDraft(builtin()), { enabled: false });
    expect(ok(draftToScenario(off)).jobs.arrival).toBeUndefined();
    const on = updateArrival(scenarioToDraft(SMALL), { enabled: true });
    expect(ok(draftToScenario(on)).jobs.arrival).toMatchObject({ kind: "poisson", requiredPool: ["p", "q"] });
  });
});

describe("보조 함수", () => {
  it("오류 경로 매칭", () => {
    expect(pathMatches("jobs.initial[0].required", "jobs.initial")).toBe(true);
    expect(pathMatches("modules[1].id", "modules[1]")).toBe(true);
    expect(pathMatches("modules[10].id", "modules[1]")).toBe(false);
    expect(pathMatches("jobs.arrival", "jobs.arrival.rate")).toBe(false);
  });

  it("편집 여부 비교", () => {
    const d = scenarioToDraft(builtin());
    expect(sameDraft(d, scenarioToDraft(builtin()))).toBe(true);
    expect(sameDraft(d, addModule(d))).toBe(false);
  });

  it("잘못된 JSON 불러오기는 한국어 오류", () => {
    expect(loadScenarioJson("{")).toMatchObject({ ok: false });
    const bad = loadScenarioJson(JSON.stringify({ ...builtin(), modules: [] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("modules");
  });

  it("localStorage 저장·복원 (실패해도 예외 없음)", () => {
    const map = new Map<string, string>();
    const storage: StorageLike = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
    expect(loadCustomScenario(storage)).toBeNull();
    expect(saveCustomScenario(storage, builtin())).toBe(true);
    expect(loadCustomScenario(storage)).toEqual(builtin());
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadCustomScenario(broken)).toBeNull();
    expect(saveCustomScenario(broken, builtin())).toBe(false);
    expect(loadCustomScenario(null)).toBeNull();
    map.set([...map.keys()][0] ?? "", "not json");
    expect(loadCustomScenario(storage)).toBeNull();
  });

  it("사용자 편집 시나리오 선택: 목록 끝에 붙고, 세션 이름은 시나리오 name", () => {
    const custom = ok(draftToScenario(updateDraft(scenarioToDraft(builtin()), { name: "mine", seed: 5 })));
    const entries = scenariosWithCustom(SCENARIOS, custom);
    expect(entries.map((e) => e.name)).toEqual([...SCENARIOS.map((e) => e.name), CUSTOM_SCENARIO]);
    expect(scenariosWithCustom(SCENARIOS, null)).toHaveLength(SCENARIOS.length);
    const config = withCustomScenarioName(
      resolveSessionConfig({ supervisor: "manual", scenario: CUSTOM_SCENARIO }, [], entries),
    );
    expect(config).toMatchObject({ scenarioName: "mine", seed: 5, scenario: custom });
  });
});
