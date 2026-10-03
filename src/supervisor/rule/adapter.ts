// Rule 클래스 → Supervisor 어댑터. 화면과 CLI는 룰을 다른 정책과 똑같이 Supervisor로 쓴다.
import { createRng } from "../../engine/rng";
import type { Command } from "../../engine/types";
import type { Supervisor, WorldView } from "../types";
import { createStepContext } from "./context";
import type { RuleClass } from "./Rule";
import type { RuleLogEntry } from "./types";

/** 보관할 룰 로그 최대 줄 수 (오래된 것부터 버린다) */
export const RULE_LOG_LIMIT = 1000;

/** 룰로 만든 감독관 */
export interface RuleSupervisor extends Supervisor {
  /** 화면에 보이는 이름 (룰의 label, 없으면 name) */
  readonly label: string;
  /** 쌓인 룰 로그(ctx.log, 거부된 요청)를 꺼내고 비운다 */
  drainLogs(): RuleLogEntry[];
}

/**
 * 룰 클래스로 감독관을 만든다. 룰 인스턴스와 시드 난수(ctx.random)는 이 감독관 하나에만 쓴다.
 * 같은 seed, 같은 월드 흐름이면 같은 명령을 낸다.
 */
export function ruleToSupervisor(RuleCtor: RuleClass, seed: number): RuleSupervisor {
  const rule = new RuleCtor();
  const rng = createRng(seed);
  const random = (): number => rng.next();
  let logs: RuleLogEntry[] = [];
  let initialized = false;

  return {
    name: rule.name,
    label: rule.label ?? rule.name,
    decide(view: WorldView): Command[] {
      const handle = createStepContext({
        view,
        random,
        log: (message) => {
          logs.push({ t: view.simTime, message });
          if (logs.length > RULE_LOG_LIMIT) logs.splice(0, logs.length - RULE_LOG_LIMIT);
        },
      });
      if (!initialized) {
        initialized = true;
        rule.init?.(handle.ctx);
      }
      rule.decide(handle.ctx);
      return handle.commands();
    },
    drainLogs(): RuleLogEntry[] {
      const out = logs;
      logs = [];
      return out;
    },
  };
}
