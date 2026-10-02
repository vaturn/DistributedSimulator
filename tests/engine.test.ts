// M1 엔진 테스트 (기획서 §11). 엔진의 공개 API만 사용한다.
import { describe, expect, it } from "vitest";
import type { Command, Scenario } from "../src/engine/types";
import { canAssign, defaultRules } from "../src/engine/rules";
import type { RuleSet } from "../src/engine/rules";
import { createRng } from "../src/engine/rng";
import { apply, createWorld, isEnded, step } from "../src/engine/world";
import {
  EPS,
  TIME_DIGITS,
  assign,
  findEvent,
  flatEvents,
  hasEvent,
  job,
  makeScenario,
  mod,
  runSteps,
  stateWithoutEvents,
  stepUntil,
  unassign,
  worldFactory,
} from "./helpers";

// 테스트 픽스처 값 (엔진은 특정 id/결과 종류를 가정하지 않아야 한다)
const RA = "red";
const RB = "blue";
const MA = "mod-red";
const MB = "mod-blue";

// 같은 테스트를 다른 규칙 구현에도 돌릴 수 있게 파라미터화한다.
const RULE_SETS: [string, RuleSet][] = [["defaultRules", defaultRules]];

describe.each(RULE_SETS)("엔진 (%s)", (_name, rules) => {
  const make = worldFactory(rules);

  describe("§11-1 처리 시간", () => {
    it.each([
      { processTime: 2, dt: 0.1 },
      { processTime: 0.5, dt: 0.1 },
      { processTime: 3, dt: 0.25 },
      { processTime: 1.3, dt: 0.2 },
    ])("processTime=$processTime, dt=$dt 이면 약 ceil(t/dt) step 후 결과를 얻는다", ({ processTime, dt }) => {
      // 결과를 하나 얻어도 완료되지 않도록 required에 다른 결과를 함께 둔다.
      const world = make(
        makeScenario({
          modules: [
            { id: MA, resultType: RA, processTime },
            { id: MB, resultType: RB, processTime: 1 },
          ],
          initial: [[RA, RB]],
          config: { dt },
        }),
      );
      const expected = Math.ceil(processTime / dt - EPS);

      step(world, [assign("J1", MA)]);
      expect(job(world, "J1").state).toBe("PROCESSING");
      expect(job(world, "J1").acquired.has(RA)).toBe(false);

      // 결과를 얻은 step 번호 (assign한 step이 1번)
      let gotAt = 1;
      while (!job(world, "J1").acquired.has(RA)) {
        expect(job(world, "J1").state).toBe("PROCESSING");
        step(world, []);
        gotAt++;
        if (gotAt > expected + 5) break;
      }
      const finishEventSeen = world.events.some(
        (e) => e.type === "processFinished" && e.jobId === "J1" && e.moduleId === MA,
      );

      expect(Math.abs(gotAt - expected)).toBeLessThanOrEqual(1);
      expect(finishEventSeen).toBe(true);
      // 경과 시간도 t의 dt 오차 이내
      expect(Math.abs(gotAt * dt - processTime)).toBeLessThanOrEqual(dt + EPS);
      const j = job(world, "J1");
      expect(j.state).toBe("DONE_AT_MODULE");
      expect(j.location).toEqual({ kind: "module", moduleId: MA });
      expect([...j.acquired]).toEqual([RA]);
      expect(world.completedCount).toBe(0);
    });

    it("결과를 얻기 전 step에는 processFinished 이벤트가 없다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA, RB]],
          config: { dt: 0.1 },
        }),
      );
      const events = runSteps(world, 30, { 0: [assign("J1", MA)] });
      const finishSteps = events
        .map((evs, i) => (hasEvent(evs, "processFinished", "J1") ? i + 1 : -1))
        .filter((i) => i > 0);
      // 정확히 한 번, 10 step ± 1 에서
      expect(finishSteps).toHaveLength(1);
      expect(Math.abs(finishSteps[0]! - 10)).toBeLessThanOrEqual(1);
      // 처리가 끝난 뒤에는 같은 결과를 다시 얻지 않고 머문다
      expect(job(world, "J1").state).toBe("DONE_AT_MODULE");
    });
  });

  describe("완료·처리 시각 = step이 끝난 뒤의 시각", () => {
    it.each([
      { processTime: 2, dt: 0.1 },
      { processTime: 0.5, dt: 0.1 },
      { processTime: 3, dt: 0.25 },
      { processTime: 1.2, dt: 0.2 },
      { processTime: 1.3, dt: 0.2 },
    ])(
      "processTime=$processTime, dt=$dt 를 t=0에 배치하면 processFinished·jobCompleted·completedAt이 ceil(t/dt)·dt이다",
      ({ processTime, dt }) => {
        const world = make(
          makeScenario({
            modules: [{ id: MA, resultType: RA, processTime }],
            initial: [[RA]],
            config: { dt },
          }),
        );
        const steps = Math.ceil(processTime / dt - EPS);
        const expectedTime = steps * dt;
        const events = runSteps(world, steps, { 0: [assign("J1", MA)] });
        const all = flatEvents(events);

        expect(findEvent(all, "processStarted", "J1").t).toBe(0);
        // 마지막 step에서 처리와 완료가 함께 일어난다
        expect(hasEvent(events[steps - 1]!, "processFinished", "J1")).toBe(true);
        expect(hasEvent(events[steps - 1]!, "jobCompleted", "J1")).toBe(true);
        expect(findEvent(all, "processFinished", "J1").t).toBeCloseTo(expectedTime, TIME_DIGITS);
        expect(findEvent(all, "jobCompleted", "J1").t).toBeCloseTo(expectedTime, TIME_DIGITS);
        expect(job(world, "J1").completedAt!).toBeCloseTo(expectedTime, TIME_DIGITS);
        // step 끝 시각과 다음 simTime은 같은 계산이다
        expect(job(world, "J1").completedAt).toBe(world.simTime);
      },
    );

    it("처리 시간 2인 작업을 t=0에 배치하면 완료 시각이 정확히 2.0이다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 2 }],
          initial: [[RA]],
          config: { dt: 0.1 },
        }),
      );
      const all = flatEvents(runSteps(world, 20, { 0: [assign("J1", MA)] }));
      expect(findEvent(all, "processFinished", "J1").t).toBeCloseTo(2, TIME_DIGITS);
      expect(findEvent(all, "jobCompleted", "J1").t).toBeCloseTo(2, TIME_DIGITS);
      expect(job(world, "J1").completedAt!).toBeCloseTo(2, TIME_DIGITS);
      expect(job(world, "J1").state).toBe("COMPLETED");
    });

    it("완료되지 않는 처리 끝(processFinished)도 step 끝 시각으로 기록한다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 2 }],
          initial: [[RA, RB]],
          config: { dt: 0.1 },
        }),
      );
      const all = flatEvents(runSteps(world, 25, { 0: [assign("J1", MA)] }));
      expect(findEvent(all, "processFinished", "J1").t).toBeCloseTo(2, TIME_DIGITS);
      expect(hasEvent(all, "jobCompleted", "J1")).toBe(false);
      expect(job(world, "J1").completedAt).toBeUndefined();
    });

    it("t=0.5에 배치하면 처리 시간 1 뒤인 1.5에 완료된다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA]],
          config: { dt: 0.1 },
        }),
      );
      const all = flatEvents(runSteps(world, 15, { 5: [assign("J1", MA)] }));
      expect(findEvent(all, "processStarted", "J1").t).toBeCloseTo(0.5, TIME_DIGITS);
      expect(findEvent(all, "processFinished", "J1").t).toBeCloseTo(1.5, TIME_DIGITS);
      expect(job(world, "J1").completedAt!).toBeCloseTo(1.5, TIME_DIGITS);
    });

    it("대기열에서 이어 받은 작업은 앞 작업 완료 시각부터 처리 시간 뒤에 완료된다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA], [RA]],
          config: { dt: 0.1 },
        }),
      );
      const all = flatEvents(runSteps(world, 20, { 0: [assign("J1", MA), assign("J2", MA)] }));
      expect(job(world, "J1").completedAt!).toBeCloseTo(1, TIME_DIGITS);
      expect(findEvent(all, "processStarted", "J2").t).toBeCloseTo(1, TIME_DIGITS);
      expect(job(world, "J2").completedAt!).toBeCloseTo(2, TIME_DIGITS);
    });
  });

  describe("용량 N = 독립 슬롯 N개의 병렬 처리", () => {
    it("capacity 2 모듈의 두 슬롯은 각자의 progress로 처리 시간을 따로 센다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 2 }],
          initial: [[RA], [RA]],
          config: { dt: 0.1 },
        }),
      );
      // J1은 t=0, J2는 t=0.5에 배치
      const events = runSteps(world, 8, { 0: [assign("J1", MA)], 5: [assign("J2", MA)] });
      expect(world.simTime).toBeCloseTo(0.8, TIME_DIGITS);
      expect(job(world, "J1").state).toBe("PROCESSING");
      expect(job(world, "J2").state).toBe("PROCESSING");
      expect(job(world, "J1").progress).toBeCloseTo(0.8, TIME_DIGITS);
      expect(job(world, "J2").progress).toBeCloseTo(0.3, TIME_DIGITS);
      expect(findEvent(flatEvents(events), "processStarted", "J2").t).toBeCloseTo(0.5, TIME_DIGITS);

      runSteps(world, 10);
      // 앞 작업이 끝나기를 기다리지 않고 각자 처리 시간 1 뒤에 완료된다
      expect(job(world, "J1").completedAt!).toBeCloseTo(1, TIME_DIGITS);
      expect(job(world, "J2").completedAt!).toBeCloseTo(1.5, TIME_DIGITS);
    });

    it("두 슬롯이 처리 중이면 busyTime이 step마다 2·dt씩 늘어난다", () => {
      const dt = 0.1;
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 2 }],
          // 결과를 얻어도 완료되지 않고 DONE_AT_MODULE로 머물게 한다
          initial: [[RA, RB], [RA, RB]],
          config: { dt },
        }),
      );
      step(world, [assign("J1", MA), assign("J2", MA)]);
      expect(mod(world, MA).busyTime).toBeCloseTo(2 * dt, TIME_DIGITS);
      for (let i = 2; i <= 10; i++) {
        const before = mod(world, MA).busyTime;
        step(world, []);
        expect(mod(world, MA).busyTime - before).toBeCloseTo(2 * dt, TIME_DIGITS);
      }
      // 처리 시간 1 × 슬롯 2 = 2
      expect(mod(world, MA).busyTime).toBeCloseTo(2, TIME_DIGITS);
      // 가동률 = busyTime / (simTime × capacity) = 100%
      const m = mod(world, MA);
      expect(m.busyTime / (world.simTime * m.capacity)).toBeCloseTo(1, TIME_DIGITS);

      // DONE_AT_MODULE로 점유 중인 슬롯은 가동 시간에 들어가지 않는다
      runSteps(world, 10);
      expect(job(world, "J1").state).toBe("DONE_AT_MODULE");
      expect(mod(world, MA).busyTime).toBeCloseTo(2, TIME_DIGITS);
      expect(m.busyTime / (world.simTime * m.capacity)).toBeCloseTo(0.5, TIME_DIGITS);
    });

    it("capacity 2에 한 작업만 처리 중이면 busyTime은 step마다 dt씩 늘어난다", () => {
      const dt = 0.1;
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 2 }],
          initial: [[RA], [RA]],
          config: { dt },
        }),
      );
      // J1: t=0~1, J2: t=0.5~1.5 → 겹치는 0.5~1.0 동안만 2·dt
      const busyPerStep: number[] = [];
      for (let i = 0; i < 20; i++) {
        const before = mod(world, MA).busyTime;
        step(world, i === 0 ? [assign("J1", MA)] : i === 5 ? [assign("J2", MA)] : []);
        busyPerStep.push(mod(world, MA).busyTime - before);
      }
      busyPerStep.forEach((delta, i) => {
        const slots = (i < 10 ? 1 : 0) + (i >= 5 && i < 15 ? 1 : 0);
        expect(delta).toBeCloseTo(slots * dt, TIME_DIGITS);
      });
      expect(mod(world, MA).busyTime).toBeCloseTo(2, TIME_DIGITS);
    });

    it("capacity 1 모듈의 busyTime은 처리 시간과 같다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1.5 }],
          initial: [[RA]],
          config: { dt: 0.1 },
        }),
      );
      runSteps(world, 30, { 0: [assign("J1", MA)] });
      expect(mod(world, MA).busyTime).toBeCloseTo(1.5, TIME_DIGITS);
    });
  });

  describe("§11-2 완료", () => {
    it("required를 모두 얻은 순간 COMPLETED가 되고 모듈에서 빠지며 completedCount가 증가한다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA]],
          config: { dt: 0.1 },
        }),
      );
      step(world, [assign("J1", MA)]);
      let before = world.simTime;
      while (!job(world, "J1").acquired.has(RA)) {
        expect(job(world, "J1").state).not.toBe("COMPLETED");
        expect(world.completedCount).toBe(0);
        before = world.simTime;
        step(world, []);
        if (world.simTime > 3) break;
      }
      const j = job(world, "J1");
      // 결과를 얻은 바로 그 step에서 완료된다
      expect(j.state).toBe("COMPLETED");
      expect(hasEvent(world.events, "processFinished", "J1")).toBe(true);
      expect(hasEvent(world.events, "jobCompleted", "J1")).toBe(true);
      expect(world.completedCount).toBe(1);
      expect(j.completedAt).toBeDefined();
      expect(j.completedAt!).toBeGreaterThanOrEqual(before - EPS);
      expect(j.completedAt!).toBeLessThanOrEqual(world.simTime + EPS);
      // 완료 시각은 완료된 step이 끝난 뒤의 시각이다 (처리 시간 1 → 1.0)
      expect(j.completedAt!).toBe(world.simTime);
      expect(j.completedAt!).toBeCloseTo(1, TIME_DIGITS);
      // 모듈에서 제거된다
      expect(mod(world, MA).slots).not.toContain("J1");
      expect(mod(world, MA).queue).not.toContain("J1");
      // 작업 기록은 남는다
      expect(world.jobs.has("J1")).toBe(true);

      // 이후 step에서 다시 완료 처리되지 않는다
      const later = runSteps(world, 20);
      expect(later.some((evs) => hasEvent(evs, "jobCompleted", "J1"))).toBe(false);
      expect(world.completedCount).toBe(1);
    });

    it("결과 일부만 얻으면 완료되지 않고, 나머지를 얻은 순간 완료된다 (순서 무관)", () => {
      const world = make(
        makeScenario({
          modules: [
            { id: MA, resultType: RA, processTime: 1 },
            { id: MB, resultType: RB, processTime: 0.5 },
          ],
          initial: [[RB, RA]],
          config: { dt: 0.1 },
        }),
      );
      step(world, [assign("J1", MA)]);
      stepUntil(world, (w) => job(w, "J1").state === "DONE_AT_MODULE", 20);
      expect(world.completedCount).toBe(0);
      expect(job(world, "J1").completedAt).toBeUndefined();

      // 다른 모듈로 옮긴다: 원래 모듈의 슬롯이 비고 새 모듈에서 처리된다
      step(world, [assign("J1", MB)]);
      expect(mod(world, MA).slots).not.toContain("J1");
      expect(job(world, "J1").state).toBe("PROCESSING");
      expect(job(world, "J1").location).toEqual({ kind: "module", moduleId: MB });
      expect(job(world, "J1").acquired.has(RA)).toBe(true);

      stepUntil(world, (w) => job(w, "J1").state === "COMPLETED", 10);
      expect(hasEvent(world.events, "jobCompleted", "J1")).toBe(true);
      expect(world.completedCount).toBe(1);
      expect(mod(world, MB).slots).not.toContain("J1");
    });

    it("빈 슬롯이 생기면 대기 작업이 이어서 처리된다 (완료된 작업은 슬롯을 비운다)", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 0.5 }],
          initial: [[RA], [RA]],
          config: { dt: 0.1 },
        }),
      );
      step(world, [assign("J1", MA), assign("J2", MA)]);
      stepUntil(world, (w) => w.completedCount === 2, 30);
      expect(job(world, "J1").state).toBe("COMPLETED");
      expect(job(world, "J2").state).toBe("COMPLETED");
      expect(mod(world, MA).slots).toEqual([]);
      expect(mod(world, MA).queue).toEqual([]);
    });
  });

  describe("이동 (moveTime = 0)", () => {
    it("assign한 같은 step에 도착해서 빈 슬롯이면 바로 처리를 시작한다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA]],
          config: { moveTime: 0 },
        }),
      );
      expect(job(world, "J1").state).toBe("POOL");
      expect(job(world, "J1").location).toEqual({ kind: "pool" });
      step(world, [assign("J1", MA)]);
      expect(job(world, "J1").state).toBe("PROCESSING");
      expect(job(world, "J1").location).toEqual({ kind: "module", moduleId: MA });
      expect(mod(world, MA).slots).toEqual(["J1"]);
      expect(hasEvent(world.events, "jobArrived", "J1")).toBe(true);
      expect(hasEvent(world.events, "processStarted", "J1")).toBe(true);
    });
  });

  describe("§11-3 대기열 FIFO", () => {
    it("용량이 꽉 찬 모듈에 배치하면 QUEUED가 되고 배치 순서대로 처리된다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 0.5, capacity: 1 }],
          initial: [[RA], [RA], [RA]],
          config: { dt: 0.1, occupyWhenDone: true },
        }),
      );
      // 배치 순서: J3, J1, J2
      step(world, [assign("J3", MA), assign("J1", MA), assign("J2", MA)]);
      expect(job(world, "J3").state).toBe("PROCESSING");
      expect(job(world, "J1").state).toBe("QUEUED");
      expect(job(world, "J2").state).toBe("QUEUED");
      expect(mod(world, MA).slots).toEqual(["J3"]);
      expect(mod(world, MA).queue).toEqual(["J1", "J2"]);
      expect(job(world, "J1").location).toEqual({ kind: "module", moduleId: MA });

      const startOrder: string[] = [];
      const completeOrder: string[] = [];
      for (let i = 0; i < 100 && world.completedCount < 3; i++) {
        step(world, []);
        for (const e of world.events) {
          if (e.type === "processStarted") startOrder.push(e.jobId);
          if (e.type === "jobCompleted") completeOrder.push(e.jobId);
        }
        // 용량을 넘겨 처리하지 않는다
        const processing = [...world.jobs.values()].filter((j) => j.state === "PROCESSING");
        expect(processing.length).toBeLessThanOrEqual(1);
      }
      expect(startOrder).toEqual(["J1", "J2"]);
      expect(completeOrder).toEqual(["J3", "J1", "J2"]);
      expect(job(world, "J3").completedAt!).toBeLessThan(job(world, "J1").completedAt!);
      expect(job(world, "J1").completedAt!).toBeLessThan(job(world, "J2").completedAt!);
    });

    it("대기 중인 작업은 처리 진행이 없다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 1 }],
          initial: [[RA], [RA]],
          config: { dt: 0.1 },
        }),
      );
      step(world, [assign("J1", MA), assign("J2", MA)]);
      runSteps(world, 5);
      expect(job(world, "J2").state).toBe("QUEUED");
      expect(job(world, "J2").progress).toBe(0);
      expect(job(world, "J2").acquired.size).toBe(0);
    });

    it("capacity 2이면 두 작업을 동시에 처리하고 세 번째는 대기한다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 2 }],
          initial: [[RA], [RA], [RA]],
          config: { dt: 0.1 },
        }),
      );
      step(world, [assign("J1", MA), assign("J2", MA), assign("J3", MA)]);
      expect(job(world, "J1").state).toBe("PROCESSING");
      expect(job(world, "J2").state).toBe("PROCESSING");
      expect(job(world, "J3").state).toBe("QUEUED");
      expect(mod(world, MA).queue).toEqual(["J3"]);
      stepUntil(world, (w) => w.completedCount === 2, 15);
      // 두 작업은 같은 step에 함께 끝난다
      expect(hasEvent(world.events, "jobCompleted", "J1")).toBe(true);
      expect(hasEvent(world.events, "jobCompleted", "J2")).toBe(true);
      stepUntil(world, (w) => w.completedCount === 3, 15);
    });

    it("capacity를 생략하면 1이다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA], [RA]],
        }),
      );
      expect(mod(world, MA).capacity).toBe(1);
      step(world, [assign("J1", MA), assign("J2", MA)]);
      expect(job(world, "J2").state).toBe("QUEUED");
    });

    it("queueLimit을 넘는 배치도 수행하고 warning만 남긴다 (배치 판단은 감독관 책임)", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 1 }],
          initial: [[RA], [RA], [RA]],
          config: { queueLimit: 1 },
        }),
      );
      step(world, [assign("J1", MA), assign("J2", MA)]);
      // 상한 안의 배치에는 경고가 없다
      expect(hasEvent(world.events, "warning")).toBe(false);
      expect(canAssign(world, "J3", MA).ok).toBe(true);
      step(world, [assign("J3", MA)]);
      expect(job(world, "J3").state).toBe("QUEUED");
      expect(mod(world, MA).queue).toEqual(["J2", "J3"]);
      const warnings = world.events.filter((e) => e.type === "warning");
      expect(warnings).toHaveLength(1);
      // 상한을 넘은 작업도 FIFO 순서대로 처리된다
      stepUntil(world, (w) => w.completedCount === 3, 40);
      expect(job(world, "J2").completedAt!).toBeLessThan(job(world, "J3").completedAt!);
    });

    it("queueLimit은 이동 중인 작업도 자리를 차지한 것으로 세어 경고한다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1, capacity: 1 }],
          initial: [[RA], [RA], [RA]],
          config: { queueLimit: 1, moveTime: 1 },
        }),
      );
      step(world, [assign("J1", MA), assign("J2", MA)]);
      expect(hasEvent(world.events, "warning")).toBe(false);
      step(world, [assign("J3", MA)]);
      expect(hasEvent(world.events, "warning")).toBe(true);
      expect(job(world, "J3").state).toBe("MOVING");
    });
  });

  describe("§11-4 occupyWhenDone = true", () => {
    it("처리 끝난 작업을 옮기기 전까지 대기 작업이 시작되지 않고, 옮기면 시작된다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 0.5, capacity: 1 }],
          // J1은 결과 하나로 완료되지 않으므로 모듈에 남는다
          initial: [[RA, RB], [RA]],
          config: { dt: 0.1, occupyWhenDone: true },
        }),
      );
      step(world, [assign("J1", MA), assign("J2", MA)]);
      stepUntil(world, (w) => job(w, "J1").state === "DONE_AT_MODULE", 10);

      // 처리 시간의 몇 배가 지나도 J2는 대기한다
      const events = runSteps(world, 50);
      expect(events.some((evs) => hasEvent(evs, "processStarted", "J2"))).toBe(false);
      expect(job(world, "J1").state).toBe("DONE_AT_MODULE");
      expect(mod(world, MA).slots).toEqual(["J1"]);
      expect(job(world, "J2").state).toBe("QUEUED");
      expect(job(world, "J2").acquired.size).toBe(0);
      expect(world.completedCount).toBe(0);

      // 옮기면 J1은 결과를 가진 채 대기 구역으로, J2는 처리를 시작한다
      step(world, [unassign("J1")]);
      expect(job(world, "J1").state).toBe("POOL");
      expect(job(world, "J1").location).toEqual({ kind: "pool" });
      expect(job(world, "J1").acquired.has(RA)).toBe(true);
      expect(mod(world, MA).slots).toEqual(["J2"]);
      expect(job(world, "J2").state).toBe("PROCESSING");
      expect(hasEvent(world.events, "processStarted", "J2")).toBe(true);

      stepUntil(world, (w) => job(w, "J2").state === "COMPLETED", 10);
    });
  });

  describe("§11-5 cancelOnMove = true", () => {
    it("처리 중 unassign하면 결과를 얻지 못하고 POOL로 돌아간다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA]],
          config: { dt: 0.1, cancelOnMove: true },
        }),
      );
      step(world, [assign("J1", MA)]);
      runSteps(world, 7); // 처리 시간의 대부분 경과
      expect(job(world, "J1").state).toBe("PROCESSING");

      step(world, [unassign("J1")]);
      const j = job(world, "J1");
      expect(j.state).toBe("POOL");
      expect(j.location).toEqual({ kind: "pool" });
      expect(j.acquired.has(RA)).toBe(false);
      expect(hasEvent(world.events, "processCancelled", "J1")).toBe(true);
      expect(hasEvent(world.events, "processFinished", "J1")).toBe(false);
      expect(mod(world, MA).slots).not.toContain("J1");

      // 시간이 더 지나도 결과를 얻지 않는다
      const later = runSteps(world, 30);
      expect(later.some((evs) => hasEvent(evs, "processFinished", "J1"))).toBe(false);
      expect(job(world, "J1").acquired.has(RA)).toBe(false);
      expect(world.completedCount).toBe(0);
    });

    it("취소된 작업을 다시 배치하면 처음부터 처리 시간 전체가 걸린다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA, RB]],
          config: { dt: 0.1, cancelOnMove: true },
        }),
      );
      step(world, [assign("J1", MA)]);
      runSteps(world, 7);
      step(world, [unassign("J1")]);
      step(world, [assign("J1", MA)]);
      const n = stepUntil(world, (w) => job(w, "J1").acquired.has(RA), 30);
      // 다시 배치한 step을 1번으로 세면 약 10 step
      expect(Math.abs(n + 1 - 10)).toBeLessThanOrEqual(1);
    });

    it("처리 중 다른 모듈로 assign해도 원래 모듈의 결과는 얻지 못한다", () => {
      const world = make(
        makeScenario({
          modules: [
            { id: MA, resultType: RA, processTime: 1 },
            { id: MB, resultType: RB, processTime: 1 },
          ],
          initial: [[RA, RB]],
          config: { dt: 0.1, cancelOnMove: true },
        }),
      );
      step(world, [assign("J1", MA)]);
      runSteps(world, 5);
      step(world, [assign("J1", MB)]);
      expect(hasEvent(world.events, "processCancelled", "J1")).toBe(true);
      expect(job(world, "J1").acquired.has(RA)).toBe(false);
      expect(mod(world, MA).slots).not.toContain("J1");
      expect(job(world, "J1").location).toEqual({ kind: "module", moduleId: MB });
    });
  });

  describe("§11-6 잘못된 명령", () => {
    const scenario = (): Scenario =>
      makeScenario({
        modules: [{ id: MA, resultType: RA, processTime: 1 }],
        initial: [[RA], [RA]],
        config: { dt: 0.1 },
      });

    const invalidCommands: [string, Command][] = [
      ["없는 작업 assign", assign("NOPE", MA)],
      ["없는 모듈 assign", assign("J1", "NOPE")],
      ["없는 작업 unassign", unassign("NOPE")],
    ];

    it.each(invalidCommands)("%s: apply는 상태를 바꾸지 않고 warning을 남긴다", (_label, cmd) => {
      const world = make(scenario());
      step(world, [assign("J2", MA)]); // 처리 중인 작업이 있는 상태에서 검사
      runSteps(world, 3);
      const before = stateWithoutEvents(world);
      apply(world, cmd);
      expect(stateWithoutEvents(world)).toEqual(before);
      expect(hasEvent(world.events, "warning")).toBe(true);
    });

    it.each(invalidCommands)("%s: step 결과가 명령 없이 돌린 것과 같고 warning만 추가된다", (_label, cmd) => {
      const a = make(scenario());
      const b = make(scenario());
      runSteps(a, 3, { 0: [assign("J2", MA)] });
      runSteps(b, 3, { 0: [assign("J2", MA)] });

      step(a, [cmd]);
      step(b, []);
      expect(stateWithoutEvents(a)).toEqual(stateWithoutEvents(b));
      expect(hasEvent(a.events, "warning")).toBe(true);
      expect(hasEvent(b.events, "warning")).toBe(false);
      expect(a.events.filter((e) => e.type !== "warning")).toEqual(b.events);
    });

    it("잘못된 명령이 같은 step의 올바른 명령을 막지 않는다", () => {
      const world = make(scenario());
      step(world, [assign("NOPE", MA), assign("J1", MA)]);
      expect(job(world, "J1").state).toBe("PROCESSING");
      expect(hasEvent(world.events, "warning")).toBe(true);
    });

    it("완료된 작업에 대한 명령은 상태를 바꾸지 않고 warning을 남긴다", () => {
      const world = make(scenario());
      step(world, [assign("J1", MA)]);
      stepUntil(world, (w) => job(w, "J1").state === "COMPLETED", 20);
      for (const cmd of [assign("J1", MA), unassign("J1")]) {
        const before = stateWithoutEvents(world);
        apply(world, cmd);
        expect(stateWithoutEvents(world)).toEqual(before);
        expect(hasEvent(world.events, "warning")).toBe(true);
      }
      step(world, [assign("J1", MA)]);
      expect(job(world, "J1").state).toBe("COMPLETED");
      expect(world.completedCount).toBe(1);
      expect(hasEvent(world.events, "warning")).toBe(true);
    });
  });

  describe("이동 중 작업 unassign", () => {
    it("이동 중인 작업을 unassign하면 이동 시간 없이 즉시 POOL로 돌아가고 도착하지 않는다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA]],
          config: { dt: 0.1, moveTime: 1 },
        }),
      );
      step(world, [assign("J1", MA)]);
      runSteps(world, 2);
      expect(job(world, "J1").state).toBe("MOVING");
      expect(world.moves.has("J1")).toBe(true);

      step(world, [unassign("J1")]);
      expect(hasEvent(world.events, "warning")).toBe(false);
      const j = job(world, "J1");
      expect(j.state).toBe("POOL");
      expect(j.location).toEqual({ kind: "pool" });
      expect(j.progress).toBe(0);
      expect(world.moves.has("J1")).toBe(false);
      expect(hasEvent(world.events, "processCancelled", "J1")).toBe(false);

      // 이후 원래 도착 시각이 지나도 모듈에 도착하지 않는다
      const later = flatEvents(runSteps(world, 20));
      expect(hasEvent(later, "jobArrived", "J1")).toBe(false);
      expect(job(world, "J1").state).toBe("POOL");
      expect(mod(world, MA).slots).toEqual([]);
      expect(mod(world, MA).queue).toEqual([]);
    });
  });

  describe("같은 모듈 재배치", () => {
    const scenario = (config: Partial<Scenario["config"]> = {}): Scenario =>
      makeScenario({
        modules: [{ id: MA, resultType: RA, processTime: 1 }],
        // 결과를 얻어도 완료되지 않아 DONE_AT_MODULE로 머문다
        initial: [[RA, RB], [RA, RB]],
        config: { dt: 0.1, ...config },
      });

    it("DONE_AT_MODULE 작업을 같은 모듈에 다시 배치하면 슬롯 그대로 처음부터 다시 처리한다", () => {
      const world = make(scenario());
      step(world, [assign("J1", MA)]);
      stepUntil(world, (w) => job(w, "J1").state === "DONE_AT_MODULE", 20);
      expect(canAssign(world, "J1", MA).ok).toBe(true);

      const restartAt = world.simTime;
      step(world, [assign("J1", MA)]);
      const j = job(world, "J1");
      expect(j.state).toBe("PROCESSING");
      expect(j.location).toEqual({ kind: "module", moduleId: MA });
      expect(mod(world, MA).slots).toEqual(["J1"]);
      // progress 0부터 다시 세므로 이번 step 진행분만 있다
      expect(j.progress).toBeCloseTo(0.1, TIME_DIGITS);
      expect(findEvent(world.events, "processStarted", "J1").t).toBeCloseTo(restartAt, TIME_DIGITS);
      // 이미 가진 결과이므로 중복 경고
      expect(hasEvent(world.events, "warning")).toBe(true);
      expect(world.moves.has("J1")).toBe(false);

      // 처리 시간 1 뒤에 다시 처리가 끝난다
      const all = flatEvents(runSteps(world, 15));
      expect(findEvent(all, "processFinished", "J1").t).toBeCloseTo(restartAt + 1, TIME_DIGITS);
      expect(job(world, "J1").state).toBe("DONE_AT_MODULE");
      expect([...job(world, "J1").acquired]).toEqual([RA]);
    });

    it("moveTime이 있어도 같은 모듈 재처리는 이동 없이 바로 시작한다", () => {
      const world = make(scenario({ moveTime: 1 }));
      step(world, [assign("J1", MA)]);
      stepUntil(world, (w) => job(w, "J1").state === "DONE_AT_MODULE", 40);
      step(world, [assign("J1", MA)]);
      expect(job(world, "J1").state).toBe("PROCESSING");
      expect(world.moves.has("J1")).toBe(false);
    });

    it.each([
      ["MOVING", { moveTime: 1 }, 1],
      ["QUEUED", {}, 1],
      ["PROCESSING", {}, 3],
      ["PROCESSING (cancelOnMove=false)", { cancelOnMove: false }, 3],
    ] as const)(
      "%s 작업을 같은 모듈에 다시 배치하면 상태가 바뀌지 않고 warning만 남긴다",
      (label, config, stepsBefore) => {
        const world = make(scenario(config));
        // QUEUED 상황: J2가 J1 뒤에 줄 선다
        const target = label === "QUEUED" ? "J2" : "J1";
        runSteps(world, stepsBefore, { 0: [assign("J1", MA), assign("J2", MA)] });
        const expectedState = label.startsWith("PROCESSING") ? "PROCESSING" : label;
        expect(job(world, target).state).toBe(expectedState);
        expect(canAssign(world, target, MA).ok).toBe(true);

        const before = stateWithoutEvents(world);
        apply(world, assign(target, MA));
        expect(stateWithoutEvents(world)).toEqual(before);
        expect(world.events.filter((e) => e.type === "warning")).toHaveLength(1);

        // step으로 넘겨도 명령 없이 돌린 것과 같은 결과다
        const other = make(scenario(config));
        runSteps(other, stepsBefore, { 0: [assign("J1", MA), assign("J2", MA)] });
        step(world, [assign(target, MA)]);
        step(other, []);
        expect(stateWithoutEvents(world)).toEqual(stateWithoutEvents(other));
        expect(world.events.filter((e) => e.type !== "warning")).toEqual(other.events);
      },
    );
  });

  describe("§11-7 결정성", () => {
    const scenarioWithArrival = (seed: number): Scenario =>
      makeScenario({
        seed,
        modules: [
          { id: MA, resultType: RA, processTime: 1.5 },
          { id: MB, resultType: RB, processTime: 2, capacity: 2 },
        ],
        initial: [[RA, RB], [RB]],
        arrival: { kind: "poisson", rate: 0.8, requiredPool: [RA, RB], minReq: 1, maxReq: 2 },
        config: { dt: 0.1 },
      });

    // 고정된 명령 로그 (생성 순서 id J3 이후는 도착한 작업)
    const commandLog: Record<number, Command[]> = {
      0: [assign("J1", MA), assign("J2", MB)],
      5: [assign("J1", MB)], // 처리 중 이동 → 취소
      30: [assign("J3", MA), assign("J4", MA)],
      40: [unassign("J1"), assign("NOPE", MA)],
      45: [assign("J1", MA), assign("J5", MB)],
      80: [unassign("J3"), assign("J3", MB)],
      120: [assign("J6", MA), assign("J7", MB), assign("J8", MB)],
    };
    const STEPS = 400;

    it("같은 시나리오, 시드, 명령 로그면 최종 상태가 같다", () => {
      const a = make(scenarioWithArrival(42));
      const b = make(scenarioWithArrival(42));
      const eventsA = runSteps(a, STEPS, commandLog);
      const eventsB = runSteps(b, STEPS, commandLog);
      expect(a).toEqual(b);
      expect(eventsA).toEqual(eventsB);
      // 도착이 실제로 일어나서 의미 있는 비교인지 확인
      expect(a.jobs.size).toBeGreaterThan(5);
    });

    it("시드가 다르면 도착 결과가 달라진다", () => {
      const a = make(scenarioWithArrival(1));
      const b = make(scenarioWithArrival(2));
      runSteps(a, STEPS);
      runSteps(b, STEPS);
      const summary = (w: typeof a) =>
        [...w.jobs.values()].map((j) => ({ id: j.id, createdAt: j.createdAt, required: [...j.required].sort() }));
      expect(summary(a)).not.toEqual(summary(b));
    });
  });

  describe("작업 생성", () => {
    it("초기 작업은 J1, J2, … 순서로 POOL 상태에서 시작한다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA], [RA, RB]],
        }),
      );
      expect([...world.jobs.keys()]).toEqual(["J1", "J2"]);
      expect(job(world, "J2").required).toEqual(new Set([RA, RB]));
      expect(job(world, "J2").acquired.size).toBe(0);
      for (const j of world.jobs.values()) {
        expect(j.state).toBe("POOL");
        expect(j.location).toEqual({ kind: "pool" });
      }
      expect(world.simTime).toBe(0);
      expect(world.completedCount).toBe(0);
    });

    it("시나리오 config가 world.config에 반영된다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA]],
          config: { dt: 0.25, queueLimit: 3 },
        }),
      );
      expect(world.config.dt).toBe(0.25);
      expect(world.config.queueLimit).toBe(3);
      step(world, []);
      expect(world.simTime).toBeCloseTo(0.25, 9);
    });
  });

  describe("canAssign", () => {
    const setup = () =>
      make(
        makeScenario({
          modules: [
            { id: MA, resultType: RA, processTime: 1 },
            { id: MB, resultType: RB, processTime: 1 },
          ],
          initial: [[RA], [RA]],
          config: { queueLimit: null },
        }),
      );

    it("대기 구역 작업을 존재하는 모듈에 배치할 수 있다", () => {
      expect(canAssign(setup(), "J1", MA).ok).toBe(true);
    });

    it("필요 없는 결과를 주는 모듈에도 배치할 수 있다 (경고 대상일 뿐)", () => {
      expect(canAssign(setup(), "J1", MB).ok).toBe(true);
    });

    it("꽉 찬 모듈이라도 대기열 제한이 없으면 배치할 수 있다", () => {
      const world = setup();
      step(world, [assign("J1", MA)]);
      expect(canAssign(world, "J2", MA).ok).toBe(true);
    });

    it("없는 작업, 없는 모듈은 거부하고 이유를 준다", () => {
      const world = setup();
      const noJob = canAssign(world, "NOPE", MA);
      const noModule = canAssign(world, "J1", "NOPE");
      expect(noJob.ok).toBe(false);
      expect(noJob.reason).toBeTruthy();
      expect(noModule.ok).toBe(false);
      expect(noModule.reason).toBeTruthy();
    });

    it("완료된 작업은 거부한다", () => {
      const world = setup();
      step(world, [assign("J1", MA)]);
      stepUntil(world, (w) => job(w, "J1").state === "COMPLETED", 20);
      expect(canAssign(world, "J1", MA).ok).toBe(false);
    });

    it("canAssign은 상태를 바꾸지 않는다", () => {
      const world = setup();
      const before = stateWithoutEvents(world);
      canAssign(world, "J1", MA);
      canAssign(world, "NOPE", MA);
      expect(stateWithoutEvents(world)).toEqual(before);
    });
  });

  describe("종료 조건 (isEnded)", () => {
    it("time: simTime이 value에 도달하면 끝난다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 1 }],
          initial: [[RA]],
          config: { dt: 0.1, endCondition: { kind: "time", value: 1 } },
        }),
      );
      expect(isEnded(world)).toBe(false);
      runSteps(world, 9);
      expect(isEnded(world)).toBe(false);
      runSteps(world, 2);
      expect(isEnded(world)).toBe(true);
    });

    it("completed: 완료 수가 value에 도달하면 끝난다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 0.5 }],
          initial: [[RA], [RA]],
          config: { dt: 0.1, endCondition: { kind: "completed", value: 1 } },
        }),
      );
      step(world, [assign("J1", MA)]);
      expect(isEnded(world)).toBe(false);
      stepUntil(world, (w) => w.completedCount === 1, 10);
      expect(isEnded(world)).toBe(true);
    });

    it("allDone: 모든 작업이 완료되면 끝난다", () => {
      const world = make(
        makeScenario({
          modules: [{ id: MA, resultType: RA, processTime: 0.5 }],
          initial: [[RA], [RA]],
          config: { dt: 0.1, endCondition: { kind: "allDone" } },
        }),
      );
      step(world, [assign("J1", MA), assign("J2", MA)]);
      stepUntil(world, (w) => w.completedCount === 1, 10);
      expect(isEnded(world)).toBe(false);
      stepUntil(world, (w) => w.completedCount === 2, 10);
      expect(isEnded(world)).toBe(true);
    });
  });
});

describe("createWorld 기본 규칙", () => {
  it("rules 옵션 없이 만들어도 defaultRules와 같은 결과를 낸다", () => {
    const scenario = makeScenario({
      modules: [{ id: MA, resultType: RA, processTime: 1 }],
      initial: [[RA], [RA]],
    });
    const a = createWorld(scenario);
    const b = createWorld(scenario, { rules: defaultRules });
    const log = { 0: [assign("J1", MA), assign("J2", MA)] };
    runSteps(a, 30, log);
    runSteps(b, 30, log);
    expect(stateWithoutEvents(a)).toEqual(stateWithoutEvents(b));
  });
});

describe("rng", () => {
  const draw = (seed: number, n: number): number[] => {
    const rng = createRng(seed);
    return Array.from({ length: n }, () => rng.next());
  };

  it("같은 시드면 같은 수열을 낸다", () => {
    expect(draw(42, 200)).toEqual(draw(42, 200));
  });

  it("다른 시드면 다른 수열을 낸다", () => {
    expect(draw(1, 20)).not.toEqual(draw(2, 20));
  });

  it("값은 [0,1) 범위이고 한쪽에 치우치지 않는다", () => {
    const values = draw(7, 5000);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(new Set(values).size).toBeGreaterThan(4900);
  });
});
