// 처리 시간의 무작위성 (기획서 §9): 분포별 표본, 하한, 결정성, 재처리 재샘플, 진행률, 예상 대기 시간 정책.
import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/engine/metrics";
import { createRng, seedToState } from "../src/engine/rng";
import {
  currentProcessDuration,
  defaultRules,
  estimatedWaitTime,
  MIN_SAMPLED_PROCESS_TIME,
  processProgressRatio,
  remainingProcessTime,
} from "../src/engine/rules";
import { runHeadless } from "../src/engine/runner";
import type { ProcessTimeDist, Scenario, WorldState } from "../src/engine/types";
import { createWorld, step } from "../src/engine/world";
import { findScenario } from "../src/scenarios";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";
import { assign, findEvent, flatEvents, job, makeScenario, mod, runSteps, unassign } from "./helpers";

const MA = "MA";
const RA = "ra";
const MEAN = 2;
/** 표본 평균 수렴 검사용 표본 수 */
const SAMPLES = 20_000;
/** 표본 평균 허용 상대 오차 (표본 평균의 표준오차는 지수 분포에서 평균의 1/√SAMPLES ≈ 0.7%) */
const MEAN_TOLERANCE = 0.03;
/** 처리가 테스트 중에 끝나지 않을 만큼 큰 평균 */
const LONG = 1000;

function scenarioWith(dist: ProcessTimeDist | undefined, processTime = MEAN, seed = 1): Scenario {
  return makeScenario({
    modules: [{ id: MA, resultType: RA, processTime, ...(dist ? { processTimeDist: dist } : {}) }],
    initial: [[RA], [RA]],
    seed,
  });
}

/** 분포 dist로 표본을 n개 뽑는다 (규칙 sampleProcessTime 직접 호출) */
function samples(dist: ProcessTimeDist, n: number, seed = 7): number[] {
  const world = createWorld(scenarioWith(dist));
  const rng = createRng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(world.rules.sampleProcessTime(world, job(world, "J1"), mod(world, MA), () => rng.next()));
  return out;
}

/** 규칙으로 계산한 (작업, 모듈, 차수)의 처리 시간 표본 (엔진이 저장한 값과 비교용) */
function expectedSample(world: WorldState, jobId: string, moduleId: string, attempt: number): number {
  const j = job(world, jobId);
  const m = mod(world, moduleId);
  return world.rules.sampleProcessTime(world, j, m, world.rules.processTimeRandom(world, j, m, attempt));
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

describe("처리 시간 분포 표본 (rules.sampleProcessTime)", () => {
  it("fixed는 기대 처리 시간 그대로이고 난수를 부르지 않는다", () => {
    const world = createWorld(scenarioWith({ kind: "fixed" }));
    let calls = 0;
    const d = world.rules.sampleProcessTime(world, job(world, "J1"), mod(world, MA), () => {
      calls++;
      return 0.5;
    });
    expect(d).toBe(MEAN);
    expect(calls).toBe(0);
  });

  it("생략하면 엔진 모듈의 분포는 fixed다", () => {
    expect(mod(createWorld(scenarioWith(undefined)), MA).processTimeDist).toEqual({ kind: "fixed" });
  });

  it("exponential 표본 평균·표준편차가 processTime에 수렴한다", () => {
    const xs = samples({ kind: "exponential" }, SAMPLES);
    expect(Math.abs(mean(xs) / MEAN - 1)).toBeLessThan(MEAN_TOLERANCE);
    // 지수 분포는 표준편차 = 평균
    expect(Math.abs(std(xs) / MEAN - 1)).toBeLessThan(2 * MEAN_TOLERANCE);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(MIN_SAMPLED_PROCESS_TIME);
  });

  it("normal 표본 평균이 processTime, 표준편차가 cv × processTime에 수렴한다", () => {
    const cv = 0.3;
    const xs = samples({ kind: "normal", cv }, SAMPLES);
    expect(Math.abs(mean(xs) / MEAN - 1)).toBeLessThan(MEAN_TOLERANCE);
    expect(Math.abs(std(xs) / (cv * MEAN) - 1)).toBeLessThan(2 * MEAN_TOLERANCE);
  });

  it("normal은 하한 MIN_SAMPLED_PROCESS_TIME 아래를 잘라낸다", () => {
    const xs = samples({ kind: "normal", cv: 3 }, SAMPLES);
    expect(Math.min(...xs)).toBe(MIN_SAMPLED_PROCESS_TIME);
    expect(xs.every((x) => x >= MIN_SAMPLED_PROCESS_TIME)).toBe(true);
    // 음수 쪽이 많이 잘릴 만큼 cv가 크므로 실제로 잘린 표본이 있다
    expect(xs.filter((x) => x === MIN_SAMPLED_PROCESS_TIME).length).toBeGreaterThan(SAMPLES / 10);
  });

  it("평균은 교체된 processTime 규칙(기대 처리 시간)을 따른다", () => {
    const world = createWorld(scenarioWith({ kind: "exponential" }), { rules: { processTime: () => 10 } });
    const rng = createRng(3);
    const xs: number[] = [];
    for (let i = 0; i < SAMPLES; i++) xs.push(world.rules.sampleProcessTime(world, job(world, "J1"), mod(world, MA), () => rng.next()));
    expect(Math.abs(mean(xs) / 10 - 1)).toBeLessThan(MEAN_TOLERANCE);
  });

  it("같은 seed면 같은 표본열", () => {
    expect(samples({ kind: "normal", cv: 0.5 }, 50, 11)).toEqual(samples({ kind: "normal", cv: 0.5 }, 50, 11));
    expect(samples({ kind: "exponential" }, 50, 11)).not.toEqual(samples({ kind: "exponential" }, 50, 12));
  });
});

describe("엔진: 처리 시작 때 샘플링", () => {
  it("fixed(생략)이면 처리해도 월드 RNG를 소비하지 않는다", () => {
    const world = createWorld(scenarioWith(undefined));
    runSteps(world, 50, { 0: [assign("J1", MA)], 25: [assign("J2", MA)] });
    expect(world.rngState).toBe(seedToState(1));
    expect(world.completedCount).toBe(2);
  });

  it("무작위 분포면 processStarted 때 처리 전용 난수(차수 0)로 한 번 뽑아 저장하고, 월드 RNG는 쓰지 않는다", () => {
    const world = createWorld(scenarioWith({ kind: "exponential" }));
    step(world, [assign("J1", MA)]);
    const d = world.processDurations.get("J1");
    expect(d).toBe(expectedSample(world, "J1", MA, 0));
    expect(world.processAttempts.get("J1")?.get(MA)).toBe(1);
    // 도착용 월드 RNG는 처리 시간 표본에 쓰이지 않는다
    expect(world.rngState).toBe(seedToState(1));
    // 처리 중에는 다시 뽑지 않는다
    step(world, []);
    expect(world.processDurations.get("J1")).toBe(d);
    expect(world.processAttempts.get("J1")?.get(MA)).toBe(1);
    expect(currentProcessDuration(world, job(world, "J1"), mod(world, MA))).toBe(d);
  });

  it("처리 완료 시각은 뽑힌 실제 처리 시간을 dt 격자로 올린 값이다", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const world = createWorld(scenarioWith({ kind: "exponential" }, MEAN, seed));
      step(world, [assign("J1", MA)]);
      const d = world.processDurations.get("J1") ?? NaN;
      const events = [...world.events, ...flatEvents(runSteps(world, 2000))];
      const finished = findEvent(events, "processFinished", "J1");
      const dt = world.config.dt;
      const expected = Math.max(1, Math.ceil(d / dt - 1e-9)) * dt;
      expect(finished.t).toBeCloseTo(expected, 9);
      expect(world.processDurations.has("J1")).toBe(false);
    }
  });

  it("DONE_AT_MODULE 재처리는 새로 뽑는다", () => {
    // J1은 이 모듈에 없는 결과도 필요해서 처리가 끝나도 완료되지 않고 슬롯에 남는다 (occupyWhenDone=true)
    const world = createWorld(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: MEAN, processTimeDist: { kind: "normal", cv: 0.5 } }], initial: [[RA, "rb"]] }),
    );
    step(world, [assign("J1", MA)]);
    const first = world.processDurations.get("J1");
    for (let i = 0; i < 2000 && job(world, "J1").state !== "DONE_AT_MODULE"; i++) step(world, []);
    expect(job(world, "J1").state).toBe("DONE_AT_MODULE");
    expect(first).toBe(expectedSample(world, "J1", MA, 0));
    // 같은 모듈에 다시 배치 → 재처리 (차수 1의 표본)
    step(world, [assign("J1", MA)]);
    expect(job(world, "J1").state).toBe("PROCESSING");
    expect(world.processAttempts.get("J1")?.get(MA)).toBe(2);
    expect(world.processDurations.get("J1")).toBe(expectedSample(world, "J1", MA, 1));
    expect(world.processDurations.get("J1")).not.toBe(first);
  });

  it("처리 중 취소하면 저장값을 지우고, 다시 배치하면 새로 뽑는다", () => {
    const world = createWorld(scenarioWith({ kind: "exponential" }, LONG));
    step(world, [assign("J1", MA)]);
    const first = world.processDurations.get("J1");
    step(world, [unassign("J1")]);
    expect(world.processDurations.has("J1")).toBe(false);
    step(world, [assign("J1", MA)]);
    const second = world.processDurations.get("J1");
    expect(first).toBe(expectedSample(world, "J1", MA, 0));
    expect(second).toBe(expectedSample(world, "J1", MA, 1));
    expect(second).not.toBe(first);
  });

  it("진행률은 실제 처리 시간 기준이다", () => {
    const world = createWorld(scenarioWith({ kind: "exponential" }, LONG));
    step(world, [assign("J1", MA)]);
    const d = world.processDurations.get("J1") ?? NaN;
    const progress = job(world, "J1").progress;
    expect(processProgressRatio(world, "J1")).toBeCloseTo(Math.min(1, progress / d), 12);
    expect(d).not.toBe(LONG);
  });

  it("estimatedWaitTime·remainingProcessTime은 실제 표본이 아니라 기대 처리 시간 기준이다", () => {
    const world = createWorld(scenarioWith({ kind: "exponential" }, LONG));
    step(world, [assign("J1", MA)]);
    const progress = job(world, "J1").progress;
    expect(remainingProcessTime(world, "J1", MA)).toBeCloseTo(LONG - progress, 9);
    expect(estimatedWaitTime(world, MA)).toBeCloseTo(LONG - progress, 9);
    // 저장된 실제 처리 시간을 바꿔도 예상치는 그대로다 (감독관은 표본을 모른다)
    world.processDurations.set("J1", 1);
    expect(estimatedWaitTime(world, MA)).toBeCloseTo(LONG - progress, 9);
    expect(processProgressRatio(world, "J1")).toBeCloseTo(progress, 9);
  });

  it("기본 규칙의 sampleProcessTime은 defaultRules에 있다", () => {
    expect(typeof defaultRules.sampleProcessTime).toBe("function");
  });
});

describe("결정성과 기존 결과 보존", () => {
  function withDist(scenario: Scenario, dist: ProcessTimeDist): Scenario {
    return { ...scenario, modules: scenario.modules.map((m) => ({ ...m, processTimeDist: dist })) };
  }

  function run(scenario: Scenario): { world: WorldState; log: string } {
    const { world, commandLog } = runHeadless(scenario, createGreedySupervisor());
    return { world, log: JSON.stringify(commandLog) };
  }

  const basic = findScenario("basic")?.scenario;
  if (!basic) throw new Error("basic 시나리오 없음");

  it("fixed를 명시해도 생략과 비트 단위로 같다", () => {
    const a = run(basic);
    const b = run(withDist(basic, { kind: "fixed" }));
    expect(b.log).toBe(a.log);
    expect(computeMetrics(b.world)).toEqual(computeMetrics(a.world));
    expect(b.world.rngState).toBe(a.world.rngState);
  });

  it.each([
    ["exponential", { kind: "exponential" } as ProcessTimeDist],
    ["normal", { kind: "normal", cv: 0.4 } as ProcessTimeDist],
  ])("%s: 같은 seed면 같은 결과, 고정과는 다른 결과", (_label, dist) => {
    const a = run(withDist(basic, dist));
    const b = run(withDist(basic, dist));
    expect(b.log).toBe(a.log);
    expect(computeMetrics(b.world)).toEqual(computeMetrics(a.world));
    expect(a.log).not.toBe(run(basic).log);
  });
});
