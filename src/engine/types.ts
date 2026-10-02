// 엔진 공용 타입. 기획서 §5의 데이터 모델을 그대로 따른다.
// 이 파일은 타입과 설정 기본값(DEFAULT_CONFIG)만 둔다. 규칙 로직은 rules.ts에 있다.

export type ResultType = string;
export type ModuleId = string;
export type JobId = string;

export interface Module {
  id: ModuleId;
  /** 이 모듈이 주는 결과 */
  resultType: ResultType;
  /** 시뮬레이션 시간 단위(초) */
  processTime: number;
  /** 동시에 처리할 수 있는 작업 수 (기본값 1) */
  capacity: number;
  /** 처리 중이거나 DONE_AT_MODULE인 작업 */
  slots: JobId[];
  /** 대기열 (앞이 먼저 들어온 작업) */
  queue: JobId[];
  /** 슬롯 단위 누적 가동 시간 (처리 중 슬롯 수 × dt의 합). 가동률 = busyTime / (simTime × capacity) */
  busyTime: number;
}

export type JobState = "POOL" | "MOVING" | "QUEUED" | "PROCESSING" | "DONE_AT_MODULE" | "COMPLETED";

export type JobLocation = { kind: "pool" } | { kind: "module"; moduleId: ModuleId };

export interface Job {
  id: JobId;
  required: Set<ResultType>;
  acquired: Set<ResultType>;
  state: JobState;
  /** MOVING 중에는 목적지 모듈을 가리킨다. */
  location: JobLocation;
  /** 현재 처리 경과 시간 */
  progress: number;
  /** 등장 시각 (simTime) */
  createdAt: number;
  /** 완료 시각: 완료된 step이 끝난 뒤의 시각 (simTime + dt) */
  completedAt?: number;
}

export type Command =
  | { type: "assign"; jobId: JobId; moduleId: ModuleId } // 대기 구역 또는 다른 모듈 → 모듈
  | { type: "unassign"; jobId: JobId }; // 모듈 → 대기 구역

export type SimEvent =
  | {
      type: "jobArrived" | "processStarted" | "processFinished" | "jobCompleted" | "processCancelled";
      jobId: JobId;
      moduleId?: ModuleId;
      t: number;
    }
  | { type: "jobSpawned"; jobId: JobId; t: number }
  | { type: "warning"; message: string; t: number };

/** 종료 조건 (기획서 §9) */
export type EndCondition =
  | { kind: "time"; value: number }
  | { kind: "completed"; value: number }
  | { kind: "allDone" };

/** 시뮬레이션 설정. 기획서 §9의 바뀔 수 있는 규칙 값을 모은다. */
export interface SimConfig {
  /** 고정 시간 간격(초) */
  dt: number;
  /** 대기 구역/모듈 → 모듈 이동 시간(초). 0이면 즉시 */
  moveTime: number;
  /** 처리 끝난 작업이 감독관이 옮길 때까지 모듈 슬롯을 점유하는가 */
  occupyWhenDone: boolean;
  /** true: 처리 중 이동하면 처리 취소(결과 없음), false: 처리 중 이동 금지 */
  cancelOnMove: boolean;
  /** 모듈 대기열 길이 상한. null이면 무제한 */
  queueLimit: number | null;
  /** 종료 조건 */
  endCondition: EndCondition;
}

/** 설정 기본값. 기본값은 이곳에만 둔다(기획서 §9). */
export const DEFAULT_CONFIG: Readonly<SimConfig> = Object.freeze({
  dt: 0.1,
  moveTime: 0,
  occupyWhenDone: true,
  cancelOnMove: true,
  queueLimit: null,
  endCondition: Object.freeze({ kind: "time", value: 300 }),
});

/** 작업 도착 방식 (기획서 §5.1, §9) */
export type ArrivalSpec =
  | { kind: "poisson"; rate: number; requiredPool: ResultType[]; minReq: number; maxReq: number }
  | { kind: "none" };

/** 시나리오의 모듈 정의 */
export interface ScenarioModule {
  id: ModuleId;
  resultType: ResultType;
  processTime: number;
  /** 생략하면 1 */
  capacity?: number;
}

/** 시나리오 파일(scenarios/*.json) 형식 */
export interface Scenario {
  name: string;
  seed: number;
  modules: ScenarioModule[];
  jobs: {
    initial: { required: ResultType[] }[];
    /** 생략하면 도착 없음 */
    arrival?: ArrivalSpec;
  };
  config?: Partial<SimConfig>;
}

/** 새로 생성할 작업의 명세 */
export interface JobSpec {
  required: ResultType[];
}

/** 이동 중인 작업의 내부 정보 */
export interface MoveInfo {
  /** 출발 위치 (렌더러 애니메이션용) */
  from: JobLocation;
  /** 목적지 모듈 */
  moduleId: ModuleId;
  /** 남은 이동 시간(초) */
  remaining: number;
}

/**
 * 배치 명령이 실제로 할 일.
 * - move: 목적지 모듈로 이동한다(다른 모듈 또는 대기 구역에서 온 작업).
 * - reprocess: 같은 모듈 슬롯에서 처리를 처음부터 다시 한다(DONE_AT_MODULE 작업).
 * - noop: 바뀔 것이 없다(같은 모듈로 이동 중, 대기 중, 처리 중). 상태 불변 + warning.
 */
export type AssignAction = "move" | "reprocess" | "noop";

/** 배치/회수 가능 여부 판정 결과 */
export interface RuleCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 교체 가능한 시뮬레이션 규칙 묶음.
 * world.ts는 규칙을 직접 계산하지 않고 world.rules를 통해서만 호출한다.
 * 기본 구현은 rules.ts의 defaultRules다.
 */
export interface RuleSet {
  /** 작업이 이 모듈에서 처리되는 데 걸리는 시간 */
  processTime(world: WorldState, job: Job, module: Module): number;
  /** 처리 경과가 처리 시간에 도달했는가 (부동소수점 오차 허용) */
  isProcessFinished(world: WorldState, job: Job, module: Module): boolean;
  /** 처리가 끝났을 때 작업이 얻는 결과 */
  gainedResults(world: WorldState, job: Job, module: Module): ResultType[];
  /** 작업 완료 판정 (required ⊆ acquired) */
  isJobComplete(world: WorldState, job: Job): boolean;
  /** 처리 끝난(완료되지 않은) 작업을 모듈에서 대기 구역으로 돌려보내는가 */
  releaseWhenDone(world: WorldState, job: Job, module: Module): boolean;
  /**
   * 작업을 모듈에 배치할 수 있는가 (불가하면 명령 무시 + warning).
   * 배치 판단은 감독관 책임이므로, 존재하지 않는 대상·완료된 작업·이동 금지처럼
   * 명령 자체를 수행할 수 없는 경우만 거부한다. 나머지는 assignWarnings로 경고한다.
   */
  canAssign(world: WorldState, jobId: JobId, moduleId: ModuleId): RuleCheck;
  /** 허용된 배치 명령이 실제로 할 일 (이동, 같은 모듈 재처리, 무의미한 명령) */
  assignAction(world: WorldState, job: Job, module: Module): AssignAction;
  /** 작업을 대기 구역으로 돌려보낼 수 있는가 */
  canUnassign(world: WorldState, jobId: JobId): RuleCheck;
  /** 배치는 허용하되 경고할 내용 (필요 없는 결과, 이미 얻은 결과, 대기열 상한 초과, 무의미한 명령 등) */
  assignWarnings(world: WorldState, job: Job, module: Module): string[];
  /** 처리 중인 작업을 옮길 때 처리를 취소하는가 */
  cancelsOnMove(world: WorldState, job: Job): boolean;
  /** 모듈까지 이동 시간 */
  moveTime(world: WorldState, job: Job, moduleId: ModuleId): number;
  /** 이동이 끝났는가 */
  isMoveFinished(world: WorldState, move: MoveInfo): boolean;
  /** 모듈에 빈 슬롯이 있는가 */
  hasFreeSlot(world: WorldState, module: Module): boolean;
  /** 대기열에서 다음에 슬롯으로 들어갈 작업 (기본 FIFO). 없으면 null */
  selectNextFromQueue(world: WorldState, module: Module): JobId | null;
  /** 이번 step에 새로 도착하는 작업 명세. random은 시드 RNG */
  arrivals(world: WorldState, dt: number, random: () => number): JobSpec[];
  /** 이번 step에서 모듈 가동 시간(busyTime) 증가량. processedCount는 이번 step에 처리 중이던 슬롯 수 */
  busyTimeDelta(world: WorldState, module: Module, processedCount: number, dt: number): number;
  /** 종료 조건 판정 */
  isEnded(world: WorldState): boolean;
}

export interface WorldState {
  simTime: number;
  modules: Map<ModuleId, Module>;
  jobs: Map<JobId, Job>;
  completedCount: number;
  /** 이번 step에서 발생한 이벤트 (렌더러와 로그가 사용) */
  events: SimEvent[];
  config: SimConfig;
  /** 현재 쓰는 규칙 구현 */
  rules: RuleSet;
  /** 작업 도착 방식 */
  arrival: ArrivalSpec;
  /** 시드 RNG 상태 (직렬 가능한 32비트 정수) */
  rngState: number;
  /** 다음에 생성할 작업 번호 */
  nextJobNumber: number;
  /** 이동 중인 작업 정보 (삽입 순서 = 이동 시작 순서) */
  moves: Map<JobId, MoveInfo>;
}
