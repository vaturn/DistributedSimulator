// 수동 감독관 테스트
import { describe, expect, it } from "vitest";
import { createWorld, step } from "../src/engine/world";
import { createManualSupervisor } from "../src/supervisor/manual";
import { assign, makeScenario, unassign } from "./helpers";

const R = "res-x";
const M = "mod-x";

function makeWorld() {
  return createWorld(
    makeScenario({
      modules: [{ id: M, resultType: R, processTime: 2 }],
      initial: [[R], [R]],
    }),
  );
}

describe("ManualSupervisor", () => {
  it("이름은 manual", () => {
    expect(createManualSupervisor().name).toBe("manual");
  });

  it("빈 상태에서 decide는 빈 배열", () => {
    const sup = createManualSupervisor();
    expect(sup.decide(makeWorld())).toEqual([]);
    expect(sup.pendingCount()).toBe(0);
  });

  it("submit한 순서대로 반환하고, decide 뒤에는 비워진다", () => {
    const sup = createManualSupervisor();
    const w = makeWorld();
    const cmds = [assign("J1", M), unassign("J1"), assign("J2", M)];
    for (const c of cmds) sup.submit(c);
    expect(sup.pendingCount()).toBe(3);
    expect(sup.decide(w)).toEqual(cmds);
    expect(sup.pendingCount()).toBe(0);
    expect(sup.decide(w)).toEqual([]);
  });

  it("검증하지 않고 잘못된 명령도 그대로 넘긴다", () => {
    const sup = createManualSupervisor();
    sup.submit(assign("nope", "nope"));
    expect(sup.decide(makeWorld())).toEqual([assign("nope", "nope")]);
  });

  it("루프에서 submit한 assign이 다음 step에 적용되어 처리를 시작한다", () => {
    const sup = createManualSupervisor();
    const w = makeWorld();
    step(w, sup.decide(w));
    step(w, sup.decide(w));
    expect(w.jobs.get("J1")?.state).toBe("POOL");

    sup.submit(assign("J1", M)); // 일시정지 중 입력이라고 본다
    expect(w.jobs.get("J1")?.state).toBe("POOL");
    step(w, sup.decide(w));
    expect(w.jobs.get("J1")?.state).toBe("PROCESSING");
    expect(w.events.some((e) => e.type === "processStarted" && e.jobId === "J1")).toBe(true);
    expect(sup.pendingCount()).toBe(0);
  });
});
