// 드래그 앤 드롭 입력 → 수동 감독관 명령 (기획서 §7 조작).
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

/** 툴팁 한 줄 */
export interface TooltipLine {
  text: string;
  tone: "info" | "warn" | "blocked";
}

/** 대기 구역에 놓을 때의 판정 */
export interface PoolDropHint {
  /** 놓으면 unassign 명령을 보내는가 (이미 대기 구역이면 false) */
  sends: boolean;
  /** 엔진이 받아들이는가 (canUnassign) */
  ok: boolean;
  reason?: string;
}

/** 렌더러에 넘기는 드래그 표시 정보 */
export interface DragView {
  jobId: JobId;
  pointer: Point;
  target: DropTarget;
  moduleHints: ReadonlyMap<ModuleId, ModuleDropHint>;
  pool: PoolDropHint;
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

/** 드래그 중 표시 정보를 계산한다. 작업이 사라졌거나 완료됐으면 null */
export function computeDragView(
  world: Readonly<WorldState>,
  layout: Layout,
  jobId: JobId,
  pointer: Point,
): DragView | null {
  const job = world.jobs.get(jobId);
  if (!job || job.state === "COMPLETED") return null;
  const moduleHints = new Map<ModuleId, ModuleDropHint>();
  for (const moduleId of world.modules.keys()) {
    const hint = assignHint(world, jobId, moduleId);
    moduleHints.set(moduleId, { hint, level: hintLevel(hint) });
  }
  const target = hitTestDropTarget(layout, pointer);
  const pool = poolDropHint(world, jobId);
  return { jobId, pointer, target, moduleHints, pool, tooltip: tooltipFor(target, moduleHints, pool) };
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
  supervisor: Pick<ManualSupervisor, "submit">;
  /** 드래그 상태가 바뀌면 불린다 (다시 그리기용) */
  onChange?(): void;
}

export interface DragInput {
  /** 지금 드래그 중이면 작업과 포인터 위치 (임계값을 넘기 전에는 null) */
  current(): { jobId: JobId; pointer: Point } | null;
  detach(): void;
}

/** 캔버스에 포인터 이벤트(마우스·터치·펜)를 연결한다. */
export function attachDragInput(options: DragInputOptions): DragInput {
  const { canvas } = options;
  let drag: DragState | null = null;

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
    if (drag || !e.isPrimary || e.button !== 0) return;
    const p = toPoint(e);
    const hit = hitTestJob(options.getLayout(), options.getWorld(), p);
    if (!hit) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = { pointerId: e.pointerId, jobId: hit.jobId, start: p, pointer: p, dragging: false };
  };

  const onMove = (e: PointerEvent): void => {
    const p = toPoint(e);
    if (!drag) {
      // 잡을 수 있는 작업 위에서는 손 모양 커서
      canvas.style.cursor = hitTestJob(options.getLayout(), options.getWorld(), p) ? "grab" : "";
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
      if (cmd) options.supervisor.submit(cmd);
    }
    end();
  };

  const onCancel = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.pointerId) end();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);

  return {
    current() {
      return drag && drag.dragging ? { jobId: drag.jobId, pointer: drag.pointer } : null;
    },
    detach() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      end();
    },
  };
}
