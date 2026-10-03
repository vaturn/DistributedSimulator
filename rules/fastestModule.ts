// 사용자용 예시 룰: 대기 구역의 작업마다, 필요한 결과를 주는 모듈 중 가장 빨리 비는 모듈에 보낸다.
// 새 룰을 만들 때 이 파일을 복사해서 시작하면 된다 (rules/README.md 참고).
import { Rule, type RuleContext } from "../src/supervisor/rule";

export default class FastestModule extends Rule {
  name = "fastest";
  label = "가장 빨리 비는 모듈";

  decide(ctx: RuleContext) {
    for (const job of ctx.poolJobs()) {
      const target = ctx
        .modules()
        .filter((m) => job.needs(m.resultType))
        .sort((a, b) => a.estimatedWait() - b.estimatedWait())[0];
      if (target) job.assignTo(target);
    }
  }
}
