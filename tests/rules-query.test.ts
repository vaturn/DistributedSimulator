// rules.ts 조회 함수 테스트 (remainingResults, usefulResults, remainingProcessTime, estimatedWaitTime,
// processProgressRatio, moveProgressRatio)
import { describe, expect, it } from "vitest";
import {
  assignHint,
  estimatedWaitTime,
  mergeRules,
  moveProgressRatio,
  processProgressRatio,
  remainingProcessTime,
  remainingResults,
  usefulResults,
} from "../src/engine/rules";
import { createWorld, step } from "../src/engine/world";
import { assign, deepCopy, makeScenario, runSteps } from "./helpers";

const RA = "red";
const RB = "blue";
const RC = "green";
const MA = "mod-red";
const MB = "mod-blue";
const MC = "mod-green";

function world3(initial: string[][], config = {}) {
  return createWorld(
    makeScenario({
      modules: [
        { id: MA, resultType: RA, processTime: 2 },
        { id: MB, resultType: RB, processTime: 5 },
        { id: MC, resultType: RC, processTime: 3, capacity: 2 },
      ],
      initial,
      config,
    }),
  );
}

describe("remainingResults", () => {
  it("required에서 acquired를 뺀 결과를 required 순서로 돌려준다", () => {
    const w = world3([[RA, RB, RC]]);
    expect(remainingResults(w, "J1")).toEqual([RA, RB, RC]);
    step(w, [assign("J1", MA)]);
    runSteps(w, 20);
    expect(remainingResults(w, "J1")).toEqual([RB, RC]);
  });

  it("없는 작업이면 빈 배열", () => {
    expect(remainingResults(world3([[RA]]), "nope")).toEqual([]);
  });
});

describe("usefulResults", () => {
  it("모듈이 주는 결과 중 아직 필요한 것만 돌려준다", () => {
    const w = world3([[RA, RB]]);
    expect(usefulResults(w, "J1", MA)).toEqual([RA]);
    expect(usefulResults(w, "J1", MC)).toEqual([]);
    step(w, [assign("J1", MA)]);
    runSteps(w, 20);
    expect(usefulResults(w, "J1", MA)).toEqual([]);
    expect(usefulResults(w, "J1", MB)).toEqual([RB]);
  });

  it("교체된 gainedResults 규칙을 따른다", () => {
    const w = createWorld(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 1 }], initial: [[RA, RB]] }),
      { rules: mergeRules({ gainedResults: () => [RA, RB] }) },
    );
    expect(usefulResults(w, "J1", MA)).toEqual([RA, RB]);
  });

  it("없는 작업·모듈이면 빈 배열", () => {
    const w = world3([[RA]]);
    expect(usefulResults(w, "nope", MA)).toEqual([]);
    expect(usefulResults(w, "J1", "nope")).toEqual([]);
  });
});

describe("remainingProcessTime", () => {
  it("처리 중이면 progress를 뺀 시간, 아니면 전체 처리 시간", () => {
    const w = world3([[RA, RB]]);
    expect(remainingProcessTime(w, "J1", MA)).toBeCloseTo(2, 9);
    step(w, [assign("J1", MA)]);
    runSteps(w, 4); // 총 5 step = 0.5초
    expect(remainingProcessTime(w, "J1", MA)).toBeCloseTo(1.5, 9);
  });

  it("교체된 processTime 규칙을 쓴다", () => {
    const w = createWorld(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 2 }], initial: [[RA]] }),
      { rules: mergeRules({ processTime: () => 7 }) },
    );
    expect(remainingProcessTime(w, "J1", MA)).toBe(7);
  });
});

describe("estimatedWaitTime", () => {
  it("빈 모듈은 0", () => {
    expect(estimatedWaitTime(world3([[RA]]), MA)).toBe(0);
  });

  it("처리 중 작업의 남은 시간 + 대기열 작업 처리 시간", () => {
    const w = world3([[RB], [RB], [RB]]);
    step(w, [assign("J1", MB), assign("J2", MB), assign("J3", MB)]);
    // J1 처리 중(남은 4.9), J2, J3 대기 → 4.9 + 5 + 5
    expect(estimatedWaitTime(w, MB)).toBeCloseTo(14.9, 9);
    // 자기 자신(J3)은 뺀다
    expect(estimatedWaitTime(w, MB, { exceptJobId: "J3" })).toBeCloseTo(9.9, 9);
  });

  it("용량 N 모듈은 슬롯별로 독립적으로 계산한다", () => {
    const w = world3([[RC], [RC], [RC]]);
    step(w, [assign("J1", MC)]);
    // 슬롯 하나가 비어 있으므로 0
    expect(estimatedWaitTime(w, MC)).toBe(0);
    step(w, [assign("J2", MC)]);
    // J1 남은 2.8, J2 남은 2.9 → 가장 빨리 비는 슬롯 2.8
    expect(estimatedWaitTime(w, MC)).toBeCloseTo(2.8, 9);
    step(w, [assign("J3", MC)]);
    // J3이 대기열에서 2.7 뒤 J1 슬롯에 들어가 2.7+3=5.7, J2 슬롯은 2.8 → 2.8
    expect(estimatedWaitTime(w, MC)).toBeCloseTo(2.8, 9);
  });

  it("extraJobIds는 대기열 끝에 줄 선 것으로 계산한다", () => {
    const w = world3([[RA], [RA]]);
    expect(estimatedWaitTime(w, MA, { extraJobIds: ["J1"] })).toBe(2);
    expect(estimatedWaitTime(w, MA, { extraJobIds: ["J1", "J2"] })).toBe(4);
  });

  it("DONE_AT_MODULE 슬롯은 기본으로 비울 수 있는 슬롯, doneSlotsFree=false면 무기한 점유", () => {
    const w = world3([[RA, RB]]);
    step(w, [assign("J1", MA)]);
    runSteps(w, 20);
    expect(w.jobs.get("J1")?.state).toBe("DONE_AT_MODULE");
    expect(estimatedWaitTime(w, MA)).toBe(0);
    expect(estimatedWaitTime(w, MA, { doneSlotsFree: false })).toBe(Infinity);
  });

  it("이동 중인 작업은 도착 시각 이후에 슬롯을 쓴다", () => {
    const w = world3([[RA], [RA]], { moveTime: 1 });
    step(w, [assign("J1", MA)]);
    // J1 남은 이동 0.9 → 0.9 + 2
    expect(estimatedWaitTime(w, MA)).toBeCloseTo(2.9, 9);
    // 추가 작업은 이동 시간(1) 뒤에 도착하지만 앞 작업이 끝날 때까지 기다린다
    expect(estimatedWaitTime(w, MA, { extraJobIds: ["J2"] })).toBeCloseTo(4.9, 9);
  });

  it("없는 모듈이면 Infinity, 월드를 바꾸지 않는다", () => {
    const w = world3([[RA], [RA]]);
    step(w, [assign("J1", MA), assign("J2", MA)]);
    const before = deepCopy(w);
    expect(estimatedWaitTime(w, "nope")).toBe(Infinity);
    estimatedWaitTime(w, MA, { extraJobIds: ["J2"] });
    usefulResults(w, "J1", MA);
    remainingResults(w, "J1");
    expect(w).toEqual(before);
  });
});

describe("processProgressRatio", () => {
  it("처리 중이면 progress / 처리 시간, 처리가 끝나면 1", () => {
    const w = world3([[RA, RB]]);
    expect(processProgressRatio(w, "J1")).toBe(0); // 대기 구역
    step(w, [assign("J1", MA)]);
    runSteps(w, 4); // 총 5 step = 0.5초, 처리 시간 2
    expect(w.jobs.get("J1")?.state).toBe("PROCESSING");
    expect(processProgressRatio(w, "J1")).toBeCloseTo(0.25, 9);
    runSteps(w, 20);
    expect(w.jobs.get("J1")?.state).toBe("DONE_AT_MODULE");
    expect(processProgressRatio(w, "J1")).toBe(1);
  });

  it("대기열·이동 중·없는 작업이면 0", () => {
    const w = world3([[RA], [RA], [RA]], { moveTime: 1 });
    step(w, [assign("J1", MA)]);
    expect(w.jobs.get("J1")?.state).toBe("MOVING");
    expect(processProgressRatio(w, "J1")).toBe(0);
    expect(processProgressRatio(w, "nope")).toBe(0);
    const q = world3([[RA], [RA]]);
    step(q, [assign("J1", MA), assign("J2", MA)]);
    expect(q.jobs.get("J2")?.state).toBe("QUEUED");
    expect(processProgressRatio(q, "J2")).toBe(0);
  });

  it("교체된 processTime 규칙을 쓴다", () => {
    const w = createWorld(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 2 }], initial: [[RA]] }),
      { rules: mergeRules({ processTime: () => 4 }) },
    );
    step(w, [assign("J1", MA)]); // progress 0.1
    expect(processProgressRatio(w, "J1")).toBeCloseTo(0.025, 9);
  });

  it("처리 시간이 0 이하면 1", () => {
    const w = createWorld(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 2 }], initial: [[RA, RB]] }),
      { rules: mergeRules({ processTime: () => 0, isProcessFinished: () => false }) },
    );
    step(w, [assign("J1", MA)]);
    expect(w.jobs.get("J1")?.state).toBe("PROCESSING");
    expect(processProgressRatio(w, "J1")).toBe(1);
  });
});

describe("moveProgressRatio", () => {
  it("이동 중이면 1 - 남은 시간 / 전체 이동 시간", () => {
    const w = world3([[RA]], { moveTime: 1 });
    step(w, [assign("J1", MA)]); // 남은 0.9
    expect(moveProgressRatio(w, "J1")).toBeCloseTo(0.1, 9);
    runSteps(w, 4); // 남은 0.5
    expect(moveProgressRatio(w, "J1")).toBeCloseTo(0.5, 9);
  });

  it("이동 중이 아니거나 없는 작업이면 0", () => {
    const w = world3([[RA]]);
    expect(moveProgressRatio(w, "J1")).toBe(0);
    step(w, [assign("J1", MA)]); // 이동 시간 0 → 바로 도착해 처리 중
    expect(moveProgressRatio(w, "J1")).toBe(0);
    expect(moveProgressRatio(w, "nope")).toBe(0);
  });

  it("교체된 moveTime 규칙이 이동 시작 때 정한 전체 시간을 쓴다", () => {
    const w = createWorld(
      makeScenario({ modules: [{ id: MA, resultType: RA, processTime: 2 }], initial: [[RA]] }),
      { rules: mergeRules({ moveTime: () => 2 }) },
    );
    step(w, [assign("J1", MA)]); // 남은 1.9
    expect(w.moves.get("J1")?.total).toBe(2);
    expect(moveProgressRatio(w, "J1")).toBeCloseTo(0.05, 9);
  });

  it("월드를 바꾸지 않는다", () => {
    const w = world3([[RA], [RA]], { moveTime: 1 });
    step(w, [assign("J1", MA)]);
    const before = deepCopy(w);
    moveProgressRatio(w, "J1");
    processProgressRatio(w, "J1");
    expect(w).toEqual(before);
  });
});

describe("assignHint", () => {
  /** 이번 step에 생긴 warning 메시지 */
  function warningMessages(w: ReturnType<typeof world3>): string[] {
    return w.events.flatMap((e) => (e.type === "warning" ? [e.message] : []));
  }

  it("필요한 결과를 주는 모듈이면 ok, useful, 경고 없음", () => {
    const w = world3([[RA, RB]]);
    expect(assignHint(w, "J1", MA)).toEqual({ ok: true, useful: true, warnings: [] });
  });

  it("필요 없는 결과면 ok, !useful, 경고는 apply 때 남는 warning과 같다", () => {
    const w = world3([[RA]]);
    const hint = assignHint(w, "J1", MB);
    expect(hint.ok).toBe(true);
    expect(hint.useful).toBe(false);
    expect(hint.warnings).toHaveLength(1);
    step(w, [assign("J1", MB)]);
    expect(warningMessages(w)).toEqual(hint.warnings);
  });

  it("이미 가진 결과면 ok, !useful, 경고는 apply 때 남는 warning과 같다", () => {
    const w = world3([[RA, RB]]);
    runSteps(w, 25, { 0: [assign("J1", MA)] }); // MA 처리 2s 끝남 → DONE_AT_MODULE
    expect(w.jobs.get("J1")?.state).toBe("DONE_AT_MODULE");
    const hint = assignHint(w, "J1", MA);
    expect(hint.ok).toBe(true);
    expect(hint.useful).toBe(false);
    expect(hint.warnings).toHaveLength(1);
    step(w, [assign("J1", MA)]);
    expect(warningMessages(w)).toEqual(hint.warnings);
  });

  it("없는 모듈·없는 작업·완료된 작업이면 !ok, reason", () => {
    const w = world3([[RA]]);
    runSteps(w, 25, { 0: [assign("J1", MA)] });
    expect(w.jobs.get("J1")?.state).toBe("COMPLETED");
    for (const hint of [assignHint(w, "J1", "nope"), assignHint(w, "nope", MA), assignHint(w, "J1", MA)]) {
      expect(hint.ok).toBe(false);
      expect(hint.useful).toBe(false);
      expect(hint.warnings).toEqual([]);
      expect(hint.reason).toBeTruthy();
    }
  });

  it("cancelOnMove=false면 처리 중 작업을 다른 모듈로 옮기는 힌트는 !ok", () => {
    const w = world3([[RA, RB]], { cancelOnMove: false });
    step(w, [assign("J1", MA)]);
    expect(w.jobs.get("J1")?.state).toBe("PROCESSING");
    const hint = assignHint(w, "J1", MB);
    expect(hint.ok).toBe(false);
    expect(hint.reason).toBeTruthy();
  });

  it("처리 중인 같은 모듈에 다시 놓으면 ok, !useful, 무의미 경고", () => {
    const w = world3([[RA]]);
    step(w, [assign("J1", MA)]);
    const hint = assignHint(w, "J1", MA);
    expect(hint.ok).toBe(true);
    expect(hint.useful).toBe(false);
    expect(hint.warnings).toHaveLength(1);
    step(w, [assign("J1", MA)]);
    expect(warningMessages(w)).toEqual(hint.warnings);
  });

  it("월드를 바꾸지 않는다", () => {
    const w = world3([[RA], [RB]], { moveTime: 1, queueLimit: 0 });
    step(w, [assign("J1", MA)]);
    const before = deepCopy(w);
    assignHint(w, "J1", MA);
    assignHint(w, "J2", MA);
    assignHint(w, "J2", "nope");
    expect(w).toEqual(before);
  });
});
