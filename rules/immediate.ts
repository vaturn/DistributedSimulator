// 즉시 룰: 작업의 남은 결과 중 아무거나, 그 결과를 주는 모듈이 비어 있으면 바로 배치한다.
// 예) required [A, B]인 작업은 A 모듈이든 B 모듈이든 먼저 비는 쪽으로 간다.
// "비어 있음"의 기준은 sequential 룰과 같다: 빈 슬롯이 있고 대기열이 없을 때만 배치(미리 줄 세우지 않음).
// 여러 작업이 경합하면 먼저 생긴 작업이 우선이고, 한 작업은 한 step에 한 모듈에만 요청한다.
// 쓸 수 있는 모듈이 여러 개면 시나리오 순서로 첫 모듈을 고른다(결정적).
import { type JobRef, type ModuleRef, Rule, type RuleContext } from "../src/supervisor/rule";

export default class ImmediateRule extends Rule {
  name = "immediate";
  label = "즉시(빈 모듈에 바로)";

  decide(ctx: RuleContext): void {
    const claimed = new Map<ModuleRef, number>();
    for (const job of oldestFirst(ctx.poolJobs())) {
      if (job.remaining().length === 0) continue;
      const target = ctx.modules().find((m) => m.isUsefulFor(job) && hasRoom(m, claimed) && m.canAccept(job));
      if (target && job.assignTo(target)) claimed.set(target, (claimed.get(target) ?? 0) + 1);
    }
  }
}

/** 생성 순(오래 기다린 작업 먼저). 같은 시각이면 받은 순서를 유지한다(안정 정렬). */
function oldestFirst(jobs: JobRef[]): JobRef[] {
  return [...jobs].sort((a, b) => a.createdAt - b.createdAt);
}

/** 대기열이 비어 있고, 이번 step에 요청한 작업을 빼고도 빈 슬롯이 남는가 */
function hasRoom(module: ModuleRef, claimed: Map<ModuleRef, number>): boolean {
  return module.queueLength() === 0 && module.freeSlots() - (claimed.get(module) ?? 0) > 0;
}
