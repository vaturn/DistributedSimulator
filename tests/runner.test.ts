import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/engine/metrics";
import { createReplayDecider, recordCommands, runHeadless, type CommandLogEntry } from "../src/engine/runner";
import type { Scenario } from "../src/engine/types";
import { isEnded } from "../src/engine/world";
import { findScenario, SCENARIOS } from "../src/scenarios";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";
import { createRandomSupervisor } from "../src/supervisor/policies/random";
import { stateWithoutEvents } from "./helpers";

function scenario(name: string): Scenario {
  const s = findScenario(name)?.scenario;
  if (!s) throw new Error(`시나리오 ${name} 없음`);
  return s;
}

describe("recordCommands", () => {
  it("빈 명령은 기록하지 않고, 명령은 복사해서 기록한다", () => {
    const log: CommandLogEntry[] = [];
    recordCommands(log, 0, 0, []);
    const cmd = { type: "assign" as const, jobId: "J1", moduleId: "M1" };
    recordCommands(log, 3, 0.3, [cmd]);
    cmd.moduleId = "M2";
    expect(log).toEqual([{ step: 3, t: 0.3, commands: [{ type: "assign", jobId: "J1", moduleId: "M1" }] }]);
  });
});

describe("runHeadless", () => {
  it("basic + greedy는 종료 조건까지 돌고 작업을 완료한다", () => {
    const { world, commandLog } = runHeadless(scenario("basic"), createGreedySupervisor());
    expect(isEnded(world)).toBe(true);
    expect(world.simTime).toBeCloseTo(300, 6);
    expect(world.completedCount).toBeGreaterThan(0);
    expect(commandLog.length).toBeGreaterThan(0);
    expect(commandLog.every((e) => e.commands.length > 0)).toBe(true);
    // step 번호는 증가하고 t는 step × dt
    for (let i = 1; i < commandLog.length; i++) {
      expect(commandLog[i]!.step).toBeGreaterThan(commandLog[i - 1]!.step);
    }
    for (const e of commandLog) expect(e.t).toBeCloseTo(e.step * world.config.dt, 6);
  });

  it("같은 seed면 결과가 같다", () => {
    const a = runHeadless(scenario("basic"), createRandomSupervisor(5), { seed: 9 });
    const b = runHeadless(scenario("basic"), createRandomSupervisor(5), { seed: 9 });
    expect(a.commandLog).toEqual(b.commandLog);
    expect(computeMetrics(a.world)).toEqual(computeMetrics(b.world));
    expect(stateWithoutEvents(a.world)).toEqual(stateWithoutEvents(b.world));
  });

  it("seed 옵션은 시나리오 seed를 덮어쓴다", () => {
    const base = scenario("basic");
    const explicit = runHeadless(base, createGreedySupervisor(), { seed: base.seed });
    const implicit = runHeadless(base, createGreedySupervisor());
    expect(stateWithoutEvents(explicit.world)).toEqual(stateWithoutEvents(implicit.world));

    const other = runHeadless(base, createGreedySupervisor(), { seed: base.seed + 1 });
    const sameAsOther = runHeadless({ ...base, seed: base.seed + 1 }, createGreedySupervisor());
    expect(stateWithoutEvents(other.world)).toEqual(stateWithoutEvents(sameAsOther.world));
    expect(other.world.metricsState.spawnedCount).not.toBe(implicit.world.metricsState.spawnedCount);
    // 원본 시나리오는 바뀌지 않는다
    expect(base.seed).toBe(scenario("basic").seed);
  });

  it("maxSteps에서 멈춘다", () => {
    const { world } = runHeadless(scenario("basic"), createGreedySupervisor(), { maxSteps: 10 });
    expect(isEnded(world)).toBe(false);
    expect(world.simTime).toBeCloseTo(10 * world.config.dt, 9);
  });

  it("명령 로그를 재생하면 같은 최종 상태가 된다 (모든 시나리오, 두 정책)", () => {
    for (const { scenario: s } of SCENARIOS) {
      for (const make of [() => createGreedySupervisor(), () => createRandomSupervisor(11)]) {
        const original = runHeadless(s, make(), { seed: 3 });
        const replay = runHeadless(s, createReplayDecider(original.commandLog), { seed: 3 });
        expect(replay.commandLog).toEqual(original.commandLog);
        expect(stateWithoutEvents(replay.world)).toEqual(stateWithoutEvents(original.world));
      }
    }
  });
});
