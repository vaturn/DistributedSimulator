// 작업 등장 방식 (기획서 §9): 몰려서 도착(batch)과 고정 간격 도착(interval).
import { describe, expect, it } from "vitest";
import { createRng, seedToState } from "../src/engine/rng";
import type { ArrivalSpec, Scenario, SimEvent } from "../src/engine/types";
import { createWorld, step } from "../src/engine/world";
import { makeScenario, runSteps } from "./helpers";

const POOL = ["ra", "rb"];
const MODULES: Scenario["modules"] = [
  { id: "MA", resultType: "ra", processTime: 1 },
  { id: "MB", resultType: "rb", processTime: 1 },
];
/** 평균 수렴 검사용 시뮬레이션 길이(step). dt 0.1이면 20000초 */
const LONG_STEPS = 200_000;
const TOLERANCE = 0.05;

function scenario(arrival: ArrivalSpec, seed = 1): Scenario {
  return makeScenario({ modules: MODULES, initial: [], arrival, seed });
}

function spawnsPerStep(eventsPerStep: SimEvent[][]): number[] {
  return eventsPerStep.map((events) => events.filter((e) => e.type === "jobSpawned").length);
}

const BATCH: ArrivalSpec = { kind: "batch", rate: 0.2, batchMin: 3, batchMax: 5, requiredPool: POOL, minReq: 1, maxReq: 2 };

describe("batch 도착", () => {
  it("묶음 크기만큼 같은 step에 생긴다 (batchMin = batchMax)", () => {
    const fixedSize: ArrivalSpec = { ...BATCH, rate: 1, batchMin: 4, batchMax: 4 };
    const counts = spawnsPerStep(runSteps(createWorld(scenario(fixedSize)), 2000));
    const nonZero = counts.filter((c) => c > 0);
    expect(nonZero.length).toBeGreaterThan(0);
    // 같은 step에 묶음이 두 개 올 수도 있으므로 4의 배수
    expect(nonZero.every((c) => c % 4 === 0)).toBe(true);
  });

  it("묶음 크기는 batchMin~batchMax이고 같은 step에 생성된다", () => {
    const counts = spawnsPerStep(runSteps(createWorld(scenario(BATCH)), 5000)).filter((c) => c > 0);
    // rate·dt가 작아 한 step에 묶음 둘이 오는 일은 드물다: 대부분의 step 생성 수가 3~5
    const inRange = counts.filter((c) => c >= BATCH.batchMin && c <= BATCH.batchMax).length;
    expect(inRange / counts.length).toBeGreaterThan(0.95);
    expect(new Set(counts.filter((c) => c <= 5))).toEqual(new Set([3, 4, 5]));
  });

  it("평균 작업 도착률 = rate × (batchMin + batchMax) / 2 에 수렴한다", () => {
    // 작업을 쌓지 않도록 규칙 arrivals를 직접 반복 호출한다 (dt 0.1 × LONG_STEPS = 20000초)
    const world = createWorld(scenario(BATCH, 5));
    const rng = createRng(5);
    const dt = world.config.dt;
    let total = 0;
    for (let i = 0; i < LONG_STEPS; i++) total += world.rules.arrivals(world, dt, () => rng.next()).length;
    const expected = 0.2 * ((3 + 5) / 2);
    const observed = total / (LONG_STEPS * dt);
    expect(Math.abs(observed / expected - 1)).toBeLessThan(TOLERANCE);
  });

  it("생성된 작업의 목표 결과는 requiredPool에서 minReq~maxReq개", () => {
    const world = createWorld(scenario(BATCH));
    runSteps(world, 2000);
    expect(world.jobs.size).toBeGreaterThan(0);
    for (const j of world.jobs.values()) {
      expect(j.required.size).toBeGreaterThanOrEqual(1);
      expect(j.required.size).toBeLessThanOrEqual(2);
      for (const r of j.required) expect(POOL).toContain(r);
    }
  });

  it("같은 seed면 같은 도착, 다른 seed면 다른 도착", () => {
    const run = (seed: number): string => {
      const world = createWorld(scenario(BATCH, seed));
      const counts = spawnsPerStep(runSteps(world, 2000));
      return JSON.stringify([counts, [...world.jobs.values()].map((j) => [...j.required])]);
    };
    expect(run(9)).toBe(run(9));
    expect(run(9)).not.toBe(run(10));
  });

  it("rate 0이면 도착 없음", () => {
    const world = createWorld(scenario({ ...BATCH, rate: 0 }));
    runSteps(world, 1000);
    expect(world.jobs.size).toBe(0);
  });
});

describe("interval 도착", () => {
  const INTERVAL: ArrivalSpec = { kind: "interval", every: 0.25, count: 2, requiredPool: POOL, minReq: 1, maxReq: 1 };

  it("시각 k·every 이상인 첫 step 시작에 count개씩 생긴다 (t=0에는 없음)", () => {
    const world = createWorld(scenario(INTERVAL));
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      step(world, []);
      for (const e of world.events) if (e.type === "jobSpawned") times.push(Math.round(e.t * 10) / 10);
    }
    // dt 0.1: 0.25→0.3, 0.5→0.5, 0.75→0.8, 1.0→1.0
    expect(times).toEqual([0.3, 0.3, 0.5, 0.5, 0.8, 0.8, 1.0, 1.0]);
  });

  it("평균 도착률 = count / every, 난수는 목표 결과를 고를 때만 쓴다", () => {
    const world = createWorld(scenario({ ...INTERVAL, every: 2, count: 3 }));
    runSteps(world, 1001); // step 시작 시각 0 ~ 100.0: 도착 시각 2, 4, ..., 100 (50번)
    expect(world.metricsState.spawnedCount).toBe(3 * 50);
    // requiredPool이 2개, minReq=maxReq=1 이라도 고르는 데 난수를 쓴다
    expect(world.rngState).not.toBe(seedToState(1));
  });
});
