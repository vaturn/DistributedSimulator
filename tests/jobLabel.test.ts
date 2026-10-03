// 작업 라벨·툴팁 글자를 만드는 순수 함수 테스트 (render/jobLabel.ts)
import { describe, expect, it } from "vitest";
import type { WorldState } from "../src/engine/types";
import { createWorld, step } from "../src/engine/world";
import {
  jobSlices,
  jobStateText,
  jobTooltipLines,
  legendItems,
  orderResults,
  remainingCaption,
  resultLabel,
  usefulModuleText,
} from "../src/render/jobLabel";
import { collectResultTypes, createResultColors, type ResultColors } from "../src/render/palette";
import { ACQUIRED_MARK, RESULT_LABEL_MAX_CHARS, TIME_DECIMALS } from "../src/render/theme";
import { assign, job, makeScenario, stepUntil } from "./helpers";

/** 처리가 테스트 중에 끝나지 않을 만큼 긴 처리 시간 */
const LONG = 100;
const MAX_STEPS = 100;

/**
 * 모듈 P(결과 X, 처리 1), Q(결과 Y), R(결과 Z). 작업 0: Z·X 필요(순서를 일부러 섞음), 작업 1: X 필요.
 */
function setup(): { world: WorldState; colors: ResultColors; ids: string[] } {
  const scenario = makeScenario({
    modules: [
      { id: "P", resultType: "X", processTime: 1, capacity: 1 },
      { id: "Q", resultType: "Y", processTime: LONG, capacity: 1 },
      { id: "R", resultType: "Z", processTime: LONG, capacity: 1 },
    ],
    initial: [["Z", "X"], ["X"]],
  });
  const world = createWorld(scenario);
  return { world, colors: createResultColors(collectResultTypes(scenario)), ids: [...world.jobs.keys()] };
}

describe("resultLabel / orderResults", () => {
  it("짧은 이름은 그대로, 긴 이름은 앞 글자만 쓴다", () => {
    expect(resultLabel("A")).toBe("A");
    expect(resultLabel("가나다라")).toBe("가나다라".slice(0, RESULT_LABEL_MAX_CHARS));
  });

  it("시나리오 결과 순서로 정렬한다", () => {
    const { colors } = setup();
    expect(orderResults(["Z", "X", "Y"], colors)).toEqual(["X", "Y", "Z"]);
  });
});

describe("jobSlices / remainingCaption", () => {
  it("처음에는 모든 조각이 남음이고 라벨에 체크가 없다", () => {
    const { world, colors, ids } = setup();
    expect(jobSlices(world, ids[0], colors)).toEqual([
      { result: "X", label: "X", acquired: false },
      { result: "Z", label: "Z", acquired: false },
    ]);
    expect(remainingCaption(world, ids[0], colors)).toBe("X·Z");
  });

  it("얻은 조각은 acquired이고 체크 표시가 붙는다. 남은 결과 라벨에서 빠진다", () => {
    const { world, colors, ids } = setup();
    step(world, [assign(ids[0], "P")]);
    stepUntil(world, (w) => job(w, ids[0]).acquired.has("X"), MAX_STEPS);
    expect(jobSlices(world, ids[0], colors)).toEqual([
      { result: "X", label: `X${ACQUIRED_MARK}`, acquired: true },
      { result: "Z", label: "Z", acquired: false },
    ]);
    expect(remainingCaption(world, ids[0], colors)).toBe("Z");
  });

  it("없는 작업은 조각이 없다", () => {
    const { world, colors } = setup();
    expect(jobSlices(world, "nope", colors)).toEqual([]);
  });
});

describe("jobStateText", () => {
  it("대기 구역 / 처리 중(진행률) / 대기열(순번)을 한국어로 쓴다", () => {
    const { world, ids } = setup();
    expect(jobStateText(world, job(world, ids[0]))).toContain("대기 구역");
    step(world, [assign(ids[0], "Q"), assign(ids[1], "Q")]);
    expect(jobStateText(world, job(world, ids[0]))).toMatch(/^Q에서 처리 중 \d+%$/);
    expect(jobStateText(world, job(world, ids[1]))).toBe("Q 대기열 1번째");
  });
});

describe("usefulModuleText / jobTooltipLines", () => {
  it("남은 결과를 주는 모듈만 결과 라벨과 함께 나열한다", () => {
    const { world, colors, ids } = setup();
    expect(usefulModuleText(world, ids[0], colors)).toBe("P(X), R(Z)");
    expect(usefulModuleText(world, ids[1], colors)).toBe("P(X)");
  });

  it("툴팁: id, 필요·얻은·남은 결과, 상태, 경과 시간, 유용 모듈", () => {
    const { world, colors, ids } = setup();
    step(world, [assign(ids[0], "P")]);
    stepUntil(world, (w) => job(w, ids[0]).acquired.has("X"), MAX_STEPS);
    const lines = jobTooltipLines(world, ids[0], colors);
    const texts = lines.map((l) => l.text);
    expect(texts[0]).toBe(`작업 ${ids[0]}`);
    expect(texts).toContain("필요한 결과: X · Z");
    expect(texts).toContain(`얻은 결과: X ${ACQUIRED_MARK}`);
    expect(texts).toContain("남은 결과: Z");
    expect(texts.some((t) => t.startsWith("상태: "))).toBe(true);
    const elapsed = world.simTime - job(world, ids[0]).createdAt;
    expect(texts).toContain(`생성 후 ${elapsed.toFixed(TIME_DECIMALS)}s`);
    expect(texts).toContain("남은 결과를 주는 모듈: R(Z)");
    expect(lines.find((l) => l.text.startsWith("남은 결과:"))?.tone).toBe("accent");
  });

  it("아직 아무것도 얻지 않았으면 얻은 결과는 없음", () => {
    const { world, colors, ids } = setup();
    expect(jobTooltipLines(world, ids[1], colors).map((l) => l.text)).toContain("얻은 결과: 없음");
  });

  it("없는 작업은 툴팁이 없다", () => {
    const { world, colors } = setup();
    expect(jobTooltipLines(world, "nope", colors)).toEqual([]);
  });
});

describe("legendItems", () => {
  it("결과 종류 순서대로 라벨과 팔레트 색을 준다", () => {
    const { colors } = setup();
    expect(legendItems(colors)).toEqual(
      ["X", "Y", "Z"].map((r) => ({ result: r, label: r, color: colors.colorOf(r) })),
    );
  });
});
