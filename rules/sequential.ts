// 순차 룰: 작업마다 남은 결과를 "작업의 required 순서"대로만 받는다.
// 예) required [A, B]인 작업은 A를 얻기 전에는 B 모듈에 가지 않는다.
// 다음에 받아야 할 결과를 주는 모듈이 "비어 있을 때만"(빈 슬롯이 있고 대기열이 없을 때) 배치하고,
// 대기열에 미리 줄 세우지 않는다. 여러 작업이 같은 모듈을 기다리면 먼저 생긴 작업이 우선이다.
// immediate 룰과 배치 조건(빈 모듈에만, 오래 기다린 작업 우선, 모듈은 시나리오 순서)이 같고
// 차이는 "정해진 순서로만 받는다"는 제약 하나뿐이다.
import { type JobRef, type ModuleRef, Rule, type RuleContext } from "../src/supervisor/rule";

export default class SequentialRule extends Rule {
  name = "sequential";
  label = "순차(정해진 순서대로)";

  decide(ctx: RuleContext): void {
    const claimed = new Map<ModuleRef, number>();
    for (const job of oldestFirst(ctx.poolJobs())) {
      const next = nextResult(job);
      if (next === undefined) continue;
      const target = ctx
        .modules()
        .find((m) => m.resultType === next && m.isUsefulFor(job) && hasRoom(m, claimed) && m.canAccept(job));
      if (target && job.assignTo(target)) claimed.set(target, (claimed.get(target) ?? 0) + 1);
    }
  }
}

/** required 순서에서 아직 얻지 못한 첫 결과 */
function nextResult(job: JobRef): string | undefined {
  const remaining = job.remaining();
  return job.required().find((r) => remaining.includes(r));
}

/** 생성 순(오래 기다린 작업 먼저). 같은 시각이면 받은 순서를 유지한다(안정 정렬). */
function oldestFirst(jobs: JobRef[]): JobRef[] {
  return [...jobs].sort((a, b) => a.createdAt - b.createdAt);
}

/** 대기열이 비어 있고, 이번 step에 요청한 작업을 빼고도 빈 슬롯이 남는가 */
function hasRoom(module: ModuleRef, claimed: Map<ModuleRef, number>): boolean {
  return module.queueLength() === 0 && module.freeSlots() - (claimed.get(module) ?? 0) > 0;
}
