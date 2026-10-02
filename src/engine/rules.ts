// 시뮬레이션 규칙의 기본 구현. 규칙은 이 파일에만 둔다(AGENTS.md "시뮬레이션 규칙 추상화").
// world.ts, 렌더러, UI, 감독관은 규칙을 직접 계산하지 않고 world.rules 또는 이 파일의 함수를 부른다.

import type {
  AssignAction,
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

// ---------- 시각 ----------

/**
 * step이 끝난 뒤의 시각. step 하나는 구간 [simTime, simTime + dt]를 진행한다.
 * 진행이 끝나서 생기는 사건(processFinished, jobCompleted, completedAt)은 이 시각으로 기록한다.
 * step 시작 시점의 사건(명령, 도착, 처리 시작, 취소, 경고)은 simTime으로 기록한다.
 * step 8단계의 simTime 갱신도 이 함수를 써서 완료 시각과 다음 simTime이 정확히 같게 한다.
 */
export function stepEndTime(world: WorldState, dt: number): number {
  return world.simTime + dt;
}

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

/**
 * 배치 명령이 할 일. 같은 모듈에 다시 배치하면 DONE_AT_MODULE 작업은 다시 처리하고,
 * 이동 중·대기 중·처리 중 작업은 바뀔 것이 없다.
 */
function assignAction(_world: WorldState, job: Job, module: Module): AssignAction {
  if (job.location.kind !== "module" || job.location.moduleId !== module.id) return "move";
  return job.state === "DONE_AT_MODULE" ? "reprocess" : "noop";
}

/**
 * 배치 판단은 감독관 책임이다. 엔진은 명령을 수행할 수 없는 경우만 거부한다:
 * 없는 작업/모듈, 완료된 작업, (cancelOnMove=false일 때) 처리 중 작업을 다른 곳으로 옮기기.
 * 대기열 상한 초과, 같은 모듈 재배치 등은 허용하고 assignWarnings로 경고한다.
 */
function defaultCanAssign(world: WorldState, jobId: JobId, moduleId: ModuleId): RuleCheck {
  const job = world.jobs.get(jobId);
  if (!job) return { ok: false, reason: `존재하지 않는 작업입니다: ${jobId}` };
  const module = world.modules.get(moduleId);
  if (!module) return { ok: false, reason: `존재하지 않는 모듈입니다: ${moduleId}` };
  if (job.state === "COMPLETED") {
    return { ok: false, reason: `이미 완료된 작업입니다: ${jobId}` };
  }
  if (world.rules.assignAction(world, job, module) === "move") {
    return checkMovable(world, job);
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

/** 대기열 상한(queueLimit)을 넘는 배치인가. 이동 중인 작업도 자리를 차지한 것으로 센다. */
function exceedsQueueLimit(world: WorldState, job: Job, module: Module): boolean {
  const limit = world.config.queueLimit;
  if (limit === null) return false;
  const occupied = module.slots.length + module.queue.length + incomingCount(world, module.id, job.id);
  return occupied >= module.capacity + limit;
}

/**
 * 허용은 하지만 경고할 배치 (§2.4): 무의미한 명령, 이미 얻은 결과, 필요 없는 결과, 대기열 상한 초과.
 */
function assignWarnings(world: WorldState, job: Job, module: Module): string[] {
  const action = world.rules.assignAction(world, job, module);
  if (action === "noop") {
    return [`작업 ${job.id}은(는) 이미 모듈 ${module.id}에 있어 바뀌는 것이 없습니다.`];
  }
  const warnings: string[] = [];
  const r = module.resultType;
  if (job.acquired.has(r)) {
    warnings.push(`작업 ${job.id}은(는) 이미 결과 ${r}을(를) 가지고 있습니다 (모듈 ${module.id}).`);
  } else if (!job.required.has(r)) {
    warnings.push(`작업 ${job.id}에는 결과 ${r}이(가) 필요 없습니다 (모듈 ${module.id}).`);
  }
  if (action === "move" && exceedsQueueLimit(world, job, module)) {
    warnings.push(`모듈 ${module.id}의 대기열 상한(${world.config.queueLimit})을 넘었습니다.`);
  }
  return warnings;
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

/**
 * 슬롯 단위 가동 시간: 이번 step에 처리 중이던 슬롯 수 × dt.
 * 용량 N 모듈은 슬롯 N개가 독립적으로 처리하므로, 가동률 = busyTime / (simTime × capacity) (§8).
 */
function busyTimeDelta(_world: WorldState, _module: Module, processedCount: number, dt: number): number {
  return processedCount * dt;
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
  assignAction,
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

// ---------- 조회 함수 (감독관·렌더러 공용, 순수 함수: world를 바꾸지 않는다) ----------

/** 작업에 아직 필요한 결과 (required - acquired). 순서는 required 순서. 없는 작업이면 빈 배열 */
export function remainingResults(world: Readonly<WorldState>, jobId: JobId): ResultType[] {
  const job = world.jobs.get(jobId);
  if (!job) return [];
  return [...job.required].filter((r) => !job.acquired.has(r));
}

/**
 * 작업이 이 모듈에서 처리되면 새로 얻는 "필요한" 결과 (gainedResults ∩ 남은 필요 결과).
 * 빈 배열이면 이 모듈에 배치하는 것은 시간 낭비다. 없는 작업·모듈이면 빈 배열.
 */
export function usefulResults(world: Readonly<WorldState>, jobId: JobId, moduleId: ModuleId): ResultType[] {
  const job = world.jobs.get(jobId);
  const module = world.modules.get(moduleId);
  if (!job || !module) return [];
  const remaining = new Set(remainingResults(world, jobId));
  const gained = world.rules.gainedResults(world, job, module);
  return [...new Set(gained)].filter((r) => remaining.has(r));
}

// ---------- 지표용 판정 (metrics.ts가 부른다, 기획서 §8) ----------

/** 대기 종류: 대기 구역 체류("pool") 또는 모듈 대기열 체류("queue") */
export type WaitKind = "pool" | "queue";

/** 작업이 지금 기다리는 중인가. POOL이면 "pool", QUEUED이면 "queue", 그 밖(이동, 처리, 점유, 완료)은 null */
export function waitKind(job: Readonly<Job>): WaitKind | null {
  switch (job.state) {
    case "POOL":
      return "pool";
    case "QUEUED":
      return "queue";
    default:
      return null;
  }
}

/** 처리가 끝난 작업이 모듈 슬롯을 점유하고 있는가 (점유 낭비, §8) */
export function isDoneOccupying(job: Readonly<Job>): boolean {
  return job.state === "DONE_AT_MODULE" && job.location.kind === "module";
}

/**
 * 지금 이 작업을 이 모듈에서 처리하면 헛된 처리인가 (§8 "헛된 처리"):
 * 처리해도 필요한 결과를 새로 얻지 못한다(필요 없는 결과이거나 이미 가진 결과).
 * 처리를 시작하는 시점에 판정한다. 처리 중에는 acquired가 바뀌지 않으므로 끝났을 때와 같다.
 */
export function isWastedProcess(world: Readonly<WorldState>, jobId: JobId, moduleId: ModuleId): boolean {
  return usefulResults(world, jobId, moduleId).length === 0;
}

/** 작업이 이 모듈에서 처리를 마칠 때까지 남은 처리 시간 (현재 progress 반영, 0 이상) */
export function remainingProcessTime(world: Readonly<WorldState>, jobId: JobId, moduleId: ModuleId): number {
  const job = world.jobs.get(jobId);
  const module = world.modules.get(moduleId);
  if (!job || !module) return 0;
  const total = world.rules.processTime(world, job, module);
  const elapsed = job.state === "PROCESSING" ? job.progress : 0;
  return Math.max(0, total - elapsed);
}

/** 0~1로 자른다. */
function clampRatio(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * 작업의 처리 진행률 (0~1). 처리 시간은 world.rules.processTime을 쓴다.
 * PROCESSING이면 progress / 처리 시간(처리 시간이 0 이하면 1), DONE_AT_MODULE이면 1, 그 밖의 상태나 없는 작업이면 0.
 */
export function processProgressRatio(world: Readonly<WorldState>, jobId: JobId): number {
  const job = world.jobs.get(jobId);
  if (!job || job.location.kind !== "module") return 0;
  if (job.state === "DONE_AT_MODULE") return 1;
  if (job.state !== "PROCESSING") return 0;
  const module = world.modules.get(job.location.moduleId);
  if (!module) return 0;
  const total = world.rules.processTime(world, job, module);
  if (total <= 0) return 1;
  return clampRatio(job.progress / total);
}

/**
 * 이동 중인 작업의 이동 진행률 (0~1). 전체 이동 시간은 이동을 시작할 때 world.rules.moveTime이 정한 값(MoveInfo.total)이다.
 * 전체 이동 시간이 0 이하면 1, 이동 중이 아니거나 없는 작업이면 0.
 */
export function moveProgressRatio(world: Readonly<WorldState>, jobId: JobId): number {
  const move = world.moves.get(jobId);
  if (!move) return 0;
  if (move.total <= 0) return 1;
  return clampRatio(1 - move.remaining / move.total);
}

export interface WaitEstimateOptions {
  /** 계산에서 뺄 작업 (보통 배치하려는 작업 자신) */
  exceptJobId?: JobId;
  /** 이미 있는 대기열·이동 작업 뒤에 추가로 줄 설 작업 (같은 step에 계획한 배치) */
  extraJobIds?: readonly JobId[];
  /**
   * DONE_AT_MODULE 슬롯을 지금 비울 수 있는 슬롯으로 볼 것인가 (기본 true).
   * 감독관이 옮겨야 비는 슬롯이므로, 정책 판단에서는 비울 수 있다고 보고, 표시용으로는 false를 줄 수 있다.
   * false이면 그 슬롯은 계산에서 영원히 차 있는 것으로 본다.
   */
  doneSlotsFree?: boolean;
}

/**
 * 지금 이 모듈에 새 작업을 넣으면 처리를 시작하기까지의 예상 대기 시간.
 * 용량 N 모듈은 슬롯 N개가 독립적으로 처리한다고 보고(§2.4), 슬롯별로 비는 시각을 계산한 뒤
 * 대기열(FIFO) → 이동 중 작업(이동 시작 순서) → extraJobIds 순서로 가장 빨리 비는 슬롯에 넣는다.
 * 처리 시간은 world.rules.processTime을 쓴다. 모든 슬롯이 무기한 차 있으면 Infinity.
 * 없는 모듈이면 Infinity.
 */
export function estimatedWaitTime(
  world: Readonly<WorldState>,
  moduleId: ModuleId,
  options: WaitEstimateOptions = {},
): number {
  const module = world.modules.get(moduleId);
  if (!module) return Infinity;
  const { exceptJobId, extraJobIds = [], doneSlotsFree = true } = options;

  // 슬롯별로 비는 시각
  const slotFree: number[] = [];
  for (const jobId of module.slots) {
    if (jobId === exceptJobId) continue;
    const job = world.jobs.get(jobId);
    if (!job) continue;
    if (job.state === "PROCESSING") {
      slotFree.push(remainingProcessTime(world, jobId, moduleId));
    } else {
      slotFree.push(doneSlotsFree ? 0 : Infinity);
    }
  }
  while (slotFree.length < module.capacity) slotFree.push(0);
  if (slotFree.length === 0) return Infinity;

  // 슬롯을 기다리는 작업: [작업, 슬롯에 들어갈 수 있는 가장 이른 시각]
  const waiting: [Job, number][] = [];
  for (const jobId of module.queue) {
    const job = world.jobs.get(jobId);
    if (job && jobId !== exceptJobId) waiting.push([job, 0]);
  }
  for (const [jobId, move] of world.moves) {
    const job = world.jobs.get(jobId);
    if (job && jobId !== exceptJobId && move.moduleId === moduleId) {
      waiting.push([job, Math.max(0, move.remaining)]);
    }
  }
  for (const jobId of extraJobIds) {
    const job = world.jobs.get(jobId);
    if (job && jobId !== exceptJobId) {
      waiting.push([job, world.rules.moveTime(world, job, moduleId)]);
    }
  }

  for (const [job, readyAt] of waiting) {
    const i = earliestIndex(slotFree);
    if (slotFree[i] === Infinity) return Infinity;
    slotFree[i] = Math.max(slotFree[i], readyAt) + world.rules.processTime(world, job, module);
  }
  return slotFree[earliestIndex(slotFree)];
}

/** 가장 작은 값의 인덱스 (동점이면 앞쪽). 빈 배열이면 0 */
function earliestIndex(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[best]) best = i;
  }
  return best;
}

/** 드래그 중 대상 모듈 강조용 배치 힌트 */
export interface AssignHint {
  /** 엔진이 이 배치 명령을 받아들이는가 (canAssign) */
  ok: boolean;
  /** 배치하면 아직 필요한 결과를 새로 얻는가 (상태가 바뀌지 않는 배치면 false) */
  useful: boolean;
  /** 허용되지만 apply 때 warning 이벤트로 남을 메시지 (assignWarnings와 같은 출처) */
  warnings: string[];
  /** ok=false일 때 거부 이유 */
  reason?: string;
}

/**
 * 이 작업을 이 모듈에 배치하면 어떻게 되는지 알려 준다. world를 바꾸지 않는다.
 * 판정은 world.rules의 canAssign, assignAction, assignWarnings와 usefulResults를 그대로 쓴다.
 */
export function assignHint(world: Readonly<WorldState>, jobId: JobId, moduleId: ModuleId): AssignHint {
  const check = world.rules.canAssign(world, jobId, moduleId);
  const job = world.jobs.get(jobId);
  const module = world.modules.get(moduleId);
  if (!check.ok || !job || !module) {
    return { ok: false, useful: false, warnings: [], reason: check.reason };
  }
  const changes = world.rules.assignAction(world, job, module) !== "noop";
  return {
    ok: true,
    useful: changes && usefulResults(world, jobId, moduleId).length > 0,
    warnings: world.rules.assignWarnings(world, job, module),
  };
}
