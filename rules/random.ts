// random 룰 (기준선): 대기 구역 작업과 처리 끝난 작업 중 일부를 무작위 모듈에 배치한다 (기획서 §3, §4.1).
// 필요한 결과를 주는지는 따지지 않는다. 다만 배치할 수 없는 모듈(canAccept 불가)은 고르지 않는다.
// 난수는 ctx.random()(시드 RNG)만 쓰므로 같은 seed, 같은 월드 흐름이면 같은 명령을 낸다.
import { Rule, type RuleContext } from "../src/supervisor/rule";

/** step마다 후보 작업 하나를 배치할 확률 */
export const RANDOM_ASSIGN_PROBABILITY = 0.2;

export default class RandomRule extends Rule {
  name = "random";
  label = "무작위";

  decide(ctx: RuleContext): void {
    for (const job of ctx.jobs()) {
      if (job.state !== "POOL" && job.state !== "DONE_AT_MODULE") continue;
      if (ctx.random() >= RANDOM_ASSIGN_PROBABILITY) continue;
      const targets = ctx.modules().filter((m) => m.canAccept(job));
      if (targets.length === 0) continue;
      const target = targets[Math.floor(ctx.random() * targets.length)];
      if (target !== undefined) job.assignTo(target);
    }
  }
}
