// 지표 패널 표시 형식 테스트. DOM 없이 순수 포맷 함수와 metricsView만 검증한다.
import { describe, expect, it } from "vitest";
import type { Metrics } from "../src/engine/types";
import {
  EMPTY_VALUE,
  formatCount,
  formatNumber,
  formatPercent,
  formatRate,
  formatSeconds,
  metricsView,
} from "../src/ui/metricsPanel";

describe("포맷 함수", () => {
  it("formatNumber: 소수 자릿수 고정, null·NaN·무한대는 '-'", () => {
    expect(formatNumber(1.234, 1)).toBe("1.2");
    expect(formatNumber(2, 2)).toBe("2.00");
    expect(formatNumber(null, 1)).toBe(EMPTY_VALUE);
    expect(formatNumber(Number.NaN, 1)).toBe(EMPTY_VALUE);
    expect(formatNumber(Number.POSITIVE_INFINITY, 1)).toBe(EMPTY_VALUE);
  });

  it("formatNumber: -0 표시를 하지 않는다", () => {
    expect(formatNumber(-0, 1)).toBe("0.0");
    expect(formatNumber(-0.01, 1)).toBe("0.0");
  });

  it("formatCount: 정수", () => {
    expect(formatCount(12)).toBe("12");
    expect(formatCount(null)).toBe(EMPTY_VALUE);
  });

  it("formatSeconds: 초 단위 접미사", () => {
    expect(formatSeconds(84.34)).toBe("84.3s");
    expect(formatSeconds(0)).toBe("0.0s");
    expect(formatSeconds(null)).toBe(EMPTY_VALUE);
  });

  it("formatPercent: 비율 → 퍼센트", () => {
    expect(formatPercent(0.8)).toBe("80%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.1234, 1)).toBe("12.3%");
    expect(formatPercent(null)).toBe(EMPTY_VALUE);
  });

  it("formatRate: 개/초", () => {
    expect(formatRate(0.14)).toBe("0.140/s");
    expect(formatRate(null)).toBe(EMPTY_VALUE);
  });
});

function sampleMetrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    simTime: 84.3,
    completedCount: 12,
    spawnedCount: 20,
    throughput: 12 / 84.3,
    avgLeadTime: 21,
    avgWaitTime: null,
    poolWaitTime: 100,
    queueWaitTime: 50,
    wastedProcessCount: 3,
    uselessProcessCount: 2,
    cancelledProcessCount: 1,
    modules: [
      { id: "X1", utilization: 0.8, busyTime: 67.44, doneOccupiedTime: 4.25, queueLength: 2 },
      { id: "X2", utilization: 0, busyTime: 0, doneOccupiedTime: 0, queueLength: 0 },
    ],
    ...overrides,
  };
}

describe("metricsView", () => {
  it("요약 값을 형식에 맞춰 표시한다", () => {
    const view = metricsView(sampleMetrics());
    const byKey = new Map(view.summary.map((r) => [r.key, r.value]));
    expect(byKey.get("simTime")).toBe("84.3s");
    expect(byKey.get("completed")).toBe("12");
    expect(byKey.get("spawned")).toBe("20");
    expect(byKey.get("throughput")).toBe("0.142/s");
    expect(byKey.get("avgLeadTime")).toBe("21.0s");
    expect(byKey.get("avgWaitTime")).toBe(EMPTY_VALUE);
    expect(byKey.get("wasted")).toBe("3 (불필요 2 · 취소 1)");
  });

  it("모듈별 가동률·점유 낭비·대기열을 모듈 순서대로 표시한다", () => {
    const view = metricsView(sampleMetrics());
    expect(view.modules).toEqual([
      { id: "X1", utilization: "80%", doneOccupied: "4.3s", queueLength: "2" },
      { id: "X2", utilization: "0%", doneOccupied: "0.0s", queueLength: "0" },
    ]);
  });

  it("완료가 없으면 평균은 '-'", () => {
    const view = metricsView(sampleMetrics({ completedCount: 0, avgLeadTime: null, avgWaitTime: null }));
    const byKey = new Map(view.summary.map((r) => [r.key, r.value]));
    expect(byKey.get("avgLeadTime")).toBe(EMPTY_VALUE);
    expect(byKey.get("avgWaitTime")).toBe(EMPTY_VALUE);
  });
});
