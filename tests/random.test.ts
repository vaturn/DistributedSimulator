import { describe, expect, it } from "vitest";
import { canAssign } from "../src/engine/rules";
import type { Command } from "../src/engine/types";
import { createWorld, step } from "../src/engine/world";
import { findScenario } from "../src/scenarios";
import { createRandomSupervisor } from "../src/supervisor/policies/random";

function basicScenario() {
  const entry = findScenario("basic");
  if (!entry) throw new Error("basic 시나리오 없음");
  return entry.scenario;
}

/** 정책으로 n step 돌리며 step별 명령을 모은다. 명령마다 canAssign을 검사한다. */
function runCollect(seed: number, n: number): Command[][] {
  const world = createWorld(basicScenario());
  const sup = createRandomSupervisor(seed);
  const all: Command[][] = [];
  for (let i = 0; i < n; i++) {
    const cmds = sup.decide(world);
    for (const c of cmds) {
      expect(c.type).toBe("assign");
      if (c.type === "assign") expect(canAssign(world, c.jobId, c.moduleId).ok).toBe(true);
    }
    all.push(cmds);
    step(world, cmds);
  }
  return all;
}

describe("random 정책", () => {
  it("이름은 random이다", () => {
    expect(createRandomSupervisor(1).name).toBe("random");
  });

  it("같은 seed면 같은 명령을 낸다", () => {
    expect(runCollect(42, 500)).toEqual(runCollect(42, 500));
  });

  it("다른 seed면 보통 다른 명령을 낸다", () => {
    expect(runCollect(1, 500)).not.toEqual(runCollect(2, 500));
  });

  it("canAssign이 거부하는 명령은 내지 않고, 실제로 배치를 한다", () => {
    const all = runCollect(7, 1000);
    expect(all.flat().length).toBeGreaterThan(0);
  });

  it("basic(occupyWhenDone=false)에서 작업을 완료하고 처리 끝난 작업을 모듈에 남기지 않는다", () => {
    const scenario = basicScenario();
    expect(scenario.config?.occupyWhenDone).toBe(false);
    const world = createWorld(scenario);
    const sup = createRandomSupervisor(42);
    for (let i = 0; i < 3000; i++) {
      step(world, sup.decide(world));
      for (const j of world.jobs.values()) expect(j.state).not.toBe("DONE_AT_MODULE");
    }
    expect(world.completedCount).toBeGreaterThan(0);
  });

  it("view를 바꾸지 않는다", () => {
    const world = createWorld(basicScenario());
    const before = JSON.stringify([...world.jobs.values()].map((j) => [j.id, j.state, [...j.acquired]]));
    createRandomSupervisor(3).decide(world);
    expect(JSON.stringify([...world.jobs.values()].map((j) => [j.id, j.state, [...j.acquired]]))).toBe(before);
  });
});
