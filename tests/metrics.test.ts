// M4 지표 테스트 (기획서 §8). 손으로 계산할 수 있는 작은 시나리오로 검증한다.
import { describe, expect, it } from "vitest";
import basic from "../src/scenarios/basic.json";
import { computeMetrics } from "../src/engine/metrics";
import { defaultRules, isDoneOccupying, isWastedProcess, waitKind } from "../src/engine/rules";
import type { RuleSet } from "../src/engine/rules";
import type { Metrics, ModuleMetrics, Scenario } from "../src/engine/types";
import { createWorld, step } from "../src/engine/world";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";
import { TIME_DIGITS, assign, deepCopy, job, makeScenario, runSteps, unassign, worldFactory } from "./helpers";

// 테스트 픽스처 값 (엔진은 특정 id/결과 종류를 가정하지 않아야 한다)
const RA = "red";
const RB = "blue";
const MA = "mod-red";
const MB = "mod-blue";

const RULE_SETS: [string, RuleSet][] = [["defaultRules", defaultRules]];

function moduleMetrics(m: Metrics, id: string): ModuleMetrics {
  const found = m.modules.find((x) => x.id === id);
  if (!found) throw new Error(`모듈 지표 ${id} 없음`);
  return found;
}

describe.each(RULE_SETS)("지표 (%s)", (_name, rules) => {
  const make = worldFactory(rules);

  it("빈 world(simTime 0)에서는 비율이 0, 평균은 null이다", () => {
    const world = make(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 2 }], initial: [[RA], [RA]] }),
    );
    const m = computeMetrics(world);
    expect(m).toEqual({
      simTime: 0,
      completedCount: 0,
      spawnedCount: 2,
      throughput: 0,
      avgLeadTime: null,
      avgWaitTime: null,
      poolWaitTime: 0,
      queueWaitTime: 0,
      wastedProcessCount: 0,
      uselessProcessCount: 0,
      cancelledProcessCount: 0,
      modules: [{ id: MA, utilization: 0, busyTime: 0, doneOccupiedTime: 0, queueLength: 0 }],
    });
  });

  it("처리량, 평균 소요, 대기열 대기 시간, 가동률(용량 1)", () => {
    // 처리 시간 2, 용량 1. 두 작업을 t=0에 배치: J1은 t=2 완료, J2는 대기열에서 2s 기다렸다가 t=4 완료.
    const world = make(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 2 }], initial: [[RA], [RA]] }),
    );
    runSteps(world, 20, { 0: [assign("J1", MA), assign("J2", MA)] });
    let m = computeMetrics(world);
    expect(m.completedCount).toBe(1);
    expect(moduleMetrics(m, MA).queueLength).toBe(1);
    expect(m.queueWaitTime).toBeCloseTo(2, TIME_DIGITS);

    runSteps(world, 30); // simTime 5
    m = computeMetrics(world);
    expect(m.simTime).toBeCloseTo(5, TIME_DIGITS);
    expect(m.completedCount).toBe(2);
    expect(m.spawnedCount).toBe(2);
    expect(m.throughput).toBeCloseTo(2 / 5, TIME_DIGITS);
    expect(m.avgLeadTime).toBeCloseTo((2 + 4) / 2, TIME_DIGITS);
    expect(m.queueWaitTime).toBeCloseTo(2, TIME_DIGITS);
    expect(m.poolWaitTime).toBeCloseTo(0, TIME_DIGITS);
    expect(m.avgWaitTime).toBeCloseTo((0 + 2) / 2, TIME_DIGITS);
    const ma = moduleMetrics(m, MA);
    expect(ma.busyTime).toBeCloseTo(4, TIME_DIGITS);
    expect(ma.utilization).toBeCloseTo(4 / 5, TIME_DIGITS);
    expect(ma.queueLength).toBe(0);
    expect(m.wastedProcessCount).toBe(0);
  });

  it.each([
    { jobs: 1, busy: 1, utilization: 1 / 4 },
    { jobs: 2, busy: 2, utilization: 2 / 4 },
  ])("용량 2 모듈 가동률: 작업 $jobs개 → busyTime $busy, 가동률 $utilization", ({ jobs, busy, utilization }) => {
    const initial = Array.from({ length: jobs }, () => [RA]);
    const world = make(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 2 }], initial }),
    );
    const cmds = initial.map((_, i) => assign(`J${i + 1}`, MA));
    runSteps(world, 20, { 0: cmds }); // simTime 2
    const ma = moduleMetrics(computeMetrics(world), MA);
    expect(ma.busyTime).toBeCloseTo(busy, TIME_DIGITS);
    expect(ma.utilization).toBeCloseTo(utilization, TIME_DIGITS);
  });

  it("점유 낭비: occupyWhenDone=true이면 DONE_AT_MODULE로 머문 시간만 센다 (처리 구간 제외)", () => {
    // 처리 시간 1: t=1에 처리 끝 → t=3에 unassign 적용 → 점유 낭비 2s. 이후 대기 구역 1s.
    const world = make(
      makeScenario({
        modules: [
          { id: MA, resultType: RA, processTime: 1 },
          { id: MB, resultType: RB, processTime: 1 },
        ],
        initial: [[RA, RB]],
        config: { occupyWhenDone: true },
      }),
    );
    runSteps(world, 40, { 0: [assign("J1", MA)], 30: [unassign("J1")] }); // simTime 4
    const m = computeMetrics(world);
    const ma = moduleMetrics(m, MA);
    expect(ma.doneOccupiedTime).toBeCloseTo(2, TIME_DIGITS);
    expect(ma.busyTime).toBeCloseTo(1, TIME_DIGITS);
    expect(moduleMetrics(m, MB).doneOccupiedTime).toBe(0);
    expect(m.poolWaitTime).toBeCloseTo(1, TIME_DIGITS);
    expect(m.avgWaitTime).toBeNull();
  });

  it("점유 낭비: occupyWhenDone=false이면 0이고, 처리 끝 시각부터 대기 구역 대기로 센다", () => {
    const world = make(
      makeScenario({
        modules: [{ id: MA, resultType: RA, processTime: 1 }],
        initial: [[RA, RB]],
        config: { occupyWhenDone: false },
      }),
    );
    runSteps(world, 40, { 0: [assign("J1", MA)] }); // t=1에 대기 구역 복귀, simTime 4
    const m = computeMetrics(world);
    expect(moduleMetrics(m, MA).doneOccupiedTime).toBe(0);
    expect(m.poolWaitTime).toBeCloseTo(3, TIME_DIGITS);
  });

  it("대기 구역 대기: 배치되지 않은 작업은 simTime만큼, 배치 전까지만 센다", () => {
    const world = make(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 1 }], initial: [[RA], [RA]] }),
    );
    // J1은 t=0.5에 배치(t=1.5 완료), J2는 계속 대기 구역
    runSteps(world, 20, { 5: [assign("J1", MA)] }); // simTime 2
    const m = computeMetrics(world);
    expect(m.completedCount).toBe(1);
    expect(m.poolWaitTime).toBeCloseTo(0.5 + 2, TIME_DIGITS);
    expect(m.avgWaitTime).toBeCloseTo(0.5, TIME_DIGITS); // 완료 작업(J1)만
    expect(m.avgLeadTime).toBeCloseTo(1.5, TIME_DIGITS);
  });

  it("헛된 처리: 필요 없는 결과, 이미 가진 결과(같은 모듈 재처리), 취소를 센다", () => {
    const world = make(
      makeScenario({
        modules: [
          { id: MA, resultType: RA, processTime: 1 },
          { id: MB, resultType: RB, processTime: 1 },
        ],
        initial: [[RA], [RA, RB]],
      }),
    );
    runSteps(world, 30, {
      0: [assign("J1", MB), assign("J2", MA)], // J1: 필요 없는 결과 / J2: 유용
      10: [assign("J2", MA)], // J2: 이미 가진 결과로 같은 모듈 재처리 (t=1 → t=2)
      20: [assign("J1", MA), assign("J2", MB)], // J1: 유용(완료) / J2: 유용하지만 아래에서 취소
      25: [unassign("J2")], // 처리 중 취소
    });
    const m = computeMetrics(world);
    expect(m.uselessProcessCount).toBe(2);
    expect(m.cancelledProcessCount).toBe(1);
    expect(m.wastedProcessCount).toBe(3);
    expect(m.completedCount).toBe(1);
  });

  it("헛된 처리: 처리 시간이 dt 이하여서 한 step에 시작·종료해도 시작 시점으로 판정한다", () => {
    const world = make(
      makeScenario({
        modules: [{ id: MA, resultType: RA, processTime: 0.1 }],
        initial: [[RA, RB]],
      }),
    );
    runSteps(world, 1, { 0: [assign("J1", MA)] });
    expect(job(world, "J1").acquired.has(RA)).toBe(true);
    expect(computeMetrics(world).uselessProcessCount).toBe(0);
    runSteps(world, 1, { 0: [assign("J1", MA)] }); // 이미 가진 결과로 재처리
    expect(computeMetrics(world).uselessProcessCount).toBe(1);
  });

  it("판정 함수: waitKind, isDoneOccupying, isWastedProcess", () => {
    const world = make(
      makeScenario({
        modules: [
          { id: MA, resultType: RA, processTime: 1 },
          { id: MB, resultType: RB, processTime: 1 },
        ],
        initial: [[RA], [RA]],
      }),
    );
    expect(waitKind(job(world, "J1"))).toBe("pool");
    expect(isWastedProcess(world, "J1", MA)).toBe(false);
    expect(isWastedProcess(world, "J1", MB)).toBe(true);
    runSteps(world, 1, { 0: [assign("J1", MB), assign("J2", MB)] });
    expect(waitKind(job(world, "J1"))).toBeNull();
    expect(waitKind(job(world, "J2"))).toBe("queue");
    runSteps(world, 10);
    expect(isDoneOccupying(job(world, "J1"))).toBe(true);
  });

  it("computeMetrics는 world를 바꾸지 않는다", () => {
    const world = make(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 1 }], initial: [[RA], [RA]] }),
    );
    runSteps(world, 15, { 0: [assign("J1", MA), assign("J2", MA)] });
    const before = deepCopy(world);
    const first = computeMetrics(world);
    expect(world).toEqual(before);
    expect(computeMetrics(world)).toEqual(first);
  });
});

describe("지표 결정성", () => {
  function run(): Metrics {
    const scenario = basic as Scenario;
    const world = createWorld(scenario);
    const sup = createGreedySupervisor();
    for (let i = 0; i < 1000; i++) step(world, sup.decide(world));
    return computeMetrics(world);
  }

  it("같은 시나리오·시드·감독관이면 지표가 같다", () => {
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.spawnedCount).toBeGreaterThan(2);
    expect(a.completedCount).toBeGreaterThan(0);
  });
});
