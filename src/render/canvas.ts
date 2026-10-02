// Canvas 2D 렌더러. 엔진 상태(WorldState)를 읽기만 하고 절대 바꾸지 않는다.
// 진행률처럼 규칙에 속하는 값은 직접 계산하지 않고 engine/rules.ts의 조회 함수만 쓴다.

import { processProgressRatio } from "../engine/rules";
import type { Job, Module, WorldState } from "../engine/types";
import type { DragView, TooltipLine } from "./input";
import { poolCapacity, slotCenter, type Layout, type ModuleLayout, type Point, type Rect } from "./layout";
import type { ResultColors } from "./palette";
import {
  movingPlacements,
  poolJobCount,
  poolPlacements,
  queuePlacements,
  rectCenter,
  slotPlacements,
  type JobPlacement,
} from "./placement";
import type { Toast } from "./toasts";
import {
  COLORS,
  DONE_RING_DASH,
  DRAG_GHOST_ALPHA,
  DRAG_JOB_ALPHA,
  DROP_BLOCKED_ALPHA,
  DROP_HIGHLIGHT_WIDTH,
  DROP_HOVER_WIDTH,
  DONE_RING_OFFSET,
  DONE_RING_WIDTH,
  FONT_FAMILY,
  FONT_SIZE_HUD,
  FONT_SIZE_LABEL,
  FONT_SIZE_SMALL,
  FULL_TURN,
  HEADER_TINT_ALPHA,
  JOB_OUTLINE_WIDTH,
  MODULE_BORDER_WIDTH,
  MARGIN,
  MODULE_CORNER_RADIUS,
  PERCENT,
  POOL_JOB_RADIUS,
  POOL_TITLE_HEIGHT,
  PROGRESS_RING_OFFSET,
  PROGRESS_RING_WIDTH,
  START_ANGLE,
  TIME_DECIMALS,
  TOAST_BORDER_WIDTH,
  TOAST_DURATION_MS,
  TOAST_FADE_MS,
  TOAST_GAP,
  TOAST_HEIGHT,
  TOAST_PADDING,
  TOAST_WIDTH,
  TOOLTIP_ALPHA,
  TOOLTIP_LINE_HEIGHT,
  TOOLTIP_MAX_LINES,
  TOOLTIP_OFFSET,
  TOOLTIP_PADDING,
} from "./theme";

/** 렌더러에 넘기는 표시 정보 (엔진 상태가 아닌 것) */
export interface RenderInfo {
  colors: ResultColors;
  scenarioName: string;
  supervisorName: string;
}

/** 엔진 상태가 아닌 화면 위 덧그림 (드래그, 경고 토스트) */
export interface RenderOverlay {
  /** 드래그 중이면 표시 정보 */
  drag: DragView | null;
  /** 보이는 경고 토스트 (오래된 것 먼저) */
  toasts: readonly Toast[];
  /** 토스트 페이드 계산용 실제 시각(ms) */
  now: number;
}

const EMPTY_OVERLAY: RenderOverlay = { drag: null, toasts: [], now: 0 };

type Ctx = CanvasRenderingContext2D;

function font(size: number): string {
  return `${size}px ${FONT_FAMILY}`;
}

function roundRect(ctx: Ctx, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}

/** 작업에 필요한 결과를 결정적인 순서(시나리오 결과 순서)로 정렬한다. */
function sortedRequired(job: Job, colors: ResultColors): string[] {
  return [...job.required].sort((a, b) => colors.indexOf(a) - colors.indexOf(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** 작업 원: 필요 결과 수만큼 파이 조각으로 나누고, 얻은 조각은 채우고 못 얻은 조각은 테두리만 둔다. */
function drawJob(ctx: Ctx, job: Job, center: Point, radius: number, colors: ResultColors): void {
  const required = sortedRequired(job, colors);
  const n = Math.max(1, required.length);
  const sweep = FULL_TURN / n;
  required.forEach((r, i) => {
    const a0 = START_ANGLE + i * sweep;
    const a1 = a0 + sweep;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.arc(center.x, center.y, radius, a0, a1);
    ctx.closePath();
    const color = colors.colorOf(r);
    ctx.fillStyle = job.acquired.has(r) ? color : COLORS.sliceEmptyFill;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = JOB_OUTLINE_WIDTH;
    ctx.stroke();
  });
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, FULL_TURN);
  ctx.strokeStyle = COLORS.jobOutline;
  ctx.lineWidth = JOB_OUTLINE_WIDTH;
  ctx.stroke();
}

function drawProgressRing(ctx: Ctx, center: Point, radius: number, ratio: number): void {
  const r = radius + PROGRESS_RING_OFFSET;
  ctx.lineWidth = PROGRESS_RING_WIDTH;
  ctx.beginPath();
  ctx.arc(center.x, center.y, r, 0, FULL_TURN);
  ctx.strokeStyle = COLORS.progressTrack;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(center.x, center.y, r, START_ANGLE, START_ANGLE + ratio * FULL_TURN);
  ctx.strokeStyle = COLORS.progressBar;
  ctx.stroke();
}

/** DONE_AT_MODULE: 처리는 끝났지만 감독관이 옮기기를 기다리는 작업 (점선 링) */
function drawDoneRing(ctx: Ctx, center: Point, radius: number): void {
  ctx.save();
  ctx.setLineDash([...DONE_RING_DASH]);
  ctx.lineWidth = DONE_RING_WIDTH;
  ctx.strokeStyle = COLORS.doneMarker;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius + DONE_RING_OFFSET, 0, FULL_TURN);
  ctx.stroke();
  ctx.restore();
}

function drawEmptySlot(ctx: Ctx, center: Point, radius: number): void {
  ctx.save();
  ctx.setLineDash([...DONE_RING_DASH]);
  ctx.lineWidth = JOB_OUTLINE_WIDTH;
  ctx.strokeStyle = COLORS.slotEmpty;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, FULL_TURN);
  ctx.stroke();
  ctx.restore();
}

/** 원 아래에 짧은 글자를 쓴다 (진행률 %, 처리 끝 표시) */
function drawCaption(ctx: Ctx, text: string, center: Point, radius: number, color: string): void {
  ctx.font = font(FONT_SIZE_SMALL);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(text, center.x, center.y + radius + PROGRESS_RING_OFFSET + PROGRESS_RING_WIDTH);
}

/** 드래그 중인 작업은 원래 자리를 반투명하게 그린다. */
function drawPlacedJob(ctx: Ctx, world: WorldState, p: JobPlacement, info: RenderInfo, overlay: RenderOverlay): Job | null {
  const job = world.jobs.get(p.jobId);
  if (!job) return null;
  const ghost = overlay.drag?.jobId === p.jobId;
  ctx.save();
  if (ghost) ctx.globalAlpha = DRAG_GHOST_ALPHA;
  drawJob(ctx, job, p.center, p.radius, info.colors);
  ctx.restore();
  return job;
}

/** 드래그 중 모듈 강조: 불가=흐리게, 유용=강조색, 경고=주의색, 포인터 아래=두꺼운 테두리 */
function drawModuleDropHint(ctx: Ctx, ml: ModuleLayout, overlay: RenderOverlay): void {
  const drag = overlay.drag;
  if (!drag) return;
  const h = drag.moduleHints.get(ml.id);
  if (!h) return;
  const hovered = drag.target.kind === "module" && drag.target.moduleId === ml.id;
  if (h.level === "blocked") {
    if (!hovered) return;
    ctx.strokeStyle = COLORS.tooltipBlocked;
  } else {
    ctx.strokeStyle = h.level === "useful" ? COLORS.dropUseful : COLORS.dropWarn;
  }
  ctx.lineWidth = hovered ? DROP_HOVER_WIDTH : DROP_HIGHLIGHT_WIDTH;
  roundRect(ctx, ml.box, MODULE_CORNER_RADIUS);
  ctx.stroke();
}

function drawModule(
  ctx: Ctx,
  world: WorldState,
  module: Module,
  ml: ModuleLayout,
  info: RenderInfo,
  overlay: RenderOverlay,
): void {
  const color = info.colors.colorOf(module.resultType);
  const blocked = overlay.drag?.moduleHints.get(ml.id)?.level === "blocked";

  ctx.save();
  if (blocked) ctx.globalAlpha = DROP_BLOCKED_ALPHA;

  // 상자
  roundRect(ctx, ml.box, MODULE_CORNER_RADIUS);
  ctx.fillStyle = COLORS.moduleFill;
  ctx.fill();

  // 제목 줄: 결과 색을 옅게 깔고 "ID · 결과 · 처리 시간 · 용량"
  ctx.save();
  roundRect(ctx, ml.box, MODULE_CORNER_RADIUS);
  ctx.clip();
  ctx.globalAlpha *= HEADER_TINT_ALPHA;
  ctx.fillStyle = color;
  ctx.fillRect(ml.header.x, ml.header.y, ml.header.w, ml.header.h);
  ctx.restore();

  roundRect(ctx, ml.box, MODULE_CORNER_RADIUS);
  ctx.strokeStyle = color;
  ctx.lineWidth = MODULE_BORDER_WIDTH;
  ctx.stroke();

  ctx.font = font(FONT_SIZE_LABEL);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const title = `${module.id} · ${module.resultType} · ${module.processTime}s · 용량 ${module.capacity}`;
  const headerCenter = rectCenter(ml.header);
  ctx.fillText(title, headerCenter.x, headerCenter.y, ml.header.w);

  // 슬롯: 용량만큼 빈 자리를 그리고, 차 있는 자리에는 작업을 그린다.
  const filled = new Set<number>();
  for (const p of slotPlacements(world, module, ml)) {
    filled.add(module.slots.indexOf(p.jobId));
    const job = drawPlacedJob(ctx, world, p, info, overlay);
    if (!job) continue;
    if (job.state === "PROCESSING") {
      const ratio = processProgressRatio(world, job.id);
      drawProgressRing(ctx, p.center, p.radius, ratio);
      drawCaption(ctx, `${Math.floor(ratio * PERCENT)}%`, p.center, p.radius, COLORS.textDim);
    } else if (job.state === "DONE_AT_MODULE") {
      drawDoneRing(ctx, p.center, p.radius);
      drawCaption(ctx, "처리 끝", p.center, p.radius, COLORS.doneMarker);
    }
  }
  for (let i = 0; i < module.capacity; i++) {
    if (!filled.has(i)) drawEmptySlot(ctx, slotCenter(ml, i), ml.jobRadius);
  }

  drawQueue(ctx, world, module, ml, info, overlay);
  ctx.restore();

  drawModuleDropHint(ctx, ml, overlay);
}

/** 대기열: 상자 아래 작은 원 한 줄. 넘치면 "+N"을 붙인다. */
function drawQueue(
  ctx: Ctx,
  world: WorldState,
  module: Module,
  ml: ModuleLayout,
  info: RenderInfo,
  overlay: RenderOverlay,
): void {
  const placements = queuePlacements(world, module, ml);
  for (const p of placements) drawPlacedJob(ctx, world, p, info, overlay);
  const hidden = module.queue.length - placements.length;
  ctx.font = font(FONT_SIZE_SMALL);
  ctx.fillStyle = COLORS.textDim;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const label = hidden > 0 ? `+${hidden} · 대기 ${module.queue.length}` : `대기 ${module.queue.length}`;
  ctx.fillText(label, ml.queueArea.x + ml.queueArea.w, ml.queueArea.y + ml.queueArea.h / 2);
}

function drawPool(ctx: Ctx, world: WorldState, layout: Layout, info: RenderInfo, overlay: RenderOverlay): void {
  roundRect(ctx, layout.pool, MODULE_CORNER_RADIUS);
  ctx.fillStyle = COLORS.poolFill;
  ctx.fill();
  const drag = overlay.drag;
  const poolDroppable = drag !== null && drag.pool.sends && drag.pool.ok;
  const poolHovered = drag !== null && drag.target.kind === "pool";
  ctx.strokeStyle = poolDroppable ? COLORS.dropPool : COLORS.poolBorder;
  ctx.lineWidth = poolDroppable && poolHovered ? DROP_HOVER_WIDTH : poolDroppable ? DROP_HIGHLIGHT_WIDTH : MODULE_BORDER_WIDTH;
  ctx.stroke();

  const total = poolJobCount(world);
  ctx.font = font(FONT_SIZE_LABEL);
  ctx.fillStyle = COLORS.textDim;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const hidden = Math.max(0, total - poolCapacity(layout));
  const title = hidden > 0 ? `대기 구역 ${total} (+${hidden} 숨김)` : `대기 구역 ${total}`;
  ctx.fillText(title, layout.poolContent.x, layout.pool.y + POOL_TITLE_HEIGHT / 2);

  for (const p of poolPlacements(world, layout)) drawPlacedJob(ctx, world, p, info, overlay);
}

/** 이동 중인 작업 */
function drawMovingJobs(ctx: Ctx, world: WorldState, layout: Layout, info: RenderInfo, overlay: RenderOverlay): void {
  for (const p of movingPlacements(world, layout)) drawPlacedJob(ctx, world, p, info, overlay);
}

function drawHud(ctx: Ctx, world: WorldState, layout: Layout, info: RenderInfo): void {
  const ended = world.rules.isEnded(world);
  ctx.font = font(FONT_SIZE_HUD);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const y = layout.hud.y + layout.hud.h / 2;
  const text =
    `시나리오 ${info.scenarioName} · 감독관 ${info.supervisorName} · ` +
    `시간 ${world.simTime.toFixed(TIME_DECIMALS)}s · 완료 ${world.completedCount}`;
  ctx.fillStyle = COLORS.text;
  ctx.fillText(text, layout.hud.x, y);
  if (ended) {
    ctx.textAlign = "right";
    ctx.fillStyle = COLORS.ended;
    ctx.fillText("종료", layout.hud.x + layout.hud.w, y);
  }
}

function toneColor(tone: TooltipLine["tone"]): string {
  switch (tone) {
    case "info":
      return COLORS.tooltipText;
    case "warn":
      return COLORS.tooltipWarn;
    case "blocked":
      return COLORS.tooltipBlocked;
  }
}

/** 포인터를 따라가는 작업 원과 드롭 결과 툴팁 */
function drawDragged(ctx: Ctx, world: WorldState, layout: Layout, info: RenderInfo, drag: DragView): void {
  const job = world.jobs.get(drag.jobId);
  if (!job) return;
  ctx.save();
  ctx.globalAlpha = DRAG_JOB_ALPHA;
  drawJob(ctx, job, drag.pointer, POOL_JOB_RADIUS, info.colors);
  ctx.restore();

  const lines = drag.tooltip.slice(0, TOOLTIP_MAX_LINES);
  if (lines.length === 0) return;
  ctx.font = font(FONT_SIZE_LABEL);
  const textW = Math.max(...lines.map((l) => ctx.measureText(l.text).width));
  const w = textW + 2 * TOOLTIP_PADDING;
  const h = lines.length * TOOLTIP_LINE_HEIGHT + 2 * TOOLTIP_PADDING;
  // 포인터 오른쪽 아래에 두고, 화면 밖으로 나가면 반대쪽으로 넘긴다.
  let x = drag.pointer.x + TOOLTIP_OFFSET;
  let y = drag.pointer.y + TOOLTIP_OFFSET;
  if (x + w > layout.viewport.width) x = Math.max(0, drag.pointer.x - TOOLTIP_OFFSET - w);
  if (y + h > layout.viewport.height) y = Math.max(0, drag.pointer.y - TOOLTIP_OFFSET - h);
  ctx.save();
  ctx.globalAlpha = TOOLTIP_ALPHA;
  ctx.fillStyle = COLORS.tooltipFill;
  roundRect(ctx, { x, y, w, h }, MODULE_CORNER_RADIUS);
  ctx.fill();
  ctx.restore();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  lines.forEach((l, i) => {
    ctx.fillStyle = toneColor(l.tone);
    ctx.fillText(l.text, x + TOOLTIP_PADDING, y + TOOLTIP_PADDING + (i + 0.5) * TOOLTIP_LINE_HEIGHT);
  });
}

/** 경고 토스트: 화면 왼쪽 아래에서 위로 쌓는다. 최신이 맨 아래. 수명 끝 무렵 흐려진다. */
function drawToasts(ctx: Ctx, layout: Layout, overlay: RenderOverlay): void {
  const w = Math.min(TOAST_WIDTH, layout.viewport.width - 2 * MARGIN);
  if (w <= 0) return;
  ctx.font = font(FONT_SIZE_LABEL);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const n = overlay.toasts.length;
  overlay.toasts.forEach((t, i) => {
    const fromBottom = n - 1 - i;
    const y = layout.viewport.height - MARGIN - TOAST_HEIGHT - fromBottom * (TOAST_HEIGHT + TOAST_GAP);
    const remaining = TOAST_DURATION_MS - (overlay.now - t.at);
    const alpha = Math.max(0, Math.min(1, remaining / TOAST_FADE_MS));
    const r: Rect = { x: MARGIN, y, w, h: TOAST_HEIGHT };
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRect(ctx, r, MODULE_CORNER_RADIUS);
    ctx.fillStyle = COLORS.toastFill;
    ctx.fill();
    ctx.strokeStyle = COLORS.toastBorder;
    ctx.lineWidth = TOAST_BORDER_WIDTH;
    ctx.stroke();
    ctx.fillStyle = COLORS.toastText;
    const text = t.count > 1 ? `⚠ ${t.message} (×${t.count})` : `⚠ ${t.message}`;
    ctx.fillText(text, r.x + TOAST_PADDING, r.y + r.h / 2, r.w - 2 * TOAST_PADDING);
    ctx.restore();
  });
}

/** 한 프레임을 그린다. ctx는 CSS 픽셀 좌표계로 맞춰져 있어야 한다. */
export function render(
  ctx: Ctx,
  world: WorldState,
  layout: Layout,
  info: RenderInfo,
  overlay: RenderOverlay = EMPTY_OVERLAY,
): void {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, layout.viewport.width, layout.viewport.height);

  drawHud(ctx, world, layout, info);
  drawPool(ctx, world, layout, info, overlay);
  for (const ml of layout.modules) {
    const module = world.modules.get(ml.id);
    if (module) drawModule(ctx, world, module, ml, info, overlay);
  }
  drawMovingJobs(ctx, world, layout, info, overlay);
  drawToasts(ctx, layout, overlay);
  if (overlay.drag) drawDragged(ctx, world, layout, info, overlay.drag);
}
