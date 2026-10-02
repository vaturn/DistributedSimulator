// 리플레이 테스트 (기획서 §10 M6, §11 결정성): 저장된 결과의 시나리오와 명령 로그로 다시 실행하면 지표가 같다.
import { describe, expect, it } from "vitest";
import { type RunResult, buildRunResult, parseRunResult, replayRun, serializeRunResult } from "../src/engine/report";
import { runHeadless } from "../src/engine/runner";
import { SCENARIOS, findScenario } from "../src/scenarios";
import { POLICIES, findPolicy } from "../src/supervisor/registry";

const SEED = 42;

function recorded(scenarioName: string, policyName: string, maxSteps?: number): RunResult {
  const entry = findScenario(scenarioName)!;
  const policy = findPolicy(policyName)!;
  const { world, commandLog } = runHeadless(entry.scenario, policy.create(SEED), { seed: SEED, maxSteps });
  const result = buildRunResult(world, {
    scenario: entry.name,
    policy: policy.name,
    seed: SEED,
    scenarioSpec: entry.scenario,
    commandLog,
  });
  // 파일로 저장했다 다시 읽은 것과 같게 만든다.
  return parseRunResult(JSON.parse(serializeRunResult(result)) as unknown);
}

describe("replayRun", () => {
  const cases = SCENARIOS.flatMap((s) => POLICIES.map((p) => [s.name, p.name] as const));

  it.each(cases)("%s × %s: 재실행 결과가 저장된 결과와 같다", (scenario, policy) => {
    const result = recorded(scenario, policy);
    expect(result.commandLog.length).toBeGreaterThan(0);
    const replay = replayRun(result);
    expect(replay.mismatches).toEqual([]);
    expect(replay.matches).toBe(true);
    expect(replay.world.simTime).toBeCloseTo(result.simTime, 9);
  });

  it("중간에 멈춘 결과(ended=false)는 저장된 simTime까지만 재생한다", () => {
    const result = recorded("basic", "greedy", 37);
    expect(result.ended).toBe(false);
    const replay = replayRun(result);
    expect(replay.mismatches).toEqual([]);
    expect(replay.world.simTime).toBeCloseTo(result.simTime, 9);
  });

  it("명령 로그를 변조하면 불일치를 보고한다", () => {
    const result = recorded("basic", "greedy");
    const tampered: RunResult = { ...result, commandLog: result.commandLog.slice(0, Math.floor(result.commandLog.length / 2)) };
    const replay = replayRun(tampered);
    expect(replay.matches).toBe(false);
    expect(replay.mismatches.length).toBeGreaterThan(0);
    expect(replay.mismatches.some((m) => m.startsWith("metrics."))).toBe(true);
  });

  it("명령의 대상 모듈을 바꿔도 불일치를 보고한다", () => {
    const result = recorded("basic", "greedy");
    const moduleIds = result.scenarioSpec.modules.map((m) => m.id);
    const commandLog = result.commandLog.map((e) => ({
      ...e,
      commands: e.commands.map((c) =>
        c.type === "assign" ? { ...c, moduleId: moduleIds[(moduleIds.indexOf(c.moduleId) + 1) % moduleIds.length]! } : c,
      ),
    }));
    expect(replayRun({ ...result, commandLog }).matches).toBe(false);
  });

  it("시드를 바꾸면(도착이 달라져) 불일치를 보고한다", () => {
    const result = recorded("basic", "random");
    const seed = SEED + 1;
    const replay = replayRun({ ...result, seed, scenarioSpec: { ...result.scenarioSpec, seed } });
    expect(replay.matches).toBe(false);
  });

  it("저장된 지표를 바꾸면 그 항목을 알린다", () => {
    const result = recorded("basic", "greedy");
    const replay = replayRun({ ...result, metrics: { ...result.metrics, completedCount: result.metrics.completedCount + 1 } });
    expect(replay.mismatches).toEqual([
      `metrics.completedCount: ${result.metrics.completedCount + 1} ≠ ${result.metrics.completedCount}`,
    ]);
  });

  it("maxSteps보다 뒤의 명령이 남으면 알린다", () => {
    const result = recorded("basic", "greedy");
    const replay = replayRun(result, { maxSteps: 10 });
    expect(replay.matches).toBe(false);
    expect(replay.mismatches.some((m) => m.startsWith("commandLog:"))).toBe(true);
  });
});
