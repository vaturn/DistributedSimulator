// greedy 정책 감독관 테스트
import { describe, expect, it } from "vitest";
import basic from "../src/scenarios/basic.json";
import { usefulResults } from "../src/engine/rules";
import type { Command, Scenario, SimEvent, WorldState } from "../src/engine/types";
import { createWorld, isEnded, step } from "../src/engine/world";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";
import type { Supervisor } from "../src/supervisor/types";
import { deepCopy, makeScenario, stateWithoutEvents } from "./helpers";

const BASIC = basic as Scenario;
/** 무한 루프 방지용 최대 step 수 */
const MAX_STEPS = 100_000;

interface RunResult {
  world: WorldState;
  events: SimEvent[];
  commands: Command[];
}

/** 종료 조건까지 감독관으로 돌린다. onDecide는 명령을 적용하기 전에 불린다. */
function runWithSupervisor(
  scenario: Scenario,
  sup: Supervisor,
  onDecide?: (view: WorldState, commands: Command[]) => void,
): RunResult {
  const world = createWorld(scenario);
  const events: SimEvent[] = [];
  const commands: Command[] = [];
  for (let i = 0; i < MAX_STEPS && !isEnded(world); i++) {
    const cmds = sup.decide(world);
    onDecide?.(world, cmds);
    commands.push(...cmds);
    step(world, cmds);
    events.push(...world.events);
  }
  return { world, events, commands };
}

describe("greedy 감독관", () => {
  it("이름은 greedy", () => {
    expect(createGreedySupervisor().name).toBe("greedy");
  });

  it("basic 시나리오 300초: 작업을 완료하고 warning이 없다", () => {
    const { world, events } = runWithSupervisor(BASIC, createGreedySupervisor());
    expect(world.simTime).toBeGreaterThanOrEqual(300 - 1e-6);
    expect(world.completedCount).toBeGreaterThan(0);
    const warnings = events.filter((e) => e.type === "warning");
    expect(warnings).toEqual([]);
    // 보고용 요약
    console.info(
      `[greedy basic] completed=${world.completedCount} jobs=${world.nextJobNumber - 1} warnings=${warnings.length}`,
    );
  });

  it("같은 시드로 두 번 돌리면 결과가 같다", () => {
    const a = runWithSupervisor(BASIC, createGreedySupervisor());
    const b = runWithSupervisor(BASIC, createGreedySupervisor());
    expect(a.commands).toEqual(b.commands);
    expect(a.events).toEqual(b.events);
    expect(stateWithoutEvents(a.world)).toEqual(stateWithoutEvents(b.world));
  });

  it("필요한 결과를 주는 모듈로만 배치하고, 한 step에 같은 작업에 명령을 두 번 내지 않는다", () => {
    let checked = 0;
    runWithSupervisor(BASIC, createGreedySupervisor(), (view, cmds) => {
      const ids = cmds.map((c) => c.jobId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const c of cmds) {
        if (c.type !== "assign") continue;
        expect(usefulResults(view, c.jobId, c.moduleId).length).toBeGreaterThan(0);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(0);
  });

  it("가장 빨리 비는 모듈을 고르고 동점은 시나리오 순서로 깬다", () => {
    const scenario = makeScenario({
      modules: [
        { id: "slow", resultType: "x", processTime: 5 },
        { id: "fast", resultType: "x", processTime: 1 },
      ],
      initial: [["x"], ["x"], ["x"]],
    });
    const world = createWorld(scenario);
    // J1 → slow(동점, 앞쪽), J2 → fast(slow는 5 뒤에 빔), J3 → fast(1 뒤 vs 5 뒤)
    expect(createGreedySupervisor().decide(world)).toEqual([
      { type: "assign", jobId: "J1", moduleId: "slow" },
      { type: "assign", jobId: "J2", moduleId: "fast" },
      { type: "assign", jobId: "J3", moduleId: "fast" },
    ]);
  });

  it("DONE_AT_MODULE 작업을 다음 모듈로 옮기거나 회수해서 교착 없이 모두 완료한다", () => {
    const scenario = makeScenario({
      modules: [
        { id: "ma", resultType: "a", processTime: 1 },
        { id: "mb", resultType: "b", processTime: 2 },
      ],
      // "z"는 어떤 모듈도 주지 않는다 → 그 작업은 대기 구역으로 회수되어야 한다.
      initial: [["a", "b"], ["a", "b"], ["b", "a"], ["a"], ["a", "z"]],
      config: { endCondition: { kind: "time", value: 60 } },
    });
    const { world, events } = runWithSupervisor(scenario, createGreedySupervisor());
    expect(world.completedCount).toBe(4);
    for (const id of ["J1", "J2", "J3", "J4"]) expect(world.jobs.get(id)?.state).toBe("COMPLETED");
    // 완료 못 하는 작업은 슬롯을 점유하지 않고 대기 구역에 있다.
    expect(world.jobs.get("J5")?.state).toBe("POOL");
    expect(world.jobs.get("J5")?.acquired.has("a")).toBe(true);
    for (const m of world.modules.values()) expect(m.slots).toEqual([]);
    expect(events.filter((e) => e.type === "warning")).toEqual([]);
  });

  it("view를 바꾸지 않는다", () => {
    const sup = createGreedySupervisor();
    const world = createWorld(BASIC);
    for (let i = 0; i < 500; i++) {
      const before = deepCopy(world);
      const cmds = sup.decide(world);
      expect(world).toEqual(before);
      step(world, cmds);
    }
  });
});
