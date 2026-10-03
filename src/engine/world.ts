// 시뮬레이션 월드: 생성, 명령 적용, 한 step 진행.
// 이 파일은 상태 전이의 "순서"와 "기록"만 담당하고, 판정·계산은 모두 world.rules에 맡긴다.

import { createMetricsState, recordEvent, recordJobSpawned, updateMetrics } from "./metrics";
import { nextRandom, seedToState } from "./rng";
import { mergeRules, stepEndTime } from "./rules";
import type {
  ArrivalSpec,
  Command,
  Job,
  JobId,
  JobSpec,
  Module,
  ModuleId,
  RuleSet,
  Scenario,
  SimConfig,
  SimEvent,
  WorldState,
} from "./types";
import { DEFAULT_CONFIG } from "./types";

export { DEFAULT_CONFIG } from "./types";

/** 작업 id 접두사: "J1", "J2", ... */
const JOB_ID_PREFIX = "J";
/** 시나리오에서 capacity를 생략했을 때의 모듈 용량 (§2.4) */
const DEFAULT_CAPACITY = 1;
/** 첫 작업 번호 */
const FIRST_JOB_NUMBER = 1;

export interface CreateWorldOptions {
  /** 기본 규칙 중 교체할 규칙 */
  rules?: Partial<RuleSet>;
}

/** 시나리오 설정을 기본값과 합친다. */
function buildConfig(overrides: Partial<SimConfig> | undefined): SimConfig {
  const merged: SimConfig = { ...DEFAULT_CONFIG, ...overrides };
  return { ...merged, endCondition: { ...merged.endCondition } };
}

/** 도착 설정을 복사한다. 생략하면 도착 없음. */
function copyArrival(spec: ArrivalSpec | undefined): ArrivalSpec {
  if (!spec || spec.kind === "none") return { kind: "none" };
  return { ...spec, requiredPool: [...spec.requiredPool] };
}

/** 시나리오로 새 월드를 만든다. */
export function createWorld(scenario: Scenario, options: CreateWorldOptions = {}): WorldState {
  const modules = new Map<ModuleId, Module>();
  for (const m of scenario.modules) {
    if (modules.has(m.id)) {
      throw new Error(`시나리오에 모듈 id가 중복되었습니다: ${m.id}`);
    }
    modules.set(m.id, {
      id: m.id,
      resultType: m.resultType,
      processTime: m.processTime,
      capacity: m.capacity ?? DEFAULT_CAPACITY,
      slots: [],
      queue: [],
      busyTime: 0,
    });
  }

  const world: WorldState = {
    simTime: 0,
    modules,
    jobs: new Map(),
    completedCount: 0,
    events: [],
    config: buildConfig(scenario.config),
    rules: mergeRules(options.rules),
    arrival: copyArrival(scenario.jobs.arrival),
    rngState: seedToState(scenario.seed),
    nextJobNumber: FIRST_JOB_NUMBER,
    moves: new Map(),
    metricsState: createMetricsState(),
  };

  for (const spec of scenario.jobs.initial) {
    spawnJob(world, spec, false);
  }
  return world;
}

// ---------- 내부 도우미 ----------

function emit(world: WorldState, event: SimEvent): void {
  world.events.push(event);
  recordEvent(world, event);
}

function warn(world: WorldState, message: string): void {
  emit(world, { type: "warning", message, t: world.simTime });
}

/** 월드의 RNG 상태를 진행시키며 난수를 뽑는 함수 */
function worldRandom(world: WorldState): () => number {
  return () => {
    const draw = nextRandom(world.rngState);
    world.rngState = draw.state;
    return draw.value;
  };
}

/** 새 작업을 대기 구역에 만든다. */
function spawnJob(world: WorldState, spec: JobSpec, emitEvent: boolean): Job {
  const id: JobId = `${JOB_ID_PREFIX}${world.nextJobNumber}`;
  world.nextJobNumber++;
  const job: Job = {
    id,
    required: new Set(spec.required),
    acquired: new Set(),
    state: "POOL",
    location: { kind: "pool" },
    progress: 0,
    createdAt: world.simTime,
  };
  world.jobs.set(id, job);
  recordJobSpawned(world, job);
  if (emitEvent) emit(world, { type: "jobSpawned", jobId: id, t: world.simTime });
  return job;
}

function removeFrom(list: JobId[], jobId: JobId): void {
  const i = list.indexOf(jobId);
  if (i >= 0) list.splice(i, 1);
}

/** 작업을 현재 위치(슬롯, 대기열, 이동)에서 떼어 낸다. 처리 중이면 처리를 취소한다. */
function detach(world: WorldState, job: Job): void {
  world.moves.delete(job.id);
  if (job.location.kind === "module") {
    const module = world.modules.get(job.location.moduleId);
    if (module) {
      removeFrom(module.slots, job.id);
      removeFrom(module.queue, job.id);
    }
    if (job.state === "PROCESSING") {
      emit(world, { type: "processCancelled", jobId: job.id, moduleId: job.location.moduleId, t: world.simTime });
    }
  }
  job.progress = 0;
}

/** 작업을 모듈 슬롯에 넣고 처리를 시작한다. */
function startProcessing(world: WorldState, job: Job, module: Module): void {
  module.slots.push(job.id);
  job.state = "PROCESSING";
  job.progress = 0;
  emit(world, { type: "processStarted", jobId: job.id, moduleId: module.id, t: world.simTime });
}

/** 작업을 대기 구역으로 돌려보낸다 (이미 떼어 낸 상태여야 한다). */
function sendToPool(job: Job): void {
  job.state = "POOL";
  job.location = { kind: "pool" };
  job.progress = 0;
}

// ---------- 명령 ----------

/** 명령 하나를 적용한다. 잘못된 명령은 상태를 바꾸지 않고 warning만 남긴다. */
export function apply(world: WorldState, cmd: Command): void {
  switch (cmd.type) {
    case "assign":
      applyAssign(world, cmd.jobId, cmd.moduleId);
      return;
    case "unassign":
      applyUnassign(world, cmd.jobId);
      return;
  }
}

function applyAssign(world: WorldState, jobId: JobId, moduleId: ModuleId): void {
  const check = world.rules.canAssign(world, jobId, moduleId);
  const job = world.jobs.get(jobId);
  const module = world.modules.get(moduleId);
  if (!check.ok || !job || !module) {
    warn(world, check.reason ?? `배치할 수 없는 명령입니다: ${jobId} → ${moduleId}`);
    return;
  }
  for (const message of world.rules.assignWarnings(world, job, module)) {
    warn(world, message);
  }
  switch (world.rules.assignAction(world, job, module)) {
    case "noop":
      return;
    case "reprocess":
      // 같은 모듈 슬롯을 그대로 쓰고 처리를 처음부터 다시 한다.
      job.state = "PROCESSING";
      job.progress = 0;
      emit(world, { type: "processStarted", jobId: job.id, moduleId: module.id, t: world.simTime });
      return;
    case "move":
      break;
  }
  const from = job.location;
  detach(world, job);
  job.state = "MOVING";
  job.location = { kind: "module", moduleId };
  const total = world.rules.moveTime(world, job, moduleId);
  world.moves.set(jobId, { from, moduleId, remaining: total, total });
}

function applyUnassign(world: WorldState, jobId: JobId): void {
  const check = world.rules.canUnassign(world, jobId);
  const job = world.jobs.get(jobId);
  if (!check.ok || !job) {
    warn(world, check.reason ?? `대기 구역으로 옮길 수 없는 명령입니다: ${jobId}`);
    return;
  }
  detach(world, job);
  sendToPool(job);
}

// ---------- step 단계 (기획서 §6, 순서 고정) ----------

/** 2. 새로 도착하는 작업을 생성한다. */
function spawnArrivals(world: WorldState, dt: number): void {
  for (const spec of world.rules.arrivals(world, dt, worldRandom(world))) {
    spawnJob(world, spec, true);
  }
}

/** 3. 이동 중인 작업을 진행시키고, 도착하면 슬롯이나 대기열에 넣는다. 도착 판정은 규칙(advanceMove)에 위임한다. */
function advanceMoves(world: WorldState, dt: number): void {
  for (const [jobId, move] of [...world.moves]) {
    const result = world.rules.advanceMove(world, move, dt);
    if (!result.arrived) {
      move.remaining = result.remaining;
      continue;
    }
    world.moves.delete(jobId);
    const job = world.jobs.get(jobId);
    const module = world.modules.get(move.moduleId);
    if (!job || !module) continue;
    emit(world, { type: "jobArrived", jobId, moduleId: module.id, t: world.simTime });
    // 대기열에 먼저 온 작업이 있으면 끝에 줄 선다 (FIFO 유지).
    if (module.queue.length === 0 && world.rules.hasFreeSlot(world, module)) {
      startProcessing(world, job, module);
    } else {
      module.queue.push(jobId);
      job.state = "QUEUED";
      job.progress = 0;
    }
  }
}

/** 4. 대기열 → 빈 슬롯 */
function fillSlotsFromQueues(world: WorldState): void {
  for (const module of world.modules.values()) {
    while (world.rules.hasFreeSlot(world, module)) {
      const nextId = world.rules.selectNextFromQueue(world, module);
      if (nextId === null) break;
      const job = world.jobs.get(nextId);
      removeFrom(module.queue, nextId);
      if (job) startProcessing(world, job, module);
    }
  }
}

/** 5. 처리 진행. 모듈별로 이번 step에 처리한 작업 수를 돌려준다(7단계용). */
function advanceProcessing(world: WorldState, dt: number): Map<ModuleId, number> {
  const processed = new Map<ModuleId, number>();
  for (const module of world.modules.values()) {
    let count = 0;
    for (const jobId of module.slots) {
      const job = world.jobs.get(jobId);
      if (!job || job.state !== "PROCESSING") continue;
      count++;
      job.progress += dt;
      if (world.rules.isProcessFinished(world, job, module)) {
        for (const r of world.rules.gainedResults(world, job, module)) {
          job.acquired.add(r);
        }
        job.state = "DONE_AT_MODULE";
        emit(world, { type: "processFinished", jobId, moduleId: module.id, t: stepEndTime(world, dt) });
      }
    }
    processed.set(module.id, count);
  }
  return processed;
}

/** 6. 완료 판정. 완료된 작업은 슬롯에서 빼고 completedCount를 올린다. 미완료 작업은 규칙에 따라 대기 구역으로 돌려보낸다. */
function resolveCompletions(world: WorldState, dt: number): void {
  const t = stepEndTime(world, dt);
  for (const module of world.modules.values()) {
    for (const jobId of [...module.slots]) {
      const job = world.jobs.get(jobId);
      if (!job || job.state !== "DONE_AT_MODULE") continue;
      if (world.rules.isJobComplete(world, job)) {
        removeFrom(module.slots, jobId);
        job.state = "COMPLETED";
        job.completedAt = t;
        job.progress = 0;
        world.completedCount++;
        emit(world, { type: "jobCompleted", jobId, moduleId: module.id, t });
      } else if (world.rules.releaseWhenDone(world, job, module)) {
        // 자동 복귀: 슬롯을 비우고 대기 구역으로. 비운 슬롯은 다음 step 4단계에서 대기열이 채운다.
        removeFrom(module.slots, jobId);
        sendToPool(job);
        emit(world, { type: "jobReturned", jobId, moduleId: module.id, t });
      }
    }
  }
}

/** 한 step 진행한다. world를 제자리에서 바꾼다. */
export function step(world: WorldState, commands: Command[], dt: number = world.config.dt): void {
  world.events = [];
  // 1. 명령 적용
  for (const cmd of commands) apply(world, cmd);
  // 2. 작업 도착
  spawnArrivals(world, dt);
  // 3. 이동
  advanceMoves(world, dt);
  // 4. 대기열 → 빈 슬롯 (FIFO)
  fillSlotsFromQueues(world);
  // 5. 처리 진행
  const processed = advanceProcessing(world, dt);
  // 6. 완료 판정
  resolveCompletions(world, dt);
  // 7. 지표 갱신 (가동 시간, 점유 낭비, 대기 시간: metrics.ts)
  updateMetrics(world, processed, dt);
  // 8. 시간 진행 (완료 시각과 같은 계산을 쓴다)
  world.simTime = stepEndTime(world, dt);
}

/** 종료 조건에 도달했는가 (판정은 규칙에 위임) */
export function isEnded(world: WorldState): boolean {
  return world.rules.isEnded(world);
}
