// greedy 룰: 필요한 결과를 주고 가장 빨리 비는 모듈에 배치한다 (기획서 §3, §4.1).
// 처리 끝나 모듈을 점유 중인 작업을 먼저(슬롯 비우기), 그다음 대기 구역 작업을 본다.
// 모든 판정(필요한 결과, 배치 가능 여부, 예상 대기 시간)은 ModuleRef/JobRef가 engine/rules.ts로 계산한다.
import { type ModuleRef, Rule, type RuleContext } from "../src/supervisor/rule";

export default class GreedyRule extends Rule {
  name = "greedy";
  label = "탐욕(가장 빨리 비는 모듈)";

  decide(ctx: RuleContext): void {
    for (const job of [...ctx.doneJobs(), ...ctx.poolJobs()]) {
      // 예상 대기 시간이 가장 짧은 모듈 (동점은 시나리오 순서).
      // estimatedWait는 이번 step에 이미 요청한 배치를 줄에 포함하므로 한 모듈에 몰리지 않는다.
      let best: ModuleRef | null = null;
      let bestWait = Infinity;
      for (const module of ctx.modules()) {
        if (!module.isUsefulFor(job) || !module.canAccept(job)) continue;
        const wait = module.estimatedWait(job);
        if (best === null || wait < bestWait) {
          best = module;
          bestWait = wait;
        }
      }
      if (best !== null) {
        job.assignTo(best);
      } else if (job.state === "DONE_AT_MODULE" && job.canUnassign()) {
        // 갈 곳이 없으면 슬롯을 비워 다른 작업이 쓰게 한다.
        job.unassign();
      }
    }
  }
}
