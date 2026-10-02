// 지표 누적과 계산 (기획서 §8). world.ts는 이 파일의 기록 함수를 호출만 한다.
// 무엇이 "대기"/"점유 낭비"/"헛된 처리"인지는 rules.ts의 판정 함수가 정한다.

import { isDoneOccupying, isWastedProcess, waitKind } from "./rules";
import type { Job, Metrics, MetricsState, ModuleId, ModuleMetrics, SimEvent, WorldState } from "./types";

/** 빈 지표 누적값 */
export function createMetricsState(): MetricsState {
  return {
    spawnedCount: 0,
    completedTracked: 0,
    leadTimeSum: 0,
    completedWaitSum: 0,
    poolWaitTime: 0,
    queueWaitTime: 0,
    jobWait: new Map(),
    uselessProcessCount: 0,
    cancelledProcessCount: 0,
    pendingUseful: new Map(),
    doneOccupiedTime: new Map(),
  };
}

// ---------- 사건 기록 (사건이 생길 때 world.ts가 부른다) ----------

/** 작업이 생성되었다 (초기 작업 포함) */
export function recordJobSpawned(world: WorldState, job: Job): void {
  const acc = world.metricsState;
  acc.spawnedCount++;
  acc.jobWait.set(job.id, 0);
}

/**
 * 이벤트를 지표에 반영한다. world.ts의 emit이 모든 이벤트마다 부른다.
 * - processStarted: 이 처리가 헛된지 시작 시점에 판정해 둔다(처리가 끝나면 acquired가 바뀌므로).
 * - processFinished: 헛된 처리였으면 센다.
 * - processCancelled: 취소된 처리를 센다.
 * - jobCompleted: 소요 시간과 대기 시간을 완료 작업 합계에 넣는다.
 */
export function recordEvent(world: WorldState, event: SimEvent): void {
  const acc = world.metricsState;
  switch (event.type) {
    case "processStarted":
      if (event.moduleId !== undefined) {
        acc.pendingUseful.set(event.jobId, !isWastedProcess(world, event.jobId, event.moduleId));
      }
      return;
    case "processFinished":
      if (acc.pendingUseful.get(event.jobId) === false) acc.uselessProcessCount++;
      acc.pendingUseful.delete(event.jobId);
      return;
    case "processCancelled":
      acc.cancelledProcessCount++;
      acc.pendingUseful.delete(event.jobId);
      return;
    case "jobCompleted": {
      const job = world.jobs.get(event.jobId);
      if (!job) return;
      acc.completedTracked++;
      acc.leadTimeSum += (job.completedAt ?? event.t) - job.createdAt;
      acc.completedWaitSum += acc.jobWait.get(job.id) ?? 0;
      acc.jobWait.delete(job.id);
      return;
    }
    default:
      return;
  }
}

// ---------- step 7단계: 시간 누적 ----------

/** 이번 step에 처리가 끝난 작업 (그 step 구간은 처리 중이었으므로 점유 낭비로 세지 않는다) */
function finishedThisStep(world: WorldState): Set<string> {
  const ids = new Set<string>();
  for (const e of world.events) {
    if (e.type === "processFinished") ids.add(e.jobId);
  }
  return ids;
}

/**
 * step 7단계: 지표를 갱신한다 (기획서 §6).
 * step 1~6이 끝난 상태를 이번 구간 [simTime, simTime + dt]의 상태로 보고 dt씩 더한다.
 * - 모듈 busyTime += rules.busyTimeDelta (5단계에서 처리 중이던 슬롯 수 기준)
 * - 점유 낭비: 이번 step 전부터 DONE_AT_MODULE로 슬롯을 점유한 작업 수 × dt
 * - 대기: POOL 작업은 대기 구역, QUEUED 작업은 대기열 체류로 dt (이번 step에 처리가 끝난 작업은 제외)
 */
export function updateMetrics(world: WorldState, processed: ReadonlyMap<ModuleId, number>, dt: number): void {
  const acc = world.metricsState;
  const justFinished = finishedThisStep(world);

  for (const module of world.modules.values()) {
    module.busyTime += world.rules.busyTimeDelta(world, module, processed.get(module.id) ?? 0, dt);
    let occupied = 0;
    for (const jobId of module.slots) {
      const job = world.jobs.get(jobId);
      if (job && isDoneOccupying(job) && !justFinished.has(jobId)) occupied++;
    }
    if (occupied > 0) {
      acc.doneOccupiedTime.set(module.id, (acc.doneOccupiedTime.get(module.id) ?? 0) + occupied * dt);
    }
  }

  for (const job of world.jobs.values()) {
    // 이번 step에 처리가 끝나 대기 구역으로 돌아간 작업은 이 구간 동안 처리 중이었다.
    if (justFinished.has(job.id)) continue;
    const kind = waitKind(job);
    if (kind === null) continue;
    if (kind === "pool") acc.poolWaitTime += dt;
    else acc.queueWaitTime += dt;
    acc.jobWait.set(job.id, (acc.jobWait.get(job.id) ?? 0) + dt);
  }
}

// ---------- 지표 계산 (순수 함수) ----------

/** a / b. b가 0 이하면 0 */
function ratio(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

/** 현재 지표를 계산한다. world를 바꾸지 않는다. */
export function computeMetrics(world: Readonly<WorldState>): Metrics {
  const acc = world.metricsState;
  const modules: ModuleMetrics[] = [];
  for (const module of world.modules.values()) {
    modules.push({
      id: module.id,
      utilization: ratio(module.busyTime, world.simTime * module.capacity),
      busyTime: module.busyTime,
      doneOccupiedTime: acc.doneOccupiedTime.get(module.id) ?? 0,
      queueLength: module.queue.length,
    });
  }
  const completed = acc.completedTracked;
  return {
    simTime: world.simTime,
    completedCount: world.completedCount,
    spawnedCount: acc.spawnedCount,
    throughput: ratio(world.completedCount, world.simTime),
    avgLeadTime: completed > 0 ? acc.leadTimeSum / completed : null,
    avgWaitTime: completed > 0 ? acc.completedWaitSum / completed : null,
    poolWaitTime: acc.poolWaitTime,
    queueWaitTime: acc.queueWaitTime,
    wastedProcessCount: acc.uselessProcessCount + acc.cancelledProcessCount,
    uselessProcessCount: acc.uselessProcessCount,
    cancelledProcessCount: acc.cancelledProcessCount,
    modules,
  };
}
