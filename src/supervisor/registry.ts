// 정책 감독관 목록. 화면의 감독관 선택과 CLI의 --policy가 같은 목록을 쓴다.
// 수동 감독관(manual)은 화면 입력이 필요하므로 여기 넣지 않는다.
import { createGreedySupervisor } from "./policies/greedy";
import { createRandomSupervisor } from "./policies/random";
import type { Supervisor } from "./types";

export interface PolicyEntry {
  /** CLI와 결과 파일에 쓰는 이름 */
  name: string;
  /** 화면에 보이는 이름 */
  label: string;
  /** 감독관을 만든다. 난수를 쓰지 않는 정책은 seed를 무시한다. */
  create(seed: number): Supervisor;
}

export const POLICIES: readonly PolicyEntry[] = Object.freeze([
  { name: "random", label: "무작위", create: (seed: number) => createRandomSupervisor(seed) },
  { name: "greedy", label: "탐욕(가장 빨리 비는 모듈)", create: () => createGreedySupervisor() },
]);

export function findPolicy(name: string): PolicyEntry | undefined {
  return POLICIES.find((p) => p.name === name);
}
