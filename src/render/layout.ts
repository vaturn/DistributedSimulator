// 화면 배치 계산: 상태 표시줄, 대기 구역(pool), 모듈 상자와 그 안의 슬롯·대기열 좌표.
// 순수 함수만 둔다(DOM·Canvas 금지). 같은 입력이면 항상 같은 배치를 돌려준다.

import {
  GAP,
  HUD_HEIGHT,
  JOB_MAX_RADIUS,
  JOB_MIN_RADIUS,
  JOB_SPACING,
  MARGIN,
  MODULE_HEADER_HEIGHT,
  MODULE_MAX_HEIGHT,
  MODULE_MAX_WIDTH,
  MODULE_MIN_WIDTH,
  POOL_HEIGHT_RATIO,
  POOL_JOB_RADIUS,
  POOL_MAX_HEIGHT,
  POOL_MIN_HEIGHT,
  POOL_TITLE_HEIGHT,
  PROGRESS_RING_OFFSET,
  PROGRESS_RING_WIDTH,
  QUEUE_AREA_HEIGHT,
  QUEUE_JOB_RADIUS,
} from "./theme";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** 배치에 필요한 모듈 정보 (엔진 Module의 일부) */
export interface ModuleShape {
  id: string;
  capacity: number;
}

export interface ModuleLayout {
  id: string;
  capacity: number;
  /** 모듈 상자 전체 */
  box: Rect;
  /** 상자 위쪽 제목 줄 */
  header: Rect;
  /** 슬롯(처리 중 작업)을 놓는 영역 */
  slotArea: Rect;
  /** 상자 아래 대기열 영역 */
  queueArea: Rect;
  /** 슬롯에 놓이는 작업 원 반지름 */
  jobRadius: number;
}

export interface Layout {
  viewport: Viewport;
  /** 상단 상태 표시줄 */
  hud: Rect;
  /** 대기 구역 전체 */
  pool: Rect;
  /** 대기 구역 안에서 작업 원을 놓는 영역 */
  poolContent: Rect;
  /** 모듈 배치 (시나리오 모듈 순서) */
  modules: ModuleLayout[];
}

function nonNegative(v: number): number {
  return Math.max(0, v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 모듈 상자 안 슬롯에 놓을 작업 원 반지름. 진행률 링까지 들어가게 정한다. */
function slotJobRadius(slotArea: Rect, capacity: number): number {
  const ring = PROGRESS_RING_OFFSET + PROGRESS_RING_WIDTH;
  const perSlotW = slotArea.w / Math.max(1, capacity);
  const byWidth = perSlotW / 2 - ring;
  const byHeight = slotArea.h / 2 - ring;
  return clamp(Math.min(byWidth, byHeight, JOB_MAX_RADIUS), JOB_MIN_RADIUS, JOB_MAX_RADIUS);
}

/** 모듈 상자 하나의 배치 */
function layoutModule(shape: ModuleShape, box: Rect): ModuleLayout {
  const header: Rect = { x: box.x, y: box.y, w: box.w, h: Math.min(MODULE_HEADER_HEIGHT, box.h) };
  const slotArea: Rect = { x: box.x, y: box.y + header.h, w: box.w, h: nonNegative(box.h - header.h) };
  const queueArea: Rect = { x: box.x, y: box.y + box.h, w: box.w, h: QUEUE_AREA_HEIGHT };
  return {
    id: shape.id,
    capacity: shape.capacity,
    box,
    header,
    slotArea,
    queueArea,
    jobRadius: slotJobRadius(slotArea, shape.capacity),
  };
}

/** 모듈 수와 영역 너비로 열 수를 정한다. */
function columnCount(count: number, areaW: number): number {
  const fit = Math.floor((areaW + GAP) / (MODULE_MIN_WIDTH + GAP));
  return clamp(fit, 1, Math.max(1, count));
}

/** 화면 크기와 모듈 목록으로 전체 배치를 계산한다. */
export function computeLayout(viewport: Viewport, modules: readonly ModuleShape[]): Layout {
  const innerW = nonNegative(viewport.width - 2 * MARGIN);
  const hud: Rect = { x: MARGIN, y: MARGIN, w: innerW, h: HUD_HEIGHT };

  const belowHudY = hud.y + hud.h + GAP;
  const belowHudH = nonNegative(viewport.height - MARGIN - belowHudY);
  const poolH = Math.min(clamp(belowHudH * POOL_HEIGHT_RATIO, POOL_MIN_HEIGHT, POOL_MAX_HEIGHT), belowHudH);
  const pool: Rect = { x: MARGIN, y: belowHudY, w: innerW, h: poolH };
  const poolContent: Rect = {
    x: pool.x + JOB_SPACING,
    y: pool.y + POOL_TITLE_HEIGHT,
    w: nonNegative(pool.w - 2 * JOB_SPACING),
    h: nonNegative(pool.h - POOL_TITLE_HEIGHT - JOB_SPACING),
  };

  const areaY = pool.y + pool.h + GAP;
  const areaH = nonNegative(viewport.height - MARGIN - areaY);
  const count = modules.length;
  const cols = columnCount(count, innerW);
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = nonNegative((innerW - GAP * (cols - 1)) / cols);
  const cellH = nonNegative((areaH - GAP * (rows - 1)) / rows);
  const boxW = Math.min(cellW, MODULE_MAX_WIDTH);
  const boxH = Math.min(nonNegative(cellH - QUEUE_AREA_HEIGHT), MODULE_MAX_HEIGHT);

  const moduleLayouts: ModuleLayout[] = modules.map((shape, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // 마지막 줄은 모듈 수가 적을 수 있으므로 그 줄의 모듈들을 가운데 정렬한다.
    const inRow = Math.min(cols, count - row * cols);
    const rowW = inRow * cellW + (inRow - 1) * GAP;
    const rowX = MARGIN + (innerW - rowW) / 2;
    const cellX = rowX + col * (cellW + GAP);
    const cellY = areaY + row * (cellH + GAP);
    const box: Rect = { x: cellX + (cellW - boxW) / 2, y: cellY, w: boxW, h: boxH };
    return layoutModule(shape, box);
  });

  return { viewport, hud, pool, poolContent, modules: moduleLayouts };
}

/** 영역 안에 지름 2r 원을 간격 JOB_SPACING으로 격자 배치할 때의 열·행 수 */
function gridSize(area: Rect, radius: number): { cols: number; rows: number } {
  const pitch = 2 * radius + JOB_SPACING;
  const cols = Math.max(0, Math.floor((area.w + JOB_SPACING) / pitch));
  const rows = Math.max(0, Math.floor((area.h + JOB_SPACING) / pitch));
  return { cols, rows };
}

function gridCenter(area: Rect, radius: number, cols: number, index: number): Point {
  const pitch = 2 * radius + JOB_SPACING;
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: area.x + radius + col * pitch, y: area.y + radius + row * pitch };
}

/** 대기 구역에 한 번에 보여 줄 수 있는 작업 수 */
export function poolCapacity(layout: Layout): number {
  const { cols, rows } = gridSize(layout.poolContent, POOL_JOB_RADIUS);
  return cols * rows;
}

/** 대기 구역 index번째 작업 원의 중심 (index < poolCapacity) */
export function poolJobCenter(layout: Layout, index: number): Point {
  const { cols } = gridSize(layout.poolContent, POOL_JOB_RADIUS);
  return gridCenter(layout.poolContent, POOL_JOB_RADIUS, Math.max(1, cols), index);
}

/** 모듈 슬롯 index번째 작업 원의 중심. 용량만큼 슬롯을 가로로 고르게 나눈다. */
export function slotCenter(ml: ModuleLayout, index: number): Point {
  const perSlotW = ml.slotArea.w / Math.max(1, ml.capacity);
  return {
    x: ml.slotArea.x + perSlotW * (index + 0.5),
    y: ml.slotArea.y + ml.slotArea.h / 2,
  };
}

/** 대기열 영역에 한 줄로 보여 줄 수 있는 작업 수 */
export function queueCapacity(ml: ModuleLayout): number {
  const pitch = 2 * QUEUE_JOB_RADIUS + JOB_SPACING;
  return Math.max(0, Math.floor((ml.queueArea.w + JOB_SPACING) / pitch));
}

/** 대기열 index번째(앞이 0) 작업 원의 중심 */
export function queueJobCenter(ml: ModuleLayout, index: number): Point {
  const pitch = 2 * QUEUE_JOB_RADIUS + JOB_SPACING;
  return {
    x: ml.queueArea.x + QUEUE_JOB_RADIUS + index * pitch,
    y: ml.queueArea.y + ml.queueArea.h / 2,
  };
}

/** 두 직사각형이 겹치는가 (경계만 닿는 것은 겹침이 아니다) */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 직사각형이 화면 안에 있는가 */
export function rectInside(r: Rect, viewport: Viewport): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= viewport.width && r.y + r.h <= viewport.height;
}
