import { describe, expect, it } from "vitest";
import { createRegistry, findPolicy, POLICIES, RESERVED_POLICY_NAMES } from "../src/supervisor/registry";

describe("정책 목록", () => {
  it("random과 greedy가 있고 manual은 없다", () => {
    const names = POLICIES.map((p) => p.name);
    expect(names).toContain("random");
    expect(names).toContain("greedy");
    expect(names).not.toContain("manual");
    expect(new Set(names).size).toBe(names.length);
  });

  it("모든 정책은 label이 있고, 만든 감독관 이름이 정책 이름과 같다", () => {
    for (const p of POLICIES) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.create(1).name).toBe(p.name);
    }
  });

  it("findPolicy는 이름으로 찾고, 없으면 undefined", () => {
    expect(findPolicy("greedy")?.name).toBe("greedy");
    expect(findPolicy("random")?.name).toBe("random");
    expect(findPolicy("nope")).toBeUndefined();
  });
});

describe("createRegistry (내장 정책 + rules/ 룰)", () => {
  function entry(name: string, ruleClass?: abstract new () => unknown) {
    return { name, label: name, create: () => ({ name, decide: () => [] }), source: `rules/${name}.ts`, ruleClass };
  }

  it("인자가 없으면 내장 정책만, 있으면 내장 정책 뒤에 순서대로 붙는다", () => {
    expect(createRegistry().policies.map((p) => p.name)).toEqual(POLICIES.map((p) => p.name));
    const r = createRegistry([entry("b"), entry("a")]);
    expect(r.policies.map((p) => p.name)).toEqual([...POLICIES.map((p) => p.name), "b", "a"]);
    expect(r.find("a")?.name).toBe("a");
    expect(r.find("nope")).toBeUndefined();
    expect(r.errors).toEqual([]);
  });

  it("내장 정책과 같은 룰 클래스는 조용히 건너뛴다", () => {
    const greedy = findPolicy("greedy");
    const r = createRegistry([entry("greedy", greedy?.ruleClass)]);
    expect(r.errors).toEqual([]);
    expect(r.policies.filter((p) => p.name === "greedy")).toEqual([greedy]);
  });

  it("내장 정책과 이름만 같은 다른 룰, 추가 정책끼리 겹치는 이름, 예약 이름은 등록하지 않고 오류", () => {
    class Other {}
    const r = createRegistry([entry("greedy", Other), entry("x"), { ...entry("x"), source: "rules/x2.ts" }, entry("manual")]);
    expect(r.policies.map((p) => p.name)).toEqual([...POLICIES.map((p) => p.name), "x"]);
    expect(r.find("greedy")).toBe(findPolicy("greedy"));
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain("내장 정책");
    expect(r.errors[1]).toContain("rules/x2.ts");
    expect(r.errors[2]).toContain("예약");
    expect(RESERVED_POLICY_NAMES).toContain("manual");
  });
});
