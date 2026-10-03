// RuleContext, ModuleRef, JobRef 구현. step마다 새 문맥을 만든다.
// - 모든 판정은 engine/rules.ts(또는 world.rules) 함수를 부른다. 규칙을 여기서 다시 계산하지 않는다.
// - 원본 상태는 # 비공개 필드에만 두고, 배열·집합은 복사해서 돌려준다(룰이 view를 바꿀 수 없다).
// - assignTo/unassign은 명령 버퍼에 쌓기만 한다. 같은 작업의 요청이 여러 번이면 마지막 요청만 남는다.
import { canAssign, canUnassign, estimatedWaitTime, remainingResults, usefulResults } from "../../engine/rules";
import type { Command, Job, JobId, Module, ModuleId, ResultType } from "../../engine/types";
import type { WorldView } from "../types";
import type { JobRef, ModuleRef, RuleContext } from "./types";

/** 문맥 생성에 필요한 것 (어댑터가 넘긴다) */
export interface StepContextDeps {
  view: WorldView;
  /** 실행 동안 이어지는 시드 난수 */
  random: () => number;
  /** 로그 받는 곳 */
  log: (message: string) => void;
}

class ModuleRefImpl implements ModuleRef {
  readonly #ctx: StepState;
  readonly #module: Module;

  constructor(ctx: StepState, module: Module) {
    this.#ctx = ctx;
    this.#module = module;
  }

  get id(): ModuleId {
    return this.#module.id;
  }
  get resultType(): ResultType {
    return this.#module.resultType;
  }
  get processTime(): number {
    return this.#module.processTime;
  }
  get capacity(): number {
    return this.#module.capacity;
  }

  processTimeFor(job: JobRef): number {
    const view = this.#ctx.view;
    const raw = view.jobs.get(job.id);
    return raw ? view.rules.processTime(view, raw, this.#module) : Infinity;
  }

  isIdle(): boolean {
    return this.#module.slots.length === 0 && this.#module.queue.length === 0;
  }

  freeSlots(): number {
    const view = this.#ctx.view;
    if (!view.rules.hasFreeSlot(view, this.#module)) return 0;
    return Math.max(0, this.#module.capacity - this.#module.slots.length);
  }

  queueLength(): number {
    return this.#module.queue.length;
  }

  processingJobs(): JobRef[] {
    return this.#ctx.jobRefsOf(this.#module.slots).filter((j) => j.state === "PROCESSING");
  }

  estimatedWait(job?: JobRef): number {
    return estimatedWaitTime(this.#ctx.view, this.#module.id, {
      exceptJobId: job?.id,
      extraJobIds: this.#ctx.plannedFor(this.#module.id),
    });
  }

  canAccept(job: JobRef): boolean {
    return canAssign(this.#ctx.view, job.id, this.#module.id).ok;
  }

  isUsefulFor(job: JobRef): boolean {
    return usefulResults(this.#ctx.view, job.id, this.#module.id).length > 0;
  }

  toString(): string {
    return `Module(${this.id})`;
  }
}

class JobRefImpl implements JobRef {
  readonly #ctx: StepState;
  readonly #job: Job;

  constructor(ctx: StepState, job: Job) {
    this.#ctx = ctx;
    this.#job = job;
  }

  get id(): JobId {
    return this.#job.id;
  }
  get state(): Job["state"] {
    return this.#job.state;
  }
  get createdAt(): number {
    return this.#job.createdAt;
  }

  required(): ResultType[] {
    return [...this.#job.required];
  }

  acquired(): ResultType[] {
    return [...this.#job.acquired];
  }

  remaining(): ResultType[] {
    return remainingResults(this.#ctx.view, this.#job.id);
  }

  needs(resultType: ResultType): boolean {
    return this.remaining().includes(resultType);
  }

  location(): ModuleRef | null {
    const loc = this.#job.location;
    return loc.kind === "module" ? (this.#ctx.module(loc.moduleId) ?? null) : null;
  }

  waitTime(): number {
    return this.#ctx.view.metricsState.jobWait.get(this.#job.id) ?? 0;
  }

  canUnassign(): boolean {
    return canUnassign(this.#ctx.view, this.#job.id).ok;
  }

  assignTo(module: ModuleRef): boolean {
    const check = canAssign(this.#ctx.view, this.#job.id, module.id);
    if (!check.ok) {
      this.#ctx.log(`배치 요청 거부: ${this.#job.id} → ${module.id} (${check.reason ?? "사유 없음"})`);
      return false;
    }
    this.#ctx.request({ type: "assign", jobId: this.#job.id, moduleId: module.id });
    return true;
  }

  unassign(): boolean {
    const check = canUnassign(this.#ctx.view, this.#job.id);
    if (!check.ok) {
      this.#ctx.log(`회수 요청 거부: ${this.#job.id} (${check.reason ?? "사유 없음"})`);
      return false;
    }
    this.#ctx.request({ type: "unassign", jobId: this.#job.id });
    return true;
  }

  toString(): string {
    return `Job(${this.id})`;
  }
}

/** 한 step의 내부 상태 (룰에는 노출하지 않는다). 참조 객체는 같은 step 안에서 같은 id면 같은 객체다. */
class StepState {
  readonly view: WorldView;
  readonly random: () => number;
  readonly log: (message: string) => void;
  readonly modules = new Map<ModuleId, ModuleRefImpl>();
  readonly jobs = new Map<JobId, JobRefImpl>();
  /** 작업별 마지막 요청. Map 삽입 순서 = 명령 순서 (다시 요청하면 지우고 맨 뒤에 넣는다) */
  readonly #buffer = new Map<JobId, Command>();

  constructor(deps: StepContextDeps) {
    this.view = deps.view;
    this.random = deps.random;
    this.log = deps.log;
    for (const m of deps.view.modules.values()) this.modules.set(m.id, new ModuleRefImpl(this, m));
    for (const j of deps.view.jobs.values()) this.jobs.set(j.id, new JobRefImpl(this, j));
  }

  module(id: ModuleId): ModuleRef | undefined {
    return this.modules.get(id);
  }

  /** id 목록 → 작업 참조 (없는 id는 건너뛴다) */
  jobRefsOf(ids: readonly JobId[]): JobRef[] {
    const out: JobRef[] = [];
    for (const id of ids) {
      const ref = this.jobs.get(id);
      if (ref) out.push(ref);
    }
    return out;
  }

  /** 명령 요청. 같은 작업의 이전 요청은 지운다(마지막 요청만 남는다). */
  request(cmd: Command): void {
    this.#buffer.delete(cmd.jobId);
    this.#buffer.set(cmd.jobId, cmd);
  }

  /** 이번 step에 이 모듈로 배치 요청한 작업 (요청 순서) */
  plannedFor(moduleId: ModuleId): JobId[] {
    const out: JobId[] = [];
    for (const cmd of this.#buffer.values()) {
      if (cmd.type === "assign" && cmd.moduleId === moduleId) out.push(cmd.jobId);
    }
    return out;
  }

  /** 쌓인 명령 (복사본, 요청 순서) */
  commands(): Command[] {
    return [...this.#buffer.values()].map((c) => ({ ...c }));
  }
}

/** 룰에 넘기는 문맥. 내부 상태는 # 필드에만 둔다. */
class RuleContextImpl implements RuleContext {
  readonly #s: StepState;

  constructor(state: StepState) {
    this.#s = state;
  }

  get time(): number {
    return this.#s.view.simTime;
  }

  get dt(): number {
    return this.#s.view.config.dt;
  }

  modules(): ModuleRef[] {
    return [...this.#s.modules.values()];
  }

  module(id: ModuleId): ModuleRef | undefined {
    return this.#s.module(id);
  }

  jobs(): JobRef[] {
    return [...this.#s.jobs.values()];
  }

  poolJobs(): JobRef[] {
    return this.jobs().filter((j) => j.state === "POOL");
  }

  queuedJobs(): JobRef[] {
    return this.jobs().filter((j) => j.state === "QUEUED");
  }

  processingJobs(): JobRef[] {
    return this.jobs().filter((j) => j.state === "PROCESSING");
  }

  doneJobs(): JobRef[] {
    return this.jobs().filter((j) => j.state === "DONE_AT_MODULE");
  }

  resultTypes(): ResultType[] {
    return [...new Set([...this.#s.modules.values()].map((m) => m.resultType))];
  }

  random(): number {
    return this.#s.random();
  }

  log(message: string): void {
    this.#s.log(message);
  }
}

/** 한 step의 문맥과 그 step에 쌓인 명령을 꺼내는 함수 */
export interface StepContextHandle {
  ctx: RuleContext;
  /** 쌓인 명령 (요청 순서, 작업마다 마지막 요청 하나) */
  commands(): Command[];
}

/** view로 한 step의 문맥을 만든다. */
export function createStepContext(deps: StepContextDeps): StepContextHandle {
  const state = new StepState(deps);
  return { ctx: new RuleContextImpl(state), commands: () => state.commands() };
}
