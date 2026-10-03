// random 정책: 구현은 rules/random.ts의 룰 클래스다. 기존 import(createRandomSupervisor)를 위한 얇은 래퍼.
import RandomRule from "../../../rules/random";
import { ruleToSupervisor } from "../rule";
import type { Supervisor } from "../types";

export { RANDOM_ASSIGN_PROBABILITY } from "../../../rules/random";

export function createRandomSupervisor(seed: number): Supervisor {
  return ruleToSupervisor(RandomRule, seed);
}
