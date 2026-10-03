// 드래그 입력의 순수 함수 테스트: 히트 판정, 드롭 대상, 드롭 → 명령, 강조 단계, 토스트
import { describe, expect, it } from "vitest";
import type { Command, WorldState } from "../src/engine/types";
import { createWorld, step } from "../src/engine/world";
import {
  attachDragInput,
  computeDragView,
  dropToCommand,
  exceedsDragThreshold,
  hintLevel,
  hitTestDropTarget,
  hitTestJob,
} from "../src/render/input";
import { computeLayout, poolJobCenter, queueJobCenter, slotCenter, type Layout, type Point } from "../src/render/layout";
import { allPlacements } from "../src/render/placement";
import { DRAG_THRESHOLD } from "../src/render/theme";
import { createToastQueue } from "../src/render/toasts";
import { assign, job, makeScenario } from "./helpers";

const VIEWPORT = { width: 960, height: 600 };
/** 처리가 테스트 중에 끝나지 않을 만큼 긴 처리 시간 */
const LONG = 100;

/**
 * 모듈 P(결과 X, 용량 1), Q(결과 Y, 용량 1).
 * 작업 4개(모두 X 필요): 0번은 P 슬롯, 1번은 P 대기열, 2·3번은 대기 구역.
 */
function setup(): { world: WorldState; layout: Layout; ids: string[] } {
  const world = createWorld(
    makeScenario({
      modules: [
        { id: "P", resultType: "X", processTime: LONG, capacity: 1 },
        { id: "Q", resultType: "Y", processTime: LONG, capacity: 1 },
      ],
      initial: [["X"], ["X"], ["X"], ["X"]],
    }),
  );
  const ids = [...world.jobs.keys()];
  step(world, [assign(ids[0], "P"), assign(ids[1], "P")]);
  const layout = computeLayout(VIEWPORT, [...world.modules.values()]);
  return { world, layout, ids };
}

function moduleLayout(layout: Layout, id: string) {
  const ml = layout.modules.find((m) => m.id === id);
  if (!ml) throw new Error(`모듈 ${id} 배치 없음`);
  return ml;
}

describe("hitTestJob", () => {
  it("상태 준비: 슬롯·대기열·대기 구역", () => {
    const { world, ids } = setup();
    expect(job(world, ids[0]).state).toBe("PROCESSING");
    expect(job(world, ids[1]).state).toBe("QUEUED");
    expect(job(world, ids[2]).state).toBe("POOL");
  });

  it("슬롯 작업을 잡는다", () => {
    const { world, layout, ids } = setup();
    const hit = hitTestJob(layout, world, slotCenter(moduleLayout(layout, "P"), 0));
    expect(hit?.jobId).toBe(ids[0]);
    expect(hit?.kind).toBe("slot");
  });

  it("대기열 작업을 잡는다", () => {
    const { world, layout, ids } = setup();
    const hit = hitTestJob(layout, world, queueJobCenter(moduleLayout(layout, "P"), 0));
    expect(hit?.jobId).toBe(ids[1]);
    expect(hit?.kind).toBe("queue");
  });

  it("대기 구역 작업을 순서대로 잡는다", () => {
    const { world, layout, ids } = setup();
    expect(hitTestJob(layout, world, poolJobCenter(layout, 0))?.jobId).toBe(ids[2]);
    expect(hitTestJob(layout, world, poolJobCenter(layout, 1))?.jobId).toBe(ids[3]);
  });

  it("렌더러가 그리는 모든 작업 원의 중심에서 그 작업을 잡는다", () => {
    const { world, layout } = setup();
    for (const p of allPlacements(world, layout)) {
      expect(hitTestJob(layout, world, p.center)?.jobId).toBe(p.jobId);
    }
  });

  it("빈 곳은 아무것도 잡지 않는다", () => {
    const { world, layout } = setup();
    expect(hitTestJob(layout, world, { x: 0, y: 0 })).toBeNull();
    // 빈 슬롯(모듈 Q)
    expect(hitTestJob(layout, world, slotCenter(moduleLayout(layout, "Q"), 0))).toBeNull();
    // 대기 구역의 비어 있는 다음 자리
    expect(hitTestJob(layout, world, poolJobCenter(layout, 2))).toBeNull();
  });

  it("COMPLETED 작업은 잡지 않는다", () => {
    const { world, layout, ids } = setup();
    // 그려지는 자리에 있어도 COMPLETED면 잡을 수 없다 (상태만 바꿔 확인하는 테스트 전용 조작).
    job(world, ids[2]).state = "COMPLETED";
    expect(hitTestJob(layout, world, poolJobCenter(layout, 0))?.jobId).not.toBe(ids[2]);
  });
});

describe("hitTestDropTarget", () => {
  it("모듈 상자와 대기열 영역은 그 모듈이다", () => {
    const { layout } = setup();
    const p = moduleLayout(layout, "P");
    const q = moduleLayout(layout, "Q");
    expect(hitTestDropTarget(layout, slotCenter(p, 0))).toEqual({ kind: "module", moduleId: "P" });
    expect(hitTestDropTarget(layout, queueJobCenter(q, 0))).toEqual({ kind: "module", moduleId: "Q" });
  });

  it("대기 구역 위는 pool", () => {
    const { layout } = setup();
    expect(hitTestDropTarget(layout, poolJobCenter(layout, 0))).toEqual({ kind: "pool" });
  });

  it("그 밖은 none", () => {
    const { layout } = setup();
    expect(hitTestDropTarget(layout, { x: 1, y: 1 })).toEqual({ kind: "none" });
    expect(hitTestDropTarget(layout, { x: VIEWPORT.width - 1, y: VIEWPORT.height - 1 })).toEqual({ kind: "none" });
  });
});

describe("dropToCommand", () => {
  it("모듈에 놓으면 assign", () => {
    const { world, ids } = setup();
    expect(dropToCommand(world, ids[2], { kind: "module", moduleId: "Q" })).toEqual(assign(ids[2], "Q"));
  });

  it("모듈 작업을 대기 구역에 놓으면 unassign", () => {
    const { world, ids } = setup();
    expect(dropToCommand(world, ids[0], { kind: "pool" })).toEqual({ type: "unassign", jobId: ids[0] });
    expect(dropToCommand(world, ids[1], { kind: "pool" })).toEqual({ type: "unassign", jobId: ids[1] });
  });

  it("대기 구역 작업을 대기 구역에 놓으면 무시", () => {
    const { world, ids } = setup();
    expect(dropToCommand(world, ids[2], { kind: "pool" })).toBeNull();
  });

  it("빈 곳에 놓으면 취소", () => {
    const { world, ids } = setup();
    expect(dropToCommand(world, ids[0], { kind: "none" })).toBeNull();
  });

  it("없거나 완료된 작업은 취소", () => {
    const { world, ids } = setup();
    expect(dropToCommand(world, "없는 작업", { kind: "module", moduleId: "P" })).toBeNull();
    job(world, ids[2]).state = "COMPLETED";
    expect(dropToCommand(world, ids[2], { kind: "module", moduleId: "P" })).toBeNull();
  });
});

describe("exceedsDragThreshold", () => {
  const o: Point = { x: 10, y: 10 };
  it("임계값 미만은 클릭, 이상은 드래그", () => {
    expect(exceedsDragThreshold(o, { x: 10 + DRAG_THRESHOLD - 1, y: 10 })).toBe(false);
    expect(exceedsDragThreshold(o, { x: 10 + DRAG_THRESHOLD, y: 10 })).toBe(true);
  });
});

describe("드래그 강조 (assignHint 기반)", () => {
  it("hintLevel: 불가 / 경고 / 유용", () => {
    expect(hintLevel({ ok: false, useful: false, warnings: [], reason: "x" })).toBe("blocked");
    expect(hintLevel({ ok: true, useful: false, warnings: ["w"] })).toBe("warn");
    expect(hintLevel({ ok: true, useful: true, warnings: ["w"] })).toBe("warn");
    expect(hintLevel({ ok: true, useful: false, warnings: [] })).toBe("warn");
    expect(hintLevel({ ok: true, useful: true, warnings: [] })).toBe("useful");
  });

  it("필요한 결과를 주는 모듈은 유용, 필요 없는 결과 모듈은 경고", () => {
    const { world, layout, ids } = setup();
    const view = computeDragView(world, layout, ids[2], slotCenter(moduleLayout(layout, "Q"), 0));
    expect(view?.moduleHints.get("P")?.level).toBe("useful");
    expect(view?.moduleHints.get("Q")?.level).toBe("warn");
    expect(view?.target).toEqual({ kind: "module", moduleId: "Q" });
    expect(view?.tooltip.some((l) => l.tone === "warn")).toBe(true);
  });

  it("대기 구역 작업은 대기 구역에 놓아도 명령을 보내지 않는다", () => {
    const { world, layout, ids } = setup();
    expect(computeDragView(world, layout, ids[2], poolJobCenter(layout, 0))?.pool.sends).toBe(false);
    expect(computeDragView(world, layout, ids[0], poolJobCenter(layout, 0))?.pool).toMatchObject({ sends: true, ok: true });
  });

  it("완료된 작업은 드래그 표시가 없다", () => {
    const { world, layout, ids } = setup();
    job(world, ids[2]).state = "COMPLETED";
    expect(computeDragView(world, layout, ids[2], { x: 0, y: 0 })).toBeNull();
  });
});

describe("hover 표시 (computeDragView mode hover)", () => {
  it("hover는 드롭 대상·드롭 툴팁이 없고, 남은 결과를 주는 모듈은 hint.useful", () => {
    const { world, layout, ids } = setup();
    const pointer = poolJobCenter(layout, 0);
    const view = computeDragView(world, layout, ids[2], { ...pointer, mode: "hover" });
    expect(view?.mode).toBe("hover");
    expect(view?.target).toEqual({ kind: "none" });
    expect(view?.tooltip).toEqual([]);
    expect(view?.pointer).toEqual(pointer);
    expect(view?.moduleHints.get("P")?.hint.useful).toBe(true);
    expect(view?.moduleHints.get("Q")?.hint.useful).toBe(false);
  });

  it("mode가 없으면 drag로 본다", () => {
    const { world, layout, ids } = setup();
    expect(computeDragView(world, layout, ids[2], poolJobCenter(layout, 0))?.mode).toBe("drag");
  });
});

/** 포인터 이벤트 리스너만 흉내 내는 가짜 캔버스 (DOM 없이 attachDragInput을 돌린다) */
function fakeCanvas() {
  const listeners = new Map<string, (e: PointerEvent) => void>();
  const canvas = {
    style: { cursor: "" },
    addEventListener(type: string, fn: (e: PointerEvent) => void) {
      listeners.set(type, fn);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
  };
  const fire = (type: string, p: Point, extra: Partial<PointerEvent> = {}) => {
    const e = { clientX: p.x, clientY: p.y, pointerId: 1, isPrimary: true, button: 0, pointerType: "mouse", preventDefault() {}, ...extra };
    listeners.get(type)?.(e as unknown as PointerEvent);
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, fire, listeners };
}

describe("attachDragInput hover", () => {
  it("작업 위로 마우스를 옮기면 hover, 벗어나거나 캔버스를 떠나면 null", () => {
    const { world, layout, ids } = setup();
    const { canvas, fire } = fakeCanvas();
    const input = attachDragInput({ canvas, getWorld: () => world, getLayout: () => layout, supervisor: { submit() {} } });
    const p = poolJobCenter(layout, 0);
    fire("pointermove", p);
    expect(input.current()).toEqual({ jobId: ids[2], pointer: { ...p, mode: "hover" } });
    fire("pointermove", { x: 0, y: 0 });
    expect(input.current()).toBeNull();
    fire("pointermove", p);
    fire("pointerleave", p);
    expect(input.current()).toBeNull();
    input.detach();
  });

  it("터치 이동은 hover로 보지 않는다", () => {
    const { world, layout } = setup();
    const { canvas, fire } = fakeCanvas();
    const input = attachDragInput({ canvas, getWorld: () => world, getLayout: () => layout, supervisor: { submit() {} } });
    fire("pointermove", poolJobCenter(layout, 0), { pointerType: "touch" });
    expect(input.current()).toBeNull();
    input.detach();
  });

  it("드래그 중에는 drag, 놓으면 명령을 보내고 다시 hover", () => {
    const { world, layout, ids } = setup();
    const { canvas, fire } = fakeCanvas();
    const sent: Command[] = [];
    const input = attachDragInput({ canvas, getWorld: () => world, getLayout: () => layout, supervisor: { submit: (c) => sent.push(c) } });
    const start = poolJobCenter(layout, 0);
    const target = slotCenter(moduleLayout(layout, "Q"), 0);
    fire("pointerdown", start);
    fire("pointermove", target);
    expect(input.current()).toEqual({ jobId: ids[2], pointer: { ...target, mode: "drag" } });
    fire("pointerup", target);
    expect(sent).toEqual([{ type: "assign", jobId: ids[2], moduleId: "Q" }]);
    // 명령은 다음 step에 적용되므로 놓은 자리(Q 슬롯)는 아직 비어 있다 → hover 대상 없음
    expect(input.current()).toBeNull();
    fire("pointermove", poolJobCenter(layout, 1));
    expect(input.current()).toEqual({ jobId: ids[3], pointer: { ...poolJobCenter(layout, 1), mode: "hover" } });
    input.detach();
  });

  it("감독관이 없으면 드래그하지 않고 hover만 한다", () => {
    const { world, layout, ids } = setup();
    const { canvas, fire } = fakeCanvas();
    const input = attachDragInput({ canvas, getWorld: () => world, getLayout: () => layout });
    const p = poolJobCenter(layout, 0);
    fire("pointerdown", p);
    fire("pointermove", poolJobCenter(layout, 1));
    expect(input.current()).toEqual({ jobId: ids[3], pointer: { ...poolJobCenter(layout, 1), mode: "hover" } });
    input.detach();
  });

  it("detach하면 리스너를 모두 뗀다", () => {
    const { world, layout } = setup();
    const { canvas, listeners } = fakeCanvas();
    attachDragInput({ canvas, getWorld: () => world, getLayout: () => layout }).detach();
    expect(listeners.size).toBe(0);
  });
});

describe("createToastQueue", () => {
  it("최근 N개만 남기고, 같은 메시지는 횟수만 올리고, 수명이 지나면 사라진다", () => {
    const q = createToastQueue({ max: 2, durationMs: 100 });
    q.push("a", 0);
    q.push("a", 10);
    expect(q.active(10)).toEqual([{ message: "a", count: 2, at: 10 }]);
    q.push("b", 20);
    q.push("c", 30);
    expect(q.active(30).map((t) => t.message)).toEqual(["b", "c"]);
    expect(q.active(125).map((t) => t.message)).toEqual(["c"]);
    expect(q.active(130)).toEqual([]);
  });
});
