// 룰 로더(entriesFromRuleModules)와 브라우저 수집(rules.browser.ts) 테스트
import { describe, expect, it } from "vitest";
import FastestModule from "../rules/fastestModule";
import GreedyRule from "../rules/greedy";
import { Rule, type RuleContext } from "../src/supervisor/rule";
import { RULE_NAME_PATTERN, entriesFromRuleModules } from "../src/supervisor/ruleLoader";
import { BROWSER_RULES } from "../src/supervisor/rules.browser";
import { POLICIES, createRegistry } from "../src/supervisor/registry";

function ruleNamed(name: unknown, label?: unknown) {
  return class extends Rule {
    name = name as string;
    label = label as string | undefined;
    decide(_ctx: RuleContext): void {}
  };
}

describe("entriesFromRuleModules", () => {
  it("default export가 Rule 하위 클래스인 모듈을 경로 순서로 정책 항목으로 바꾼다", () => {
    const { entries, errors } = entriesFromRuleModules({
      "/rules/b.ts": { default: ruleNamed("bee", "벌") },
      "/rules/a.ts": { default: ruleNamed("ant") },
    });
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.name, e.label, e.source])).toEqual([
      ["ant", "ant", "rules/a.ts"],
      ["bee", "벌", "rules/b.ts"],
    ]);
    const sup = entries[0]?.create(3);
    expect(sup?.name).toBe("ant");
  });

  it("default export가 없거나 Rule 하위 클래스가 아니면 파일 경로와 함께 오류", () => {
    const { entries, errors } = entriesFromRuleModules({
      "/rules/none.ts": { other: ruleNamed("x") },
      "/rules/plain.ts": { default: class {} },
      "/rules/obj.ts": { default: { name: "o", decide() {} } },
      "/rules/abstract.ts": { default: Rule },
      "/rules/null.ts": null,
    });
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(5);
    expect(errors.find((e) => e.startsWith("rules/none.ts"))).toContain("default export가 없습니다");
    expect(errors.find((e) => e.startsWith("rules/plain.ts"))).toContain("Rule을 상속한 클래스가 아닙니다");
    expect(errors.find((e) => e.startsWith("rules/obj.ts"))).toContain("Rule을 상속한 클래스가 아닙니다");
    expect(errors.find((e) => e.startsWith("rules/abstract.ts"))).toContain("Rule을 상속한 클래스가 아닙니다");
    expect(errors.find((e) => e.startsWith("rules/null.ts"))).toContain("default export가 없습니다");
  });

  it("name·label 형식이 틀리거나 생성자가 던지면 오류", () => {
    class Throws extends Rule {
      name = "throws";
      constructor() {
        super();
        throw new Error("펑");
      }
      decide(): void {}
    }
    const { entries, errors } = entriesFromRuleModules({
      "/rules/space.ts": { default: ruleNamed("a b") },
      "/rules/empty.ts": { default: ruleNamed("") },
      "/rules/num.ts": { default: ruleNamed(3) },
      "/rules/label.ts": { default: ruleNamed("ok", "") },
      "/rules/throws.ts": { default: Throws },
    });
    expect(entries).toEqual([]);
    expect(errors.map((e) => e.split(":")[0])).toEqual([
      "rules/empty.ts",
      "rules/label.ts",
      "rules/num.ts",
      "rules/space.ts",
      "rules/throws.ts",
    ]);
    expect(errors[0]).toContain("name");
    expect(errors[1]).toContain("label");
    expect(errors[4]).toContain("펑");
  });

  it("이름이 겹치면 경로 순서로 앞 파일만 등록하고 뒤 파일은 오류", () => {
    const { entries, errors } = entriesFromRuleModules({
      "/rules/z.ts": { default: ruleNamed("same") },
      "/rules/a.ts": { default: ruleNamed("same") },
    });
    expect(entries.map((e) => e.source)).toEqual(["rules/a.ts"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("rules/z.ts");
    expect(errors[0]).toContain("rules/a.ts");
  });

  it("이름 형식", () => {
    expect(RULE_NAME_PATTERN.test("fastest_2-x")).toBe(true);
    expect(RULE_NAME_PATTERN.test("가")).toBe(false);
  });
});

describe("rules.browser.ts (Vite import.meta.glob)", () => {
  it("저장소 rules/ 폴더의 룰을 오류 없이 모두 읽는다", () => {
    expect(BROWSER_RULES.errors).toEqual([]);
    const names = BROWSER_RULES.entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["greedy", "random", "fastest"]));
    expect(BROWSER_RULES.entries.find((e) => e.name === "fastest")?.ruleClass).toBe(FastestModule);
    expect(BROWSER_RULES.entries.find((e) => e.name === "greedy")?.ruleClass).toBe(GreedyRule);
  });

  it("createRegistry에 넘기면 내장 룰 파일은 겹치지 않고 fastest가 추가된다", () => {
    const registry = createRegistry(BROWSER_RULES.entries);
    expect(registry.errors).toEqual([]);
    const names = registry.policies.map((p) => p.name);
    expect(names.slice(0, POLICIES.length)).toEqual(POLICIES.map((p) => p.name));
    expect(names).toContain("fastest");
    expect(new Set(names).size).toBe(names.length);
  });
});
