import { describe, expect, it } from "vitest";
import { findPolicy, POLICIES } from "../src/supervisor/registry";

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
