// 룰 API(RuleContext, ModuleRef, JobRef, ruleToSupervisor) 테스트
import { describe, expect, it } from "vitest";
import FastestModule from "../rules/fastestModule";
import { computeMetrics } from "../src/engine/metrics";
import { createRng } from "../src/engine/rng";
import {
  canAssign,
  estimatedWaitTime,
  remainingResults,
  usefulResults,
} from "../src/engine/rules";
import { runHeadless } from "../src/engine/runner";
import type { Scenario, WorldState } from "../src/engine/types";
import { createWorld, step } from "../src/engine/world";
import { findScenario } from "../src/scenarios";
import {
  type JobRef,
  type ModuleRef,
  RULE_LOG_LIMIT,
  Rule,
  type RuleClass,
  type RuleContext,
  isRuleClass,
  ruleToSupervisor,
} from "../src/supervisor/rule";
import { makeScenario, stateWithoutEvents, stepUntil } from "./helpers";

/** 모듈 2개(A 1초, B 2초·용량 2), 작업 3개 */
function smallScenario(config: Partial<Scenario["config"]> = {}): Scenario {
  return makeScenario({
    modules: [
      { id: "M1", resultType: "A", processTime: 1 },
      { id: "M2", resultType: "B", processTime: 2, capacity: 2 },
    ],
    initial: [["A", "B"], ["B"], ["A"]],
    config,
  });
}

/** decide에서 fn을 부르는 룰 클래스 */
function probeRule(fn: (ctx: RuleContext) => void, name = "probe"): RuleClass {
  return class extends Rule {
    name = name;
    decide(ctx: RuleContext): void {
      fn(ctx);
    }
  };
}

/** world에서 룰을 한 번 decide해서 명령과 감독관을 돌려준다 */
function decideOnce(world: WorldState, fn: (ctx: RuleContext) => void, seed = 1) {
  const sup = ruleToSupervisor(probeRule(fn), seed);
  const commands = sup.decide(world);
  return { sup, commands };
}

function req<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("값 없음");
  return value;
}

function jobIds(world: WorldState): string[] {
  return [...world.jobs.keys()];
}

describe("RuleContext 조회", () => {
  it("시각, dt, 모듈, 작업, 결과 종류를 엔진 상태 그대로 보여 준다", () => {
    const world = createWorld(smallScenario());
    decideOnce(world, (ctx) => {
      expect(ctx.time).toBe(world.simTime);
      expect(ctx.dt).toBe(world.config.dt);
      expect(ctx.modules().map((m) => m.id)).toEqual(["M1", "M2"]);
      expect(ctx.module("M2")?.capacity).toBe(2);
      expect(ctx.module("없음")).toBeUndefined();
      expect(ctx.jobs().map((j) => j.id)).toEqual(jobIds(world));
      expect(ctx.poolJobs().length).toBe(3);
      expect(ctx.queuedJobs()).toEqual([]);
      expect(ctx.processingJobs()).toEqual([]);
      expect(ctx.doneJobs()).toEqual([]);
      expect(ctx.resultTypes()).toEqual(["A", "B"]);
      // 같은 step 안에서는 같은 id면 같은 참조
      expect(ctx.module("M1")).toBe(ctx.modules()[0]);
      expect(ctx.jobs()[0]).toBe(ctx.poolJobs()[0]);
    });
  });

  it("상태별 작업 목록은 엔진의 작업 상태와 같다", () => {
    const world = createWorld(smallScenario());
    const [j1, j2, j3] = jobIds(world);
    step(world, [
      { type: "assign", jobId: req(j1), moduleId: "M1" },
      { type: "assign", jobId: req(j3), moduleId: "M1" },
      { type: "assign", jobId: req(j2), moduleId: "M2" },
    ]);
    stepUntil(world, (w) => w.jobs.get(req(j1))?.state === "DONE_AT_MODULE", 100);
    decideOnce(world, (ctx) => {
      for (const [list, state] of [
        [ctx.poolJobs(), "POOL"],
        [ctx.queuedJobs(), "QUEUED"],
        [ctx.processingJobs(), "PROCESSING"],
        [ctx.doneJobs(), "DONE_AT_MODULE"],
      ] as const) {
        const expected = [...world.jobs.values()].filter((j) => j.state === state).map((j) => j.id);
        expect(list.map((j) => j.id)).toEqual(expected);
      }
      expect(ctx.doneJobs().map((j) => j.id)).toEqual([j1]);
    });
  });
});

describe("ModuleRef", () => {
  it("값과 판정은 engine/rules.ts 함수 결과와 같다", () => {
    const world = createWorld(smallScenario());
    decideOnce(world, (ctx) => {
      for (const m of ctx.modules()) {
        const raw = req(world.modules.get(m.id));
        expect(m.resultType).toBe(raw.resultType);
        expect(m.processTime).toBe(raw.processTime);
        expect(m.capacity).toBe(raw.capacity);
        expect(m.isIdle()).toBe(true);
        expect(m.freeSlots()).toBe(raw.capacity);
        expect(m.queueLength()).toBe(0);
        expect(m.processingJobs()).toEqual([]);
        expect(m.estimatedWait()).toBe(estimatedWaitTime(world, m.id));
        for (const j of ctx.jobs()) {
          const rawJob = req(world.jobs.get(j.id));
          expect(m.processTimeFor(j)).toBe(world.rules.processTime(world, rawJob, raw));
          expect(m.canAccept(j)).toBe(canAssign(world, j.id, m.id).ok);
          expect(m.isUsefulFor(j)).toBe(usefulResults(world, j.id, m.id).length > 0);
        }
      }
    });
  });

  it("처리 중·대기열 상태를 반영한다", () => {
    const world = createWorld(smallScenario());
    const [j1, , j3] = jobIds(world);
    step(world, [
      { type: "assign", jobId: req(j1), moduleId: "M1" },
      { type: "assign", jobId: req(j3), moduleId: "M1" },
    ]);
    decideOnce(world, (ctx) => {
      const m1 = req(ctx.module("M1"));
      expect(m1.isIdle()).toBe(false);
      expect(m1.freeSlots()).toBe(0);
      expect(m1.queueLength()).toBe(1);
      expect(m1.processingJobs().map((j) => j.id)).toEqual([j1]);
      expect(m1.estimatedWait()).toBe(estimatedWaitTime(world, "M1"));
      const job3 = req(ctx.jobs().find((j) => j.id === j3));
      expect(m1.estimatedWait(job3)).toBe(estimatedWaitTime(world, "M1", { exceptJobId: j3 }));
    });
  });

  it("estimatedWait는 이번 step에 이 모듈로 요청한 작업을 줄에 포함한다", () => {
    const world = createWorld(smallScenario());
    const [j1, j2] = jobIds(world);
    decideOnce(world, (ctx) => {
      const m1 = req(ctx.module("M1"));
      const [a, b] = ctx.poolJobs();
      req(a).assignTo(m1);
      expect(m1.estimatedWait()).toBe(estimatedWaitTime(world, "M1", { extraJobIds: [req(j1)] }));
      req(b).assignTo(m1);
      expect(m1.estimatedWait(req(b))).toBe(
        estimatedWaitTime(world, "M1", { exceptJobId: req(j2), extraJobIds: [req(j1), req(j2)] }),
      );
      // 다른 모듈로 다시 요청하면 M1 줄에서 빠진다
      req(a).assignTo(req(ctx.module("M2")));
      expect(m1.estimatedWait()).toBe(estimatedWaitTime(world, "M1", { extraJobIds: [req(j2)] }));
    });
  });
});

describe("JobRef", () => {
  it("값과 판정은 엔진 상태와 rules 함수 결과와 같다", () => {
    const world = createWorld(smallScenario());
    decideOnce(world, (ctx) => {
      for (const j of ctx.jobs()) {
        const raw = req(world.jobs.get(j.id));
        expect(j.state).toBe(raw.state);
        expect(j.createdAt).toBe(raw.createdAt);
        expect(j.required()).toEqual([...raw.required]);
        expect(j.acquired()).toEqual([...raw.acquired]);
        expect(j.remaining()).toEqual(remainingResults(world, j.id));
        for (const r of ctx.resultTypes()) expect(j.needs(r)).toBe(remainingResults(world, j.id).includes(r));
        expect(j.location()).toBeNull();
        expect(j.waitTime()).toBe(0);
        expect(j.canUnassign()).toBe(false);
      }
    });
  });

  it("location은 있는 모듈(이동 중이면 목적지)을, waitTime은 누적 대기 시간을 준다", () => {
    const world = createWorld(smallScenario({ moveTime: 1 }));
    const [j1, j2] = jobIds(world);
    step(world, [{ type: "assign", jobId: req(j1), moduleId: "M1" }]);
    decideOnce(world, (ctx) => {
      const moving = req(ctx.jobs().find((j) => j.id === j1));
      expect(moving.state).toBe("MOVING");
      expect(moving.location()).toBe(ctx.module("M1"));
      expect(moving.canUnassign()).toBe(true);
      const waiting = req(ctx.jobs().find((j) => j.id === j2));
      expect(waiting.waitTime()).toBeCloseTo(world.metricsState.jobWait.get(req(j2)) ?? -1, 9);
      expect(waiting.waitTime()).toBeGreaterThan(0);
    });
  });

  it("required/acquired는 복사본이라 바꿔도 엔진 상태가 그대로다", () => {
    const world = createWorld(smallScenario());
    decideOnce(world, (ctx) => {
      const j = req(ctx.jobs()[0]);
      j.required().push("X");
      j.acquired().push("X");
      j.remaining().push("X");
      expect(j.required()).not.toContain("X");
      expect(j.acquired()).not.toContain("X");
    });
    for (const j of world.jobs.values()) {
      expect(j.required.has("X")).toBe(false);
      expect(j.acquired.has("X")).toBe(false);
    }
  });
});

describe("읽기 전용", () => {
  it("decide는 view를 바꾸지 않는다 (조회와 요청을 모두 해도)", () => {
    const world = createWorld(smallScenario());
    step(world, [{ type: "assign", jobId: req(jobIds(world)[0]), moduleId: "M1" }]);
    const before = stateWithoutEvents(world);
    decideOnce(world, (ctx) => {
      for (const j of ctx.jobs()) {
        j.required();
        j.remaining();
        j.location();
        j.waitTime();
        for (const m of ctx.modules()) {
          m.estimatedWait(j);
          m.canAccept(j);
          m.processTimeFor(j);
          j.assignTo(m);
        }
        j.unassign();
      }
      ctx.random();
      ctx.log("x");
    });
    expect(stateWithoutEvents(world)).toEqual(before);
  });

  it("참조 객체는 원본에 닿는 공개 필드가 없고 값을 바꿀 수 없다", () => {
    const world = createWorld(smallScenario());
    decideOnce(world, (ctx) => {
      const m = req(ctx.modules()[0]);
      const j = req(ctx.jobs()[0]);
      expect(Object.keys(m)).toEqual([]);
      expect(Object.keys(j)).toEqual([]);
      expect(Object.keys(ctx)).toEqual([]);
      expect(() => {
        (m as { capacity: number }).capacity = 99;
      }).toThrow(TypeError);
      expect(() => {
        (j as { state: string }).state = "COMPLETED";
      }).toThrow(TypeError);
    });
    expect(world.modules.get("M1")?.capacity).toBe(1);
  });
});

describe("명령 요청", () => {
  it("assignTo/unassign은 명령을 쌓기만 하고 decide가 요청 순서대로 돌려준다", () => {
    const world = createWorld(smallScenario());
    const [j1, j2] = jobIds(world);
    const before = stateWithoutEvents(world);
    const { commands } = decideOnce(world, (ctx) => {
      const [a, b] = ctx.poolJobs();
      expect(req(a).assignTo(req(ctx.module("M1")))).toBe(true);
      expect(req(b).assignTo(req(ctx.module("M2")))).toBe(true);
      // 요청해도 이번 step의 상태는 그대로
      expect(req(a).state).toBe("POOL");
    });
    expect(commands).toEqual([
      { type: "assign", jobId: j1, moduleId: "M1" },
      { type: "assign", jobId: j2, moduleId: "M2" },
    ]);
    expect(stateWithoutEvents(world)).toEqual(before);
  });

  it("같은 작업에 여러 번 요청하면 마지막 요청만 남고, 명령 순서는 마지막 요청 시점이다", () => {
    const world = createWorld(smallScenario());
    const [j1, j2] = jobIds(world);
    const { commands } = decideOnce(world, (ctx) => {
      const [a, b] = ctx.poolJobs();
      req(a).assignTo(req(ctx.module("M1")));
      req(b).assignTo(req(ctx.module("M1")));
      req(a).assignTo(req(ctx.module("M2")));
    });
    expect(commands).toEqual([
      { type: "assign", jobId: j2, moduleId: "M1" },
      { type: "assign", jobId: j1, moduleId: "M2" },
    ]);
  });

  it("assign 다음 unassign이면 unassign만 남는다", () => {
    const world = createWorld(smallScenario({ moveTime: 1 }));
    const [j1] = jobIds(world);
    step(world, [{ type: "assign", jobId: req(j1), moduleId: "M1" }]);
    const { commands } = decideOnce(world, (ctx) => {
      const j = req(ctx.jobs().find((x) => x.id === j1));
      j.assignTo(req(ctx.module("M2")));
      j.unassign();
    });
    expect(commands).toEqual([{ type: "unassign", jobId: j1 }]);
  });

  it("규칙이 거부하는 요청은 버리고 로그에 남기며, 앞서 받아들인 요청은 그대로 둔다", () => {
    // cancelOnMove=false: 처리 중 작업은 옮길 수 없다
    const world = createWorld(smallScenario({ cancelOnMove: false }));
    const [j1, j2] = jobIds(world);
    step(world, [{ type: "assign", jobId: req(j1), moduleId: "M1" }]);
    expect(world.jobs.get(req(j1))?.state).toBe("PROCESSING");
    const { sup, commands } = decideOnce(world, (ctx) => {
      const processing = req(ctx.processingJobs()[0]);
      expect(processing.assignTo(req(ctx.module("M2")))).toBe(false);
      expect(processing.unassign()).toBe(false);
      const pool = req(ctx.jobs().find((j) => j.id === j2));
      expect(pool.assignTo(req(ctx.module("M2")))).toBe(true);
      expect(pool.unassign()).toBe(false); // 대기 구역 작업은 회수할 수 없다
    });
    expect(commands).toEqual([{ type: "assign", jobId: j2, moduleId: "M2" }]);
    const logs = sup.drainLogs();
    expect(logs.length).toBe(3);
    expect(logs[0]?.message).toContain("배치 요청 거부");
    expect(logs[0]?.message).toContain(req(j1));
    expect(logs.every((l) => l.t === world.simTime)).toBe(true);
    // 버린 명령은 엔진에 가지 않으므로 warning도 생기지 않는다
    step(world, commands);
    expect(world.events.filter((e) => e.type === "warning")).toEqual([]);
  });

  it("decide가 끝나면 버퍼를 비우고 다음 step은 새로 쌓는다", () => {
    const world = createWorld(smallScenario({ moveTime: 1 }));
    let n = 0;
    const sup = ruleToSupervisor(
      probeRule((ctx) => {
        n++;
        if (n === 1) for (const j of ctx.poolJobs()) j.assignTo(req(ctx.module("M2")));
      }),
      1,
    );
    expect(sup.decide(world).length).toBe(3);
    expect(sup.decide(world)).toEqual([]);
  });
});

describe("ctx.log, init, random", () => {
  it("log는 시각과 함께 쌓이고 drainLogs가 꺼내며 비운다. 최대 줄 수를 넘으면 오래된 것부터 버린다", () => {
    const world = createWorld(smallScenario());
    const { sup } = decideOnce(world, (ctx) => {
      for (let i = 0; i < RULE_LOG_LIMIT + 5; i++) ctx.log(`m${i}`);
    });
    const logs = sup.drainLogs();
    expect(logs.length).toBe(RULE_LOG_LIMIT);
    expect(logs[0]).toEqual({ t: world.simTime, message: "m5" });
    expect(sup.drainLogs()).toEqual([]);
  });

  it("init은 첫 decide 직전에 한 번만 불리고, init에서 한 요청은 첫 step 명령에 들어간다", () => {
    const calls: string[] = [];
    class WithInit extends Rule {
      name = "withInit";
      init(ctx: RuleContext): void {
        calls.push(`init@${ctx.time}`);
        req(ctx.poolJobs()[0]).assignTo(req(ctx.module("M1")));
      }
      decide(ctx: RuleContext): void {
        calls.push(`decide@${ctx.time}`);
      }
    }
    const world = createWorld(smallScenario());
    const sup = ruleToSupervisor(WithInit, 1);
    const first = sup.decide(world);
    step(world, first);
    sup.decide(world);
    expect(first).toEqual([{ type: "assign", jobId: jobIds(world)[0], moduleId: "M1" }]);
    expect(calls).toEqual(["init@0", "decide@0", `decide@${world.simTime}`]);
  });

  it("ctx.random은 seed의 시드 RNG 순서를 실행 내내 이어 가고, 감독관마다 따로다", () => {
    const draws = (seed: number): number[] => {
      const world = createWorld(smallScenario());
      const out: number[] = [];
      const sup = ruleToSupervisor(
        probeRule((ctx) => {
          out.push(ctx.random(), ctx.random());
        }),
        seed,
      );
      sup.decide(world);
      sup.decide(world);
      return out;
    };
    const rng = createRng(5);
    expect(draws(5)).toEqual([rng.next(), rng.next(), rng.next(), rng.next()]);
    expect(draws(5)).toEqual(draws(5));
    expect(draws(5)).not.toEqual(draws(6));
  });

  it("룰 인스턴스는 감독관마다 새로 만든다 (필드 상태가 섞이지 않는다)", () => {
    class Counter extends Rule {
      name = "counter";
      count = 0;
      decide(ctx: RuleContext): void {
        this.count++;
        ctx.log(String(this.count));
      }
    }
    const world = createWorld(smallScenario());
    const a = ruleToSupervisor(Counter, 1);
    const b = ruleToSupervisor(Counter, 1);
    a.decide(world);
    a.decide(world);
    b.decide(world);
    expect(a.drainLogs().map((l) => l.message)).toEqual(["1", "2"]);
    expect(b.drainLogs().map((l) => l.message)).toEqual(["1"]);
  });

  it("감독관 이름과 표시 이름은 룰의 name, label (label이 없으면 name)", () => {
    expect(ruleToSupervisor(FastestModule, 1).name).toBe("fastest");
    expect(ruleToSupervisor(FastestModule, 1).label).toBe("가장 빨리 비는 모듈");
    expect(ruleToSupervisor(probeRule(() => {}, "nolabel"), 1).label).toBe("nolabel");
  });

  it("isRuleClass는 Rule 하위 클래스만 참이다", () => {
    expect(isRuleClass(FastestModule)).toBe(true);
    expect(isRuleClass(Rule)).toBe(false);
    expect(isRuleClass(class {})).toBe(false);
    expect(isRuleClass({ decide() {} })).toBe(false);
    expect(isRuleClass(undefined)).toBe(false);
  });
});

describe("예시 룰 rules/fastestModule.ts", () => {
  const basic = req(findScenario("basic")).scenario;

  it("basic에서 작업을 완료한다", () => {
    const { world } = runHeadless(basic, ruleToSupervisor(FastestModule, 42), { seed: 42 });
    expect(world.completedCount).toBeGreaterThan(0);
    expect(computeMetrics(world).wastedProcessCount).toBe(0);
  });

  it("같은 seed면 명령 로그와 지표가 같다", () => {
    const a = runHeadless(basic, ruleToSupervisor(FastestModule, 7), { seed: 7 });
    const b = runHeadless(basic, ruleToSupervisor(FastestModule, 7), { seed: 7 });
    expect(a.commandLog).toEqual(b.commandLog);
    expect(computeMetrics(a.world)).toEqual(computeMetrics(b.world));
  });
});

// 공개 타입(ModuleRef, JobRef)만으로 도우미 함수를 짤 수 있다
it("공개 타입 ModuleRef/JobRef로 함수를 짤 수 있다", () => {
  const pick = (job: JobRef, modules: ModuleRef[]): ModuleRef | undefined =>
    modules.filter((m) => m.isUsefulFor(job))[0];
  const world = createWorld(smallScenario());
  let picked: string | undefined;
  decideOnce(world, (ctx) => {
    picked = pick(req(ctx.poolJobs()[0]), ctx.modules())?.id;
  });
  expect(picked).toBe("M1");
});
