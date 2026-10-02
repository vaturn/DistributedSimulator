// Canvas 2D 렌더러. 엔진 상태(WorldState)를 읽기만 하고 절대 바꾸지 않는다.
// 진행률처럼 규칙에 속하는 값은 직접 계산하지 않고 engine/rules.ts의 조회 함수만 쓴다.

import { moveProgressRatio, processProgressRatio } from "../engine/rules";
import type { Job, JobLocation, Module, WorldState } from "../engine/types";
import {
  poolCapacity,
  poolJobCenter,
  queueCapacity,
  queueJobCenter,
  slotCenter,
  type Layout,
  type ModuleLayout,
  type Point,
  type Rect,
} from "./layout";
import type { ResultColors } from "./palette";
import {
  COLORS,
  DONE_RING_DASH,
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
  MODULE_CORNER_RADIUS,
  PERCENT,
  POOL_JOB_RADIUS,
  POOL_TITLE_HEIGHT,
  PROGRESS_RING_OFFSET,
  PROGRESS_RING_WIDTH,
  QUEUE_JOB_RADIUS,
  QUEUE_LABEL_RESERVED_SLOTS,
  START_ANGLE,
  TIME_DECIMALS,
} from "./theme";

/** 렌더러에 넘기는 표시 정보 (엔진 상태가 아닌 것) */
export interface RenderInfo {
  colors: ResultColors;
  scenarioName: string;
  supervisorName: string;
}

type Ctx = CanvasRenderingContext2D;

function font(size: number): string {
  return `${size}px ${FONT_FAMILY}`;
}

function roundRect(ctx: Ctx, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, radius);
}

function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
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

function drawModule(ctx: Ctx, world: WorldState, module: Module, ml: ModuleLayout, info: RenderInfo): void {
  const color = info.colors.colorOf(module.resultType);

  // 상자
  roundRect(ctx, ml.box, MODULE_CORNER_RADIUS);
  ctx.fillStyle = COLORS.moduleFill;
  ctx.fill();

  // 제목 줄: 결과 색을 옅게 깔고 "ID · 결과 · 처리 시간 · 용량"
  ctx.save();
  roundRect(ctx, ml.box, MODULE_CORNER_RADIUS);
  ctx.clip();
  ctx.globalAlpha = HEADER_TINT_ALPHA;
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

  // 슬롯: 용량만큼 자리를 그리고, 차 있는 자리에는 작업을 그린다.
  for (let i = 0; i < module.capacity; i++) {
    const center = slotCenter(ml, i);
    const jobId = module.slots[i];
    const job = jobId === undefined ? undefined : world.jobs.get(jobId);
    if (!job) {
      drawEmptySlot(ctx, center, ml.jobRadius);
      continue;
    }
    drawJob(ctx, job, center, ml.jobRadius, info.colors);
    if (job.state === "PROCESSING") {
      const ratio = processProgressRatio(world, job.id);
      drawProgressRing(ctx, center, ml.jobRadius, ratio);
      drawCaption(ctx, `${Math.floor(ratio * PERCENT)}%`, center, ml.jobRadius, COLORS.textDim);
    } else if (job.state === "DONE_AT_MODULE") {
      drawDoneRing(ctx, center, ml.jobRadius);
      drawCaption(ctx, "처리 끝", center, ml.jobRadius, COLORS.doneMarker);
    }
  }

  drawQueue(ctx, world, module, ml, info);
}

/** 대기열: 상자 아래 작은 원 한 줄. 넘치면 "+N"을 붙인다. */
function drawQueue(ctx: Ctx, world: WorldState, module: Module, ml: ModuleLayout, info: RenderInfo): void {
  const shown = Math.max(0, queueCapacity(ml) - QUEUE_LABEL_RESERVED_SLOTS);
  const visible = module.queue.slice(0, shown);
  visible.forEach((jobId, i) => {
    const job = world.jobs.get(jobId);
    if (job) drawJob(ctx, job, queueJobCenter(ml, i), QUEUE_JOB_RADIUS, info.colors);
  });
  const hidden = module.queue.length - visible.length;
  ctx.font = font(FONT_SIZE_SMALL);
  ctx.fillStyle = COLORS.textDim;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const label = hidden > 0 ? `+${hidden} · 대기 ${module.queue.length}` : `대기 ${module.queue.length}`;
  ctx.fillText(label, ml.queueArea.x + ml.queueArea.w, ml.queueArea.y + ml.queueArea.h / 2);
}

function drawPool(ctx: Ctx, world: WorldState, layout: Layout, info: RenderInfo): void {
  roundRect(ctx, layout.pool, MODULE_CORNER_RADIUS);
  ctx.fillStyle = COLORS.poolFill;
  ctx.fill();
  ctx.strokeStyle = COLORS.poolBorder;
  ctx.lineWidth = MODULE_BORDER_WIDTH;
  ctx.stroke();

  const poolJobs: Job[] = [];
  for (const job of world.jobs.values()) {
    if (job.state === "POOL") poolJobs.push(job);
  }

  ctx.font = font(FONT_SIZE_LABEL);
  ctx.fillStyle = COLORS.textDim;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const capacity = poolCapacity(layout);
  const hidden = Math.max(0, poolJobs.length - capacity);
  const title = hidden > 0 ? `대기 구역 ${poolJobs.length} (+${hidden} 숨김)` : `대기 구역 ${poolJobs.length}`;
  ctx.fillText(title, layout.poolContent.x, layout.pool.y + POOL_TITLE_HEIGHT / 2);

  poolJobs.slice(0, capacity).forEach((job, i) => {
    drawJob(ctx, job, poolJobCenter(layout, i), POOL_JOB_RADIUS, info.colors);
  });
}

/** 위치(대기 구역 또는 모듈)의 대표 좌표. 이동 애니메이션의 출발점으로 쓴다. */
function locationPoint(layout: Layout, location: JobLocation): Point {
  if (location.kind === "pool") return rectCenter(layout.poolContent);
  const ml = layout.modules.find((m) => m.id === location.moduleId);
  return ml ? rectCenter(ml.box) : rectCenter(layout.poolContent);
}

/** 이동 중인 작업: 출발점과 목적지 대기열 입구 사이를 남은 이동 시간 비율로 보간한다. */
function drawMovingJobs(ctx: Ctx, world: WorldState, layout: Layout, info: RenderInfo): void {
  for (const [jobId, move] of world.moves) {
    const job = world.jobs.get(jobId);
    const module = world.modules.get(move.moduleId);
    const ml = layout.modules.find((m) => m.id === move.moduleId);
    if (!job || !module || !ml) continue;
    const t = moveProgressRatio(world, jobId);
    const from = locationPoint(layout, move.from);
    const to = queueJobCenter(ml, module.queue.length);
    const p: Point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    drawJob(ctx, job, p, POOL_JOB_RADIUS, info.colors);
  }
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

/** 한 프레임을 그린다. ctx는 CSS 픽셀 좌표계로 맞춰져 있어야 한다. */
export function render(ctx: Ctx, world: WorldState, layout: Layout, info: RenderInfo): void {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, layout.viewport.width, layout.viewport.height);

  drawHud(ctx, world, layout, info);
  drawPool(ctx, world, layout, info);
  for (const ml of layout.modules) {
    const module = world.modules.get(ml.id);
    if (module) drawModule(ctx, world, module, ml, info);
  }
  drawMovingJobs(ctx, world, layout, info);
}
