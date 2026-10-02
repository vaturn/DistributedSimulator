// 시뮬레이션 규칙의 기본 구현. 규칙은 이 파일에만 둔다(AGENTS.md "시뮬레이션 규칙 추상화").
// world.ts, 렌더러, UI, 감독관은 규칙을 직접 계산하지 않고 world.rules 또는 이 파일의 함수를 부른다.

import type {
  Job,
  JobId,
  JobSpec,
  Module,
  ModuleId,
  MoveInfo,
  ResultType,
  RuleCheck,
  RuleSet,
  WorldState,
} from "./types";

export type { RuleSet, RuleCheck } from "./types";

/** 부동소수점 비교 허용 오차 (시간 비교용) */
export const EPSILON = 1e-9;

// ---------- 처리 ----------

/** 처리 시간: 모듈의 고정 처리 시간 (§9 기본값: 무작위성 없음) */
function processTime(_world: WorldState, _job: Job, module: Module): number {
  return module.processTime;
}

/** progress >= processTime - EPSILON 이면 처리 완료 */
function isProcessFinished(world: WorldState, job: Job, module: Module): boolean {
  return job.progress >= world.rules.processTime(world, job, module) - EPSILON;
}

/** 처리가 끝나면 모듈의 결과 하나를 얻는다. */
function gainedResults(_world: WorldState, _job: Job, module: Module): ResultType[] {
  return [module.resultType];
}

/** required ⊆ acquired 이면 완료 (§2.2-4, 결과 순서 제약 없음) */
function isJobComplete(_world: WorldState, job: Job): boolean {
  for (const r of job.required) {
    if (!job.acquired.has(r)) return false;
  }
  return true;
}

/** occupyWhenDone=false 이면 처리 끝난 작업은 자동으로 대기 구역에 돌아간다. */
function releaseWhenDone(world: WorldState, _job: Job, _module: Module): boolean {
  return !world.config.occupyWhenDone;
}

// ---------- 배치 ----------

/** 처리 중 이동 시 취소하는가 (cancelOnMove=false면 이동 자체가 금지된다) */
function cancelsOnMove(world: WorldState, _job: Job): boolean {
  return world.config.cancelOnMove;
}

/** 모듈로 향하는(이동 중인) 작업 수. exceptJobId는 세지 않는다. */
function incomingCount(world: WorldState, moduleId: ModuleId, exceptJobId: JobId): number {
  let count = 0;
  for (const [jobId, move] of world.moves) {
    if (jobId !== exceptJobId && move.moduleId === moduleId) count++;
  }
  return count;
}

/** 처리 중 작업을 옮기는 것이 허용되는가 */
function checkMovable(world: WorldState, job: Job): RuleCheck {
  if (job.state === "PROCESSING" && !world.rules.cancelsOnMove(world, job)) {
    return { ok: false, reason: `작업 ${job.id}은(는) 처리 중이라 옮길 수 없습니다.` };
  }
  return { ok: true };
}

function defaultCanAssign(world: WorldState, jobId: JobId, moduleId: ModuleId): RuleCheck {
  const job = world.jobs.get(jobId);
  if (!job) return { ok: false, reason: `존재하지 않는 작업입니다: ${jobId}` };
  const module = world.modules.get(moduleId);
  if (!module) return { ok: false, reason: `존재하지 않는 모듈입니다: ${moduleId}` };
  if (job.state === "COMPLETED") {
    return { ok: false, reason: `이미 완료된 작업입니다: ${jobId}` };
  }
  if (job.location.kind === "module" && job.location.moduleId === moduleId) {
    return { ok: false, reason: `작업 ${jobId}은(는) 이미 모듈 ${moduleId}에 있습니다.` };
  }
  const movable = checkMovable(world, job);
  if (!movable.ok) return movable;
  const limit = world.config.queueLimit;
  if (limit !== null) {
    const occupied = module.slots.length + module.queue.length + incomingCount(world, moduleId, jobId);
    if (occupied >= module.capacity + limit) {
      return { ok: false, reason: `모듈 ${moduleId}의 대기열이 가득 찼습니다.` };
    }
  }
  return { ok: true };
}

function defaultCanUnassign(world: WorldState, jobId: JobId): RuleCheck {
  const job = world.jobs.get(jobId);
  if (!job) return { ok: false, reason: `존재하지 않는 작업입니다: ${jobId}` };
  if (job.state === "COMPLETED") {
    return { ok: false, reason: `이미 완료된 작업입니다: ${jobId}` };
  }
  if (job.location.kind === "pool") {
    return { ok: false, reason: `작업 ${jobId}은(는) 이미 대기 구역에 있습니다.` };
  }
  return checkMovable(world, job);
}

/** 허용은 하지만 경고할 배치: 필요 없는 결과, 이미 얻은 결과 (§2.4) */
function assignWarnings(_world: WorldState, job: Job, module: Module): string[] {
  const r = module.resultType;
  if (job.acquired.has(r)) {
    return [`작업 ${job.id}은(는) 이미 결과 ${r}을(를) 가지고 있습니다 (모듈 ${module.id}).`];
  }
  if (!job.required.has(r)) {
    return [`작업 ${job.id}에는 결과 ${r}이(가) 필요 없습니다 (모듈 ${module.id}).`];
  }
  return [];
}

// ---------- 이동과 대기열 ----------

/** 이동 시간: 설정의 고정값 (§9 기본값 0) */
function moveTime(world: WorldState, _job: Job, _moduleId: ModuleId): number {
  return world.config.moveTime;
}

function isMoveFinished(_world: WorldState, move: MoveInfo): boolean {
  return move.remaining <= EPSILON;
}

function hasFreeSlot(_world: WorldState, module: Module): boolean {
  return module.slots.length < module.capacity;
}

/** 대기열 선택: FIFO */
function selectNextFromQueue(_world: WorldState, module: Module): JobId | null {
  return module.queue.length > 0 ? module.queue[0] : null;
}

// ---------- 작업 도착 ----------

/** 포아송 분포 표본 (Knuth 방법). mean = rate * dt */
function samplePoisson(mean: number, random: () => number): number {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let k = 0;
  let p = random();
  while (p > limit) {
    k++;
    p *= random();
  }
  return k;
}

/** 결과 풀에서 min~max개를 중복 없이 고른다. 결과 순서는 풀 순서를 따른다. */
function sampleRequired(
  pool: ResultType[],
  minReq: number,
  maxReq: number,
  random: () => number,
): ResultType[] {
  const unique = [...new Set(pool)];
  const lo = Math.max(0, Math.min(minReq, unique.length));
  const hi = Math.max(lo, Math.min(maxReq, unique.length));
  const count = lo + Math.floor(random() * (hi - lo + 1));
  // 부분 Fisher-Yates로 인덱스를 고른다.
  const indices = unique.map((_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (indices.length - i));
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
  }
  return indices
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((i) => unique[i]);
}

function arrivals(world: WorldState, dt: number, random: () => number): JobSpec[] {
  const spec = world.arrival;
  if (spec.kind !== "poisson") return [];
  const n = samplePoisson(spec.rate * dt, random);
  const result: JobSpec[] = [];
  for (let i = 0; i < n; i++) {
    result.push({ required: sampleRequired(spec.requiredPool, spec.minReq, spec.maxReq, random) });
  }
  return result;
}

// ---------- 지표와 종료 ----------

/** 이번 step에 처리 중인 작업이 하나라도 있었으면 dt만큼 가동한 것으로 센다. */
function busyTimeDelta(_world: WorldState, _module: Module, processedCount: number, dt: number): number {
  return processedCount > 0 ? dt : 0;
}

function isEnded(world: WorldState): boolean {
  const end = world.config.endCondition;
  switch (end.kind) {
    case "time":
      return world.simTime >= end.value - EPSILON;
    case "completed":
      return world.completedCount >= end.value;
    case "allDone": {
      for (const job of world.jobs.values()) {
        if (job.state !== "COMPLETED") return false;
      }
      return true;
    }
  }
}

/** 기본 규칙 구현 (기획서 §2, §9 기본값) */
export const defaultRules: RuleSet = Object.freeze({
  processTime,
  isProcessFinished,
  gainedResults,
  isJobComplete,
  releaseWhenDone,
  canAssign: defaultCanAssign,
  canUnassign: defaultCanUnassign,
  assignWarnings,
  cancelsOnMove,
  moveTime,
  isMoveFinished,
  hasFreeSlot,
  selectNextFromQueue,
  arrivals,
  busyTimeDelta,
  isEnded,
});

/** 기본 규칙에 일부 규칙을 덮어쓴 규칙 묶음을 만든다. */
export function mergeRules(overrides?: Partial<RuleSet>): RuleSet {
  return { ...defaultRules, ...overrides };
}

// ---------- UI·정책 공용 진입점 (world에 설정된 규칙을 따른다) ----------

/** 이 작업을 이 모듈에 배치할 수 있는가 */
export function canAssign(world: WorldState, jobId: JobId, moduleId: ModuleId): RuleCheck {
  return world.rules.canAssign(world, jobId, moduleId);
}

/** 이 작업을 대기 구역으로 돌려보낼 수 있는가 */
export function canUnassign(world: WorldState, jobId: JobId): RuleCheck {
  return world.rules.canUnassign(world, jobId);
}
