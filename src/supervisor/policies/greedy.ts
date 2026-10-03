// greedy 정책: 구현은 rules/greedy.ts의 룰 클래스다. 기존 import(createGreedySupervisor)를 위한 얇은 래퍼.
import GreedyRule from "../../../rules/greedy";
import { ruleToSupervisor } from "../rule";
import type { Supervisor } from "../types";

/** greedy는 난수를 쓰지 않으므로 seed는 의미가 없다. */
const UNUSED_SEED = 0;

export function createGreedySupervisor(): Supervisor {
  return ruleToSupervisor(GreedyRule, UNUSED_SEED);
}
