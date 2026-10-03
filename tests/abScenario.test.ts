// 대표 시나리오(A·B 순차 vs 즉시) 테스트: ab-batch, ab-stream 시나리오와 sequential, immediate 룰.
import { describe, expect, it } from "vitest";
import ImmediateRule from "../rules/immediate";
import SequentialRule from "../rules/sequential";
import type { Command, Scenario, SimEvent, WorldState } from "../src/engine/types";
import { createWorld, isEnded, step } from "../src/engine/world";
import { findScenario } from "../src/scenarios/index";
import type { RuleClass } from "../src/supervisor/rule";
import { ruleToSupervisor } from "../src/supervisor/rule";
import { stateWithoutEvents } from "./helpers";

/** 무한 루프 방지용 최대 step 수 */
const MAX_STEPS = 100_000;
/** ab-stream에서 "대부분 완료"로 볼 최소 비율 */
const MOST_COMPLETED_RATIO = 0.9;

const RULES: readonly [string, RuleClass][] = [
  ["sequential", SequentialRule],
  ["immediate", ImmediateRule],
];

function scenario(name: string): Scenario {
  const entry = findScenario(name);
  if (!entry) throw new Error(`시나리오 ${name} 없음`);
  return entry.scenario;
}

interface RunResult {
  world: WorldState;
  events: SimEvent[];
  commandsByStep: Command[][];
  /** 작업별 required (완료된 작업은 월드에서 빠지므로 실행 중에 모아 둔다) */
  required: Map<string, string[]>;
}

function run(sc: Scenario, RuleCtor: RuleClass): RunResult {
  const sup = ruleToSupervisor(RuleCtor, sc.seed);
  const world = createWorld(sc);
  const events: SimEvent[] = [];
  const commandsByStep: Command[][] = [];
  const required = new Map<string, string[]>();
  const collect = (): void => {
    for (const j of world.jobs.values()) if (!required.has(j.id)) required.set(j.id, [...j.required]);
  };
  collect();
  for (let i = 0; i < MAX_STEPS && !isEnded(world); i++) {
    const cmds = sup.decide(world);
    commandsByStep.push(cmds);
    step(world, cmds);
    events.push(...world.events);
    collect();
  }
  return { world, events, commandsByStep, required };
}

/** 모든 작업이 완료된 시각 (마지막 jobCompleted) */
function makespan(events: SimEvent[]): number {
  return Math.max(...events.filter((e) => e.type === "jobCompleted").map((e) => e.t));
}

describe.each(["ab-batch", "ab-stream"])("시나리오 %s", (name) => {
  const sc = scenario(name);

  it("모든 초기 작업은 모듈이 주는 결과 전부를 필요로 한다", () => {
    const types = [...new Set(sc.modules.map((m) => m.resultType))];
    expect(sc.modules).toHaveLength(2);
    for (const j of sc.jobs.initial) expect([...j.required].sort()).toEqual([...types].sort());
  });

  it.each(RULES)("%s: 작업을 (대부분) 완료하고 warning이 없다", (_n, RuleCtor) => {
    const { world, events } = run(sc, RuleCtor);
    const created = world.nextJobNumber - 1;
    if (name === "ab-batch") expect(world.completedCount).toBe(created);
    else expect(world.completedCount).toBeGreaterThanOrEqual(Math.floor(created * MOST_COMPLETED_RATIO));
    expect(events.filter((e) => e.type === "warning")).toEqual([]);
  });

  it.each(RULES)("%s: 같은 시드면 결과가 같다", (_n, RuleCtor) => {
    const a = run(sc, RuleCtor);
    const b = run(sc, RuleCtor);
    expect(a.commandsByStep).toEqual(b.commandsByStep);
    expect(a.events).toEqual(b.events);
    expect(stateWithoutEvents(a.world)).toEqual(stateWithoutEvents(b.world));
  });

  it("sequential: 모든 작업이 required의 첫 결과를 먼저 얻는다 (처리 시작 순서)", () => {
    const { events, required } = run(sc, SequentialRule);
    const resultOf = new Map(sc.modules.map((m) => [m.id, m.resultType]));
    const firstStart = new Map<string, string>();
    for (const e of events) {
      if (e.type !== "processStarted" || firstStart.has(e.jobId) || !e.moduleId) continue;
      firstStart.set(e.jobId, resultOf.get(e.moduleId) ?? "");
    }
    expect(firstStart.size).toBeGreaterThan(0);
    for (const [jobId, result] of firstStart) {
      expect(result).toBe(required.get(jobId)?.[0]);
    }
  });

  it("immediate: 첫 step에 두 모듈을 모두 사용한다", () => {
    const { commandsByStep } = run(sc, ImmediateRule);
    const first = commandsByStep[0] ?? [];
    const modules = new Set(first.flatMap((c) => (c.type === "assign" ? [c.moduleId] : [])));
    expect(modules).toEqual(new Set(sc.modules.map((m) => m.id)));
  });

  it("두 룰 모두 빈 모듈에만 배치한다 (대기열이 생기지 않는다)", () => {
    for (const [, RuleCtor] of RULES) {
      const { events } = run(sc, RuleCtor);
      // 대기열에 들어갔다면 도착 시각과 처리 시작 시각이 다르다
      const arrived = new Map<string, number>();
      for (const e of events) {
        if (e.type === "jobArrived") arrived.set(`${e.jobId}@${e.moduleId}`, e.t);
        if (e.type === "processStarted") expect(e.t).toBe(arrived.get(`${e.jobId}@${e.moduleId}`));
      }
    }
  });
});

describe("ab-batch makespan", () => {
  it("immediate ≤ sequential (이론값: 즉시 N·T, 순차 N·T + T)", () => {
    const sc = scenario("ab-batch");
    const n = sc.jobs.initial.length;
    const t = sc.modules[0]?.processTime ?? 0;
    const seq = makespan(run(sc, SequentialRule).events);
    const imm = makespan(run(sc, ImmediateRule).events);
    expect(imm).toBeLessThanOrEqual(seq);
    expect(imm).toBeCloseTo(n * t, 6);
    expect(seq).toBeCloseTo(n * t + t, 6);
  });
});
