// 처리 시간 공통 난수 (기획서 §5.1·§9): 도착용 월드 RNG와 분리된 카운터(해시) 기반 처리 시간 난수.
import { describe, expect, it } from "vitest";
import ImmediateRule from "../rules/immediate";
import SequentialRule from "../rules/sequential";
import { combineState, deriveState, hashString, mix32, randomFromState, seedToState } from "../src/engine/rng";
import { deriveProcessTimeSeed, PROCESS_TIME_STREAM_SALT } from "../src/engine/rules";
import type { ProcessTimeDist, Scenario, SimEvent, WorldState } from "../src/engine/types";
import { createWorld, isEnded, step } from "../src/engine/world";
import { findScenario } from "../src/scenarios";
import type { RuleClass } from "../src/supervisor/rule";
import { ruleToSupervisor } from "../src/supervisor/rule";
import { assign, job, makeScenario, mod, runSteps } from "./helpers";

const MA = "MA";
const MB = "MB";
const RA = "ra";
const RB = "rb";
/** 난수열 비교 길이 */
const DRAWS = 8;
/** 무한 루프 방지용 최대 step 수 */
const MAX_STEPS = 100_000;

function draws(random: () => number, n = DRAWS): number[] {
  return Array.from({ length: n }, () => random());
}

describe("rng: 해시 기반 상태 파생", () => {
  it("hashString·mix32·combineState는 결정적이고 32비트 부호 없는 정수다", () => {
    expect(hashString("J1")).toBe(hashString("J1"));
    expect(hashString("J1")).not.toBe(hashString("J2"));
    expect(hashString("")).toBe(0x811c9dc5);
    for (const v of [hashString("MA"), mix32(123), combineState(1, 2, 3)]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(2 ** 32);
    }
    expect(combineState(1, 2, 3)).toBe(combineState(1, 2, 3));
    // 순서가 다르면 다른 상태
    expect(combineState(1, 2, 3)).not.toBe(combineState(3, 2, 1));
  });

  it("randomFromState는 같은 상태면 같은 [0,1) 난수열", () => {
    const a = draws(randomFromState(42));
    expect(draws(randomFromState(42))).toEqual(a);
    expect(draws(randomFromState(43))).not.toEqual(a);
    expect(a.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("처리 시간 시드는 seed에서 이름 붙은 salt로 파생되고, 도착용 상태와 다르다", () => {
    for (const seed of [0, 1, 42, 2 ** 31]) {
      expect(deriveProcessTimeSeed(seed)).toBe(deriveState(seed, PROCESS_TIME_STREAM_SALT));
      expect(deriveProcessTimeSeed(seed)).not.toBe(seedToState(seed));
    }
    expect(deriveProcessTimeSeed(1)).not.toBe(deriveProcessTimeSeed(2));
    expect(createWorld(makeScenario({ modules: [], initial: [], seed: 7 })).processTimeSeed).toBe(deriveProcessTimeSeed(7));
  });
});

describe("rules.processTimeRandom: (작업, 모듈, 차수) → 난수열", () => {
  const scenario = makeScenario({
    modules: [
      { id: MA, resultType: RA, processTime: 2, processTimeDist: { kind: "exponential" } },
      { id: MB, resultType: RB, processTime: 2, processTimeDist: { kind: "exponential" } },
    ],
    initial: [[RA, RB], [RA, RB]],
  });

  function seq(world: WorldState, jobId: string, moduleId: string, attempt: number): number[] {
    return draws(world.rules.processTimeRandom(world, job(world, jobId), mod(world, moduleId), attempt));
  }

  it("같은 작업·모듈·차수·seed면 다른 월드에서도 같은 난수열", () => {
    const a = createWorld(scenario);
    const b = createWorld(scenario);
    // b는 도착 RNG와 상관없이 여러 step을 진행해 둔다
    runSteps(b, 30, { 0: [assign("J2", MB)] });
    expect(seq(b, "J1", MA, 0)).toEqual(seq(a, "J1", MA, 0));
    expect(seq(b, "J1", MA, 3)).toEqual(seq(a, "J1", MA, 3));
  });

  it("작업·모듈·차수·seed 중 하나라도 다르면 다른 난수열", () => {
    const w = createWorld(scenario);
    const base = seq(w, "J1", MA, 0);
    expect(seq(w, "J2", MA, 0)).not.toEqual(base);
    expect(seq(w, "J1", MB, 0)).not.toEqual(base);
    expect(seq(w, "J1", MA, 1)).not.toEqual(base);
    expect(seq(createWorld({ ...scenario, seed: 2 }), "J1", MA, 0)).not.toEqual(base);
  });

  it("엔진: 배치 순서가 달라도 같은 작업의 같은 차수 처리는 같은 처리 시간", () => {
    // a: J1→MA, J2→MB / b: J2→MA, J1→MB (처리 시작 순서와 모듈이 다르다) → 각 (작업, 모듈) 쌍의 표본은 정해져 있다
    const durations = (cmds: ReturnType<typeof assign>[]): Map<string, number> => {
      const w = createWorld(scenario);
      step(w, cmds);
      return new Map([...w.processDurations]);
    };
    const a = durations([assign("J1", MA), assign("J2", MB)]);
    const b = durations([assign("J2", MB), assign("J1", MA)]);
    expect(b).toEqual(a);
    const c = durations([assign("J2", MA), assign("J1", MB)]);
    const w = createWorld(scenario);
    const expected = (jobId: string, moduleId: string): number => {
      const j = job(w, jobId);
      const m = mod(w, moduleId);
      return w.rules.sampleProcessTime(w, j, m, w.rules.processTimeRandom(w, j, m, 0));
    };
    expect(c.get("J2")).toBe(expected("J2", MA));
    expect(c.get("J1")).toBe(expected("J1", MB));
    expect(a.get("J1")).toBe(expected("J1", MA));
  });
});

describe("공통 난수: 도착열은 감독관·처리 시간 분포와 무관하다", () => {
  interface Arrival {
    jobId: string;
    t: number;
    required: string[];
  }

  function arrivals(sc: Scenario, RuleCtor: RuleClass): Arrival[] {
    const sup = ruleToSupervisor(RuleCtor, sc.seed);
    const world = createWorld(sc);
    const out: Arrival[] = [];
    for (let n = 0; n < MAX_STEPS && !isEnded(world); n++) {
      step(world, sup.decide(world));
      for (const e of world.events as SimEvent[]) {
        if (e.type !== "jobSpawned") continue;
        out.push({ jobId: e.jobId, t: e.t, required: [...job(world, e.jobId).required].sort() });
      }
    }
    return out;
  }

  const stream = findScenario("ab-stream")?.scenario;
  if (!stream) throw new Error("ab-stream 시나리오 없음");

  function withDist(sc: Scenario, dist: ProcessTimeDist): Scenario {
    return { ...sc, modules: sc.modules.map((m) => ({ ...m, processTimeDist: dist })) };
  }

  it.each([
    ["exponential", { kind: "exponential" } as ProcessTimeDist],
    ["normal", { kind: "normal", cv: 0.5 } as ProcessTimeDist],
  ])("%s: 순차·즉시가 같은 seed에서 같은 jobSpawned 시각·required", (_label, dist) => {
    for (const seed of [1, 2, 3]) {
      const sc = { ...withDist(stream, dist), seed };
      const seq = arrivals(sc, SequentialRule);
      const imm = arrivals(sc, ImmediateRule);
      expect(seq.length).toBeGreaterThan(10);
      expect(imm).toEqual(seq);
      // 처리 시간 분포를 바꿔도(고정) 도착열은 그대로다
      expect(arrivals({ ...stream, seed }, SequentialRule)).toEqual(seq);
    }
  });
});
