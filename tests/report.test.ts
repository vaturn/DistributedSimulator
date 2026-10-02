import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/engine/metrics";
import { buildRunResult, serializeRunResult, type RunResult } from "../src/engine/report";
import { runHeadless } from "../src/engine/runner";
import { findScenario } from "../src/scenarios";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";

function run() {
  const entry = findScenario("basic");
  if (!entry) throw new Error("basic 없음");
  const { world, commandLog } = runHeadless(entry.scenario, createGreedySupervisor(), { seed: 42 });
  return { world, result: buildRunResult(world, { scenario: entry.name, policy: "greedy", seed: 42, commandLog }), commandLog };
}

describe("실행 결과", () => {
  it("buildRunResult는 메타와 지표, 설정을 담는다", () => {
    const { world, result, commandLog } = run();
    expect(result.version).toBe(1);
    expect(result.scenario).toBe("basic");
    expect(result.policy).toBe("greedy");
    expect(result.seed).toBe(42);
    expect(result.ended).toBe(true);
    expect(result.simTime).toBe(world.simTime);
    expect(result.metrics).toEqual(computeMetrics(world));
    expect(result.config).toEqual(world.config);
    expect(result.commandLog).toEqual(commandLog);
  });

  it("결과는 world와 공유하지 않는다", () => {
    const { world, result } = run();
    world.config.endCondition = { kind: "allDone" };
    expect(result.config.endCondition.kind).toBe("time");
  });

  it("serialize → JSON.parse 왕복이 같은 값을 준다 (들여쓰기 2)", () => {
    const { result } = run();
    const text = serializeRunResult(result);
    expect(text).toContain('\n  "version": 1');
    const back = JSON.parse(text) as RunResult;
    expect(back).toEqual(result);
  });

  it("중간에 멈춘 실행은 ended=false", () => {
    const entry = findScenario("basic")!;
    const { world, commandLog } = runHeadless(entry.scenario, createGreedySupervisor(), { maxSteps: 5 });
    const r = buildRunResult(world, { scenario: "basic", policy: "greedy", seed: entry.scenario.seed, commandLog });
    expect(r.ended).toBe(false);
    expect(r.metrics.avgLeadTime).toBeNull();
    expect((JSON.parse(serializeRunResult(r)) as RunResult).metrics.avgLeadTime).toBeNull();
  });

  it("Map/Set이 섞이면 직렬화가 오류를 낸다", () => {
    const { result } = run();
    const bad = { ...result, extra: new Map() } as unknown as RunResult;
    expect(() => serializeRunResult(bad)).toThrow(/Map\/Set/);
  });
});
