import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/engine/metrics";
import {
  RUN_RESULT_VERSION,
  buildRunResult,
  compareMetrics,
  parseRunResult,
  serializeRunResult,
  type RunResult,
} from "../src/engine/report";
import { runHeadless } from "../src/engine/runner";
import { findScenario } from "../src/scenarios";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";

function run() {
  const entry = findScenario("basic");
  if (!entry) throw new Error("basic 없음");
  const { world, commandLog } = runHeadless(entry.scenario, createGreedySupervisor(), { seed: 42 });
  return { world, result: buildRunResult(world, { scenario: entry.name, policy: "greedy", seed: 42, scenarioSpec: entry.scenario, commandLog }), commandLog };
}

describe("실행 결과", () => {
  it("buildRunResult는 메타와 지표, 설정을 담는다", () => {
    const { world, result, commandLog } = run();
    expect(result.version).toBe(2);
    expect(RUN_RESULT_VERSION).toBe(2);
    expect(result.scenario).toBe("basic");
    expect(result.policy).toBe("greedy");
    expect(result.seed).toBe(42);
    expect(result.ended).toBe(true);
    expect(result.simTime).toBe(world.simTime);
    expect(result.metrics).toEqual(computeMetrics(world));
    expect(result.config).toEqual(world.config);
    expect(result.commandLog).toEqual(commandLog);
  });

  it("scenarioSpec은 실행에 쓴 시나리오 전체이고 seed는 실제 쓴 seed로 덮어쓴다", () => {
    const entry = findScenario("basic")!;
    const seed = entry.scenario.seed + 1;
    const { world, commandLog } = runHeadless(entry.scenario, createGreedySupervisor(), { seed });
    const result = buildRunResult(world, { scenario: "basic", policy: "greedy", seed, scenarioSpec: entry.scenario, commandLog });
    expect(result.scenarioSpec).toEqual({ ...entry.scenario, seed });
    // 원본 시나리오와 공유하지 않는다
    result.scenarioSpec.modules[0]!.processTime = 999;
    expect(entry.scenario.modules[0]!.processTime).not.toBe(999);
  });

  it("결과는 world와 공유하지 않는다", () => {
    const { world, result } = run();
    world.config.endCondition = { kind: "allDone" };
    expect(result.config.endCondition.kind).toBe("time");
  });

  it("serialize → JSON.parse 왕복이 같은 값을 준다 (들여쓰기 2)", () => {
    const { result } = run();
    const text = serializeRunResult(result);
    expect(text).toContain('\n  "version": 2');
    const back = JSON.parse(text) as RunResult;
    expect(back).toEqual(result);
  });

  it("중간에 멈춘 실행은 ended=false", () => {
    const entry = findScenario("basic")!;
    const { world, commandLog } = runHeadless(entry.scenario, createGreedySupervisor(), { maxSteps: 5 });
    const r = buildRunResult(world, { scenario: "basic", policy: "greedy", seed: entry.scenario.seed, scenarioSpec: entry.scenario, commandLog });
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

/** 저장했다 다시 읽은 것처럼 JSON 왕복한 값 */
function roundTrip(r: RunResult): Record<string, unknown> {
  return JSON.parse(serializeRunResult(r)) as Record<string, unknown>;
}

describe("parseRunResult", () => {
  it("serialize한 결과를 그대로 읽는다", () => {
    const { result } = run();
    expect(parseRunResult(roundTrip(result))).toEqual(result);
  });

  it("입력을 바꾸지 않고 새 객체를 준다", () => {
    const { result } = run();
    const data = roundTrip(result);
    const before = JSON.stringify(data);
    const parsed = parseRunResult(data);
    parsed.commandLog.length = 0;
    expect(JSON.stringify(data)).toBe(before);
  });

  /** 결과 JSON 하나를 고쳐서 오류 메시지를 확인한다 */
  function broken(edit: (d: Record<string, unknown>) => void): () => RunResult {
    const data = roundTrip(run().result);
    edit(data);
    return () => parseRunResult(data);
  }

  it.each<[string, (d: Record<string, unknown>) => void, RegExp]>([
    ["버전 1", (d) => (d.version = 1), /version.*지원하는 버전은 2/],
    ["scenarioSpec 없음", (d) => delete d.scenarioSpec, /scenarioSpec/],
    ["scenarioSpec 형식 오류", (d) => ((d.scenarioSpec as Record<string, unknown>).modules = []), /scenarioSpec.*모듈이 하나 이상/],
    ["scenarioSpec.seed 불일치", (d) => ((d.scenarioSpec as Record<string, unknown>).seed = 1), /scenarioSpec\.seed/],
    ["commandLog 배열 아님", (d) => (d.commandLog = {}), /commandLog.*배열/],
    ["step 음수", (d) => ((d.commandLog as Record<string, unknown>[])[0]!.step = -1), /commandLog\[0\]\.step/],
    [
      "알 수 없는 명령",
      (d) => ((d.commandLog as { commands: unknown[] }[])[0]!.commands = [{ type: "move", jobId: "J1" }]),
      /commands\[0\]\.type/,
    ],
    [
      "assign에 moduleId 없음",
      (d) => ((d.commandLog as { commands: unknown[] }[])[0]!.commands = [{ type: "assign", jobId: "J1" }]),
      /commands\[0\]\.moduleId/,
    ],
    ["metrics 형식 오류", (d) => ((d.metrics as Record<string, unknown>).completedCount = "3"), /metrics\.completedCount/],
    ["config 형식 오류", (d) => ((d.config as Record<string, unknown>).dt = 0), /config/],
    ["ended 형식 오류", (d) => (d.ended = "yes"), /ended/],
  ])("오류: %s", (_name, edit, message) => {
    expect(broken(edit)).toThrow(message);
    expect(broken(edit)).toThrow(/결과 파일 형식 오류/);
  });

  it("객체가 아니면 오류", () => {
    expect(() => parseRunResult(null)).toThrow(/결과 파일 형식 오류/);
    expect(() => parseRunResult([])).toThrow(/객체여야/);
  });
});

describe("compareMetrics", () => {
  it("같으면 빈 배열, EPSILON 이내 차이는 같다고 본다", () => {
    const { result } = run();
    const m = result.metrics;
    expect(compareMetrics(m, m)).toEqual([]);
    expect(compareMetrics(m, { ...m, throughput: m.throughput + 1e-12 })).toEqual([]);
  });

  it("다른 항목을 이름과 함께 알린다", () => {
    const m = run().result.metrics;
    const other = {
      ...m,
      completedCount: m.completedCount + 1,
      avgLeadTime: null,
      modules: m.modules.map((mm, i) => (i === 0 ? { ...mm, utilization: mm.utilization + 0.1 } : mm)),
    };
    const diffs = compareMetrics(m, other);
    expect(diffs).toHaveLength(3);
    expect(diffs[0]).toMatch(/^metrics\.completedCount: \d+ ≠ \d+$/);
    expect(diffs[1]).toMatch(/^metrics\.avgLeadTime: .* ≠ null$/);
    expect(diffs[2]).toContain(`metrics.modules[${m.modules[0]!.id}].utilization`);
  });

  it("모듈 개수나 id가 다르면 알린다", () => {
    const m = run().result.metrics;
    expect(compareMetrics(m, { ...m, modules: m.modules.slice(1) })[0]).toMatch(/modules 개수/);
    const renamed = { ...m, modules: m.modules.map((mm, i) => (i === 0 ? { ...mm, id: "ZZ" } : mm)) };
    expect(compareMetrics(m, renamed)[0]).toMatch(/modules\[0\]\.id/);
  });
});
