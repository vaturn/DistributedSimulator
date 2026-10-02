// 작업 원이 화면 어디에 그려지는지 정한다 (대기 구역, 모듈 슬롯, 대기열, 이동 중).
// 렌더러(그리기)와 입력(히트 판정)이 같은 함수를 써서 위치 계산이 한 곳에만 있게 한다.
// 순수 함수만 둔다(DOM·Canvas 금지). 엔진 상태는 읽기만 한다.

import { moveProgressRatio } from "../engine/rules";
import type { JobId, JobLocation, Module, WorldState } from "../engine/types";
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
import { POOL_JOB_RADIUS, QUEUE_JOB_RADIUS, QUEUE_LABEL_RESERVED_SLOTS } from "./theme";

/** 작업 원이 놓인 자리의 종류 */
export type PlacementKind = "pool" | "slot" | "queue" | "moving";

/** 화면에 그려지는 작업 원 하나 */
export interface JobPlacement {
  jobId: JobId;
  kind: PlacementKind;
  center: Point;
  radius: number;
  /** slot/queue/moving이면 해당 모듈 */
  moduleId?: string;
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** 대기 구역에 그려지는 작업들 (보여 줄 수 있는 수까지). 순서는 world.jobs 순서 */
export function poolPlacements(world: Readonly<WorldState>, layout: Layout): JobPlacement[] {
  const capacity = poolCapacity(layout);
  const result: JobPlacement[] = [];
  for (const job of world.jobs.values()) {
    if (job.state !== "POOL") continue;
    if (result.length >= capacity) break;
    result.push({ jobId: job.id, kind: "pool", center: poolJobCenter(layout, result.length), radius: POOL_JOB_RADIUS });
  }
  return result;
}

/** 대기 구역에 있는 작업 수 (숨겨진 것 포함) */
export function poolJobCount(world: Readonly<WorldState>): number {
  let n = 0;
  for (const job of world.jobs.values()) if (job.state === "POOL") n++;
  return n;
}

/** 모듈 슬롯에 그려지는 작업들 (빈 슬롯은 빠진다) */
export function slotPlacements(world: Readonly<WorldState>, module: Module, ml: ModuleLayout): JobPlacement[] {
  const result: JobPlacement[] = [];
  for (let i = 0; i < module.capacity; i++) {
    const jobId = module.slots[i];
    if (jobId === undefined || !world.jobs.has(jobId)) continue;
    result.push({ jobId, kind: "slot", center: slotCenter(ml, i), radius: ml.jobRadius, moduleId: module.id });
  }
  return result;
}

/** 대기열에 한 줄로 보여 줄 작업 수 ("대기 N" 글자 자리를 남긴다) */
export function visibleQueueCount(ml: ModuleLayout): number {
  return Math.max(0, queueCapacity(ml) - QUEUE_LABEL_RESERVED_SLOTS);
}

/** 모듈 대기열에 그려지는 작업들 (보여 줄 수 있는 수까지) */
export function queuePlacements(world: Readonly<WorldState>, module: Module, ml: ModuleLayout): JobPlacement[] {
  const result: JobPlacement[] = [];
  module.queue.slice(0, visibleQueueCount(ml)).forEach((jobId, i) => {
    if (!world.jobs.has(jobId)) return;
    result.push({ jobId, kind: "queue", center: queueJobCenter(ml, i), radius: QUEUE_JOB_RADIUS, moduleId: module.id });
  });
  return result;
}

/** 위치(대기 구역 또는 모듈)의 대표 좌표. 이동 애니메이션의 출발점으로 쓴다. */
function locationPoint(layout: Layout, location: JobLocation): Point {
  if (location.kind === "pool") return rectCenter(layout.poolContent);
  const ml = layout.modules.find((m) => m.id === location.moduleId);
  return ml ? rectCenter(ml.box) : rectCenter(layout.poolContent);
}

/** 이동 중인 작업: 출발점과 목적지 대기열 입구 사이를 이동 진행률로 보간한다. */
export function movingPlacements(world: Readonly<WorldState>, layout: Layout): JobPlacement[] {
  const result: JobPlacement[] = [];
  for (const [jobId, move] of world.moves) {
    const module = world.modules.get(move.moduleId);
    const ml = layout.modules.find((m) => m.id === move.moduleId);
    if (!world.jobs.has(jobId) || !module || !ml) continue;
    const t = moveProgressRatio(world, jobId);
    const from = locationPoint(layout, move.from);
    const to = queueJobCenter(ml, module.queue.length);
    const center: Point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    result.push({ jobId, kind: "moving", center, radius: POOL_JOB_RADIUS, moduleId: move.moduleId });
  }
  return result;
}

/** 화면에 그려지는 모든 작업 원 (그리는 순서: 대기 구역 → 모듈별 슬롯·대기열 → 이동 중) */
export function allPlacements(world: Readonly<WorldState>, layout: Layout): JobPlacement[] {
  const result = poolPlacements(world, layout);
  for (const ml of layout.modules) {
    const module = world.modules.get(ml.id);
    if (!module) continue;
    result.push(...slotPlacements(world, module, ml), ...queuePlacements(world, module, ml));
  }
  result.push(...movingPlacements(world, layout));
  return result;
}
