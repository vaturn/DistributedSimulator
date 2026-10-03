// 룰 API의 공개 타입. 룰 작성자는 이 인터페이스만 보고 코드를 짠다.
// 모든 참조 객체는 읽기 전용 래퍼다. 월드 상태를 직접 바꿀 방법은 없고, assignTo/unassign은 명령을 요청만 한다.
import type { JobId, JobState, ModuleId, ResultType } from "../../engine/types";

/** 모듈 참조 (읽기 전용) */
export interface ModuleRef {
  readonly id: ModuleId;
  /** 이 모듈이 주는 결과 */
  readonly resultType: ResultType;
  /** 시나리오에 정의된 기본 처리 시간(초). 작업별 실제 처리 시간은 processTimeFor(job) */
  readonly processTime: number;
  /** 동시에 처리할 수 있는 작업 수 */
  readonly capacity: number;
  /** 작업 job이 이 모듈에서 실제로 걸리는 처리 시간 (규칙 rules.processTime 경유) */
  processTimeFor(job: JobRef): number;
  /** 슬롯도 대기열도 비어 있는가 */
  isIdle(): boolean;
  /** 지금 비어 있는 슬롯 수 (규칙 hasFreeSlot이 거부하면 0) */
  freeSlots(): number;
  /** 대기열 길이 */
  queueLength(): number;
  /** 지금 처리 중인 작업 */
  processingJobs(): JobRef[];
  /**
   * 새 작업이 이 모듈에서 처리를 시작하기까지 예상 대기 시간(초) (rules.estimatedWaitTime 경유).
   * 이번 step에 이미 이 모듈로 요청한 작업(assignTo)도 줄에 포함한다.
   * job을 주면 그 작업 자신은 계산에서 뺀다(옮기려는 작업이 이미 이 모듈에 있을 때).
   */
  estimatedWait(job?: JobRef): number;
  /** 작업을 이 모듈에 배치할 수 있는가 (rules.canAssign 경유) */
  canAccept(job: JobRef): boolean;
  /** 이 모듈의 처리가 작업에 아직 없는 필요한 결과를 주는가 (rules.usefulResults 경유) */
  isUsefulFor(job: JobRef): boolean;
}

/** 작업 참조 (읽기 전용). assignTo/unassign은 명령을 요청만 하고, step이 끝나야 상태가 바뀐다. */
export interface JobRef {
  readonly id: JobId;
  readonly state: JobState;
  /** 등장 시각 (simTime) */
  readonly createdAt: number;
  /** 필요한 결과 (복사본) */
  required(): ResultType[];
  /** 이미 얻은 결과 (복사본) */
  acquired(): ResultType[];
  /** 아직 얻지 못한 필요한 결과 (rules.remainingResults 경유) */
  remaining(): ResultType[];
  /** 이 결과가 아직 필요한가 */
  needs(resultType: ResultType): boolean;
  /** 있는 모듈 (이동 중이면 목적지). 대기 구역이면 null */
  location(): ModuleRef | null;
  /** 지금까지 대기한 시간(초): 대기 구역 + 대기열 체류 누적 */
  waitTime(): number;
  /** 대기 구역으로 돌려보낼 수 있는가 (rules.canUnassign 경유) */
  canUnassign(): boolean;
  /** 이 작업을 module에 배치하라고 요청한다. 거부되면 버리고 ctx 로그에 남긴다. 요청이 받아들여졌으면 true */
  assignTo(module: ModuleRef): boolean;
  /** 이 작업을 대기 구역으로 돌려보내라고 요청한다. 거부되면 버리고 ctx 로그에 남긴다. 요청이 받아들여졌으면 true */
  unassign(): boolean;
}

/** 룰에 매 step 넘기는 문맥 */
export interface RuleContext {
  /** 현재 시뮬레이션 시각 (simTime) */
  readonly time: number;
  /** step 간격(초) */
  readonly dt: number;
  /** 모든 모듈 (시나리오 순서) */
  modules(): ModuleRef[];
  /** id로 모듈 찾기 */
  module(id: ModuleId): ModuleRef | undefined;
  /** 모든 작업 (생성 순서, 완료된 작업 포함) */
  jobs(): JobRef[];
  /** 대기 구역의 작업 (POOL) */
  poolJobs(): JobRef[];
  /** 모듈 대기열의 작업 (QUEUED) */
  queuedJobs(): JobRef[];
  /** 처리 중인 작업 (PROCESSING) */
  processingJobs(): JobRef[];
  /** 처리가 끝나 모듈 슬롯을 점유 중인 작업 (DONE_AT_MODULE) */
  doneJobs(): JobRef[];
  /** 모듈이 주는 결과 종류 (중복 없이 시나리오 순서) */
  resultTypes(): ResultType[];
  /** [0,1) 시드 난수. Math.random 대신 이것을 써야 결과가 재현된다. */
  random(): number;
  /** 디버그 메시지를 남긴다 (RuleSupervisor.drainLogs로 꺼낸다) */
  log(message: string): void;
}

/** 룰 로그 한 줄 */
export interface RuleLogEntry {
  /** 남긴 시각 (simTime) */
  t: number;
  message: string;
}
