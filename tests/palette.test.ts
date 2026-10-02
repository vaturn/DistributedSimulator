import { describe, expect, it } from "vitest";
import type { Scenario } from "../src/engine/types";
import { collectResultTypes, createResultColors } from "../src/render/palette";
import { RESULT_PALETTE, UNKNOWN_RESULT_COLOR } from "../src/render/theme";

const scenario: Scenario = {
  name: "p",
  seed: 1,
  modules: [
    { id: "x1", resultType: "q", processTime: 1 },
    { id: "x2", resultType: "p", processTime: 1 },
  ],
  jobs: {
    initial: [{ required: ["p", "z"] }],
    arrival: { kind: "poisson", rate: 1, requiredPool: ["w", "q"], minReq: 1, maxReq: 1 },
  },
};

describe("결과 종류 색 배정", () => {
  it("시나리오에 처음 나온 순서로 결과 종류를 모은다", () => {
    expect(collectResultTypes(scenario)).toEqual(["q", "p", "z", "w"]);
  });

  it("순서 인덱스로 팔레트 색을 배정하고, 목록 밖은 기본 색을 쓴다", () => {
    const colors = createResultColors(collectResultTypes(scenario));
    expect(colors.colorOf("q")).toBe(RESULT_PALETTE[0]);
    expect(colors.colorOf("w")).toBe(RESULT_PALETTE[3]);
    expect(colors.colorOf("없음")).toBe(UNKNOWN_RESULT_COLOR);
  });

  it("팔레트보다 종류가 많으면 순환한다", () => {
    const many = Array.from({ length: RESULT_PALETTE.length + 1 }, (_, i) => `r${i}`);
    const colors = createResultColors(many);
    expect(colors.colorOf(`r${RESULT_PALETTE.length}`)).toBe(RESULT_PALETTE[0]);
  });
});
