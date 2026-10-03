// 드래그 앤 드롭 입력 → 수동 감독관 명령 (기획서 §7 조작), 그리고 작업 hover(툴팁·유용 모듈 강조).
// 히트 판정·드롭 변환·강조 판정은 순수 함수로 두어 테스트할 수 있게 한다.
// 상태는 직접 바꾸지 않고 manual 감독관의 submit으로 Command만 넘긴다.
// 배치 가능 여부·경고 판정은 engine/rules.ts의 assignHint/canUnassign만 쓴다.

import { assignHint, canUnassign, type AssignHint } from "../engine/rules";
import type { Command, JobId, ModuleId, WorldState } from "../engine/types";
import type { ManualSupervisor } from "../supervisor/manual";
import type { Layout, Point, Rect } from "./layout";
import { allPlacements, type JobPlacement } from "./placement";
import { DRAG_THRESHOLD, HIT_SLOP } from "./theme";

/** 드롭 대상: 모듈(상자 또는 그 아래 대기열), 대기 구역, 없음 */
export type DropTarget = { kind: "module"; moduleId: ModuleId } | { kind: "pool" } | { kind: "none" };

function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * 포인터 아래의 작업 원을 찾는다. 렌더러와 같은 위치 함수(placement.ts)를 쓴다.
 * 위에 그려진 것(나중에 그린 것)을 먼저 잡는다. COMPLETED 작업은 잡을 수 없다.
 */
export function hitTestJob(layout: Layout, world: Readonly<WorldState>, point: Point): JobPlacement | null {
  const placements = allPlacements(world, layout);
  for (let i = placements.length - 1; i >= 0; i--) {
    const p = placements[i];
    const job = world.jobs.get(p.jobId);
    if (!job || job.state === "COMPLETED") continue;
    const r = p.radius + HIT_SLOP;
    const dx = point.x - p.center.x;
    const dy = point.y - p.center.y;
    if (dx * dx + dy * dy <= r * r) return p;
  }
  return null;
}

/** 포인터 아래의 드롭 대상. 모듈은 상자와 그 아래 대기열 영역을 모두 포함한다. */
export function hitTestDropTarget(layout: Layout, point: Point): DropTarget {
  for (const ml of layout.modules) {
    if (inRect(point, ml.box) || inRect(point, ml.queueArea)) return { kind: "module", moduleId: ml.id };
  }
  if (inRect(point, layout.pool)) return { kind: "pool" };
  return { kind: "none" };
}

/**
 * 드롭을 명령으로 바꾼다. null이면 아무 명령도 내지 않는다(취소).
 * - 모듈 → assign (배치 판단은 감독관 책임이므로 경고가 있어도 보낸다. 거부는 엔진이 warning으로 알린다)
 * - 대기 구역 → unassign (이미 대기 구역에 있으면 무시)
 * - 그 밖 → 취소. 사라졌거나 완료된 작업도 취소.
 */
export function dropToCommand(world: Readonly<WorldState>, jobId: JobId, target: DropTarget): Command | null {
  const job = world.jobs.get(jobId);
  if (!job || job.state === "COMPLETED") return null;
  switch (target.kind) {
    case "module":
      return { type: "assign", jobId, moduleId: target.moduleId };
    case "pool":
      return job.state === "POOL" ? null : { type: "unassign", jobId };
    case "none":
      return null;
  }
}

/** 시작점에서 threshold 이상 움직였는가 (미만이면 클릭으로 본다) */
export function exceedsDragThreshold(start: Point, now: Point, threshold: number = DRAG_THRESHOLD): boolean {
  const dx = now.x - start.x;
  const dy = now.y - start.y;
  return dx * dx + dy * dy >= threshold * threshold;
}

/** 모듈 강조 단계: 유용(경고 없음) / 가능하지만 경고 / 불가 */
export type HintLevel = "useful" | "warn" | "blocked";

/** assignHint 결과를 강조 단계로 바꾼다. 판정 자체는 assignHint가 한다. */
export function hintLevel(hint: AssignHint): HintLevel {
  if (!hint.ok) return "blocked";
  return hint.useful && hint.warnings.length === 0 ? "useful" : "warn";
}

export interface ModuleDropHint {
  hint: AssignHint;
  level: HintLevel;
}

/** 툴팁 한 줄. accent는 남은 결과처럼 눈에 띄게 할 정보 */
export interface TooltipLine {
  text: string;
  tone: "info" | "warn" | "blocked" | "accent";
}

/** 포인터 표시 방식: 드래그 중(drag) 또는 마우스를 올려 둠(hover, 드래그 아님) */
export type PointerMode = "drag" | "hover";

/** 포인터 위치와 표시 방식. mode가 없으면 drag로 본다. */
export interface TrackedPointer extends Point {
  mode?: PointerMode;
}

/** 대기 구역에 놓을 때의 판정 */
export interface PoolDropHint {
  /** 놓으면 unassign 명령을 보내는가 (이미 대기 구역이면 false) */
  sends: boolean;
  /** 엔진이 받아들이는가 (canUnassign) */
  ok: boolean;
  reason?: string;
}

/** 렌더러에 넘기는 드래그(또는 hover) 표시 정보 */
export interface DragView {
  /** drag: 드롭 대상 강조·드롭 툴팁. hover: 작업 정보 툴팁·남은 결과를 주는 모듈 은은한 강조 */
  mode: PointerMode;
  jobId: JobId;
  pointer: Point;
  target: DropTarget;
  moduleHints: ReadonlyMap<ModuleId, ModuleDropHint>;
  pool: PoolDropHint;
  /** 드롭 툴팁 (hover이면 비어 있다. 작업 정보 툴팁은 렌더러가 jobLabel.jobTooltipLines로 만든다) */
  tooltip: TooltipLine[];
}

function poolDropHint(world: Readonly<WorldState>, jobId: JobId): PoolDropHint {
  const job = world.jobs.get(jobId);
  if (!job || job.state === "POOL") return { sends: false, ok: false };
  const check = canUnassign(world, jobId);
  return { sends: true, ok: check.ok, reason: check.reason };
}

function tooltipFor(target: DropTarget, hints: ReadonlyMap<ModuleId, ModuleDropHint>, pool: PoolDropHint): TooltipLine[] {
  switch (target.kind) {
    case "module": {
      const h = hints.get(target.moduleId);
      if (!h) return [];
      if (!h.hint.ok) return [{ text: `배치 불가: ${h.hint.reason ?? "알 수 없는 이유"}`, tone: "blocked" }];
      const lines: TooltipLine[] = h.hint.warnings.map((w) => ({ text: w, tone: "warn" }));
      if (lines.length === 0) {
        lines.push({ text: h.hint.useful ? `${target.moduleId}에 배치` : `${target.moduleId}: 변화 없음`, tone: h.hint.useful ? "info" : "warn" });
      }
      return lines;
    }
    case "pool":
      if (!pool.sends) return [{ text: "이미 대기 구역에 있음", tone: "info" }];
      if (!pool.ok) return [{ text: `회수 불가: ${pool.reason ?? "알 수 없는 이유"}`, tone: "blocked" }];
      return [{ text: "대기 구역으로 회수", tone: "info" }];
    case "none":
      return [{ text: "여기에 놓으면 취소", tone: "info" }];
  }
}

/**
 * 드래그(또는 hover) 중 표시 정보를 계산한다. 작업이 사라졌거나 완료됐으면 null.
 * pointer.mode가 "hover"면 드롭 대상은 없음으로 두고 드롭 툴팁을 만들지 않는다.
 */
export function computeDragView(
  world: Readonly<WorldState>,
  layout: Layout,
  jobId: JobId,
  pointer: TrackedPointer,
): DragView | null {
  const job = world.jobs.get(jobId);
  if (!job || job.state === "COMPLETED") return null;
  const moduleHints = new Map<ModuleId, ModuleDropHint>();
  for (const moduleId of world.modules.keys()) {
    const hint = assignHint(world, jobId, moduleId);
    moduleHints.set(moduleId, { hint, level: hintLevel(hint) });
  }
  const pool = poolDropHint(world, jobId);
  const point: Point = { x: pointer.x, y: pointer.y };
  if (pointer.mode === "hover") {
    return { mode: "hover", jobId, pointer: point, target: { kind: "none" }, moduleHints, pool, tooltip: [] };
  }
  const target = hitTestDropTarget(layout, point);
  return { mode: "drag", jobId, pointer: point, target, moduleHints, pool, tooltip: tooltipFor(target, moduleHints, pool) };
}

// ---------- 포인터 이벤트 연결 (DOM) ----------

/** 진행 중인 드래그. pending은 아직 임계값만큼 움직이지 않은 상태(클릭일 수 있음) */
interface DragState {
  pointerId: number;
  jobId: JobId;
  start: Point;
  pointer: Point;
  dragging: boolean;
}

export interface DragInputOptions {
  canvas: HTMLCanvasElement;
  getWorld(): Readonly<WorldState>;
  getLayout(): Layout;
  /** 없으면 드래그는 하지 않고 hover(툴팁·강조)만 한다 (정책 감독관 관전용) */
  supervisor?: Pick<ManualSupervisor, "submit">;
  /** 드래그 상태가 바뀌면 불린다 (다시 그리기용) */
  onChange?(): void;
}

export interface DragInput {
  /**
   * 지금 드래그 중이면 작업과 포인터 위치(mode "drag"). 드래그가 아니고 마우스가 작업 위에 있으면
   * 그 작업과 포인터 위치(mode "hover"). 둘 다 아니면 null. 그대로 computeDragView에 넘기면 된다.
   * hover 작업은 부를 때마다 마지막 포인터 위치로 다시 히트 판정한다 (작업이 움직여도 맞게).
   */
  current(): { jobId: JobId; pointer: TrackedPointer } | null;
  detach(): void;
}

/** 캔버스에 포인터 이벤트(마우스·터치·펜)를 연결한다. */
export function attachDragInput(options: DragInputOptions): DragInput {
  const { canvas } = options;
  let drag: DragState | null = null;
  /** 마우스·펜이 캔버스 위에 있을 때 마지막 위치 (hover 판정용). 캔버스를 벗어나면 null */
  let hoverPoint: Point | null = null;

  const toPoint = (e: PointerEvent): Point => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const end = (): void => {
    if (drag && canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    drag = null;
    canvas.style.cursor = "";
    options.onChange?.();
  };

  const onDown = (e: PointerEvent): void => {
    if (!options.supervisor || drag || !e.isPrimary || e.button !== 0) return;
    const p = toPoint(e);
    const hit = hitTestJob(options.getLayout(), options.getWorld(), p);
    if (!hit) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = { pointerId: e.pointerId, jobId: hit.jobId, start: p, pointer: p, dragging: false };
  };

  const onMove = (e: PointerEvent): void => {
    const p = toPoint(e);
    hoverPoint = e.pointerType === "touch" ? null : p;
    if (!drag) {
      // 잡을 수 있는 작업 위에서는 손 모양 커서
      canvas.style.cursor = options.supervisor && hitTestJob(options.getLayout(), options.getWorld(), p) ? "grab" : "";
      return;
    }
    if (e.pointerId !== drag.pointerId) return;
    drag.pointer = p;
    if (!drag.dragging && exceedsDragThreshold(drag.start, p)) drag.dragging = true;
    if (drag.dragging) {
      canvas.style.cursor = "grabbing";
      options.onChange?.();
    }
  };

  const onUp = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = toPoint(e);
    if (drag.dragging) {
      const world = options.getWorld();
      const cmd = dropToCommand(world, drag.jobId, hitTestDropTarget(options.getLayout(), p));
      if (cmd) options.supervisor?.submit(cmd);
    }
    end();
  };

  const onCancel = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.pointerId) end();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  const onLeave = (): void => {
    hoverPoint = null;
    if (!drag) canvas.style.cursor = "";
  };

  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);

  return {
    current() {
      if (drag && drag.dragging) return { jobId: drag.jobId, pointer: { ...drag.pointer, mode: "drag" } };
      if (!hoverPoint) return null;
      const hit = hitTestJob(options.getLayout(), options.getWorld(), hoverPoint);
      return hit ? { jobId: hit.jobId, pointer: { ...hoverPoint, mode: "hover" } } : null;
    },
    detach() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      hoverPoint = null;
      end();
    },
  };
}
