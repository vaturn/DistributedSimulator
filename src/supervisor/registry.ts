// 정책 감독관 목록. 화면의 감독관 선택과 CLI의 --policy가 같은 목록을 쓴다.
// 수동 감독관(manual)은 화면 입력이 필요하므로 여기 넣지 않는다.
// - 내장 정책(POLICIES): rules/random.ts, rules/greedy.ts. 어디서나(브라우저, CLI, 테스트) 항상 있다.
// - 추가 정책: rules/ 폴더에서 읽은 룰(ruleLoader). createRegistry(extra)로 내장 정책 뒤에 붙인다.
import GreedyRule from "../../rules/greedy";
import RandomRule from "../../rules/random";
import { ruleEntry } from "./ruleLoader";
import type { PolicyEntry } from "./types";

export type { PolicyEntry } from "./types";

/** 정책 이름으로 쓸 수 없는 이름 (화면의 수동 감독관 값) */
export const RESERVED_POLICY_NAMES: readonly string[] = Object.freeze(["manual"]);

export const POLICIES: readonly PolicyEntry[] = Object.freeze([
  ruleEntry(RandomRule, "rules/random.ts"),
  ruleEntry(GreedyRule, "rules/greedy.ts"),
]);

export function findPolicy(name: string): PolicyEntry | undefined {
  return POLICIES.find((p) => p.name === name);
}

/** 내장 정책 + 추가 정책 목록 */
export interface PolicyRegistry {
  /** 내장 정책(POLICIES 순서) 다음에 추가 정책(넘긴 순서) */
  readonly policies: readonly PolicyEntry[];
  find(name: string): PolicyEntry | undefined;
  /** 등록하지 못한 추가 정책과 이유 (한국어) */
  readonly errors: readonly string[];
}

function describe(entry: PolicyEntry): string {
  return entry.source ?? entry.name;
}

/**
 * 추가 정책을 내장 정책 뒤에 붙인다. 충돌 규칙:
 * - 내장 정책과 같은 룰 클래스(rules/greedy.ts 같은 내장 룰 파일을 다시 읽은 것)는 조용히 건너뛴다.
 * - 내장 정책과 이름만 같은 다른 룰은 등록하지 않고 오류로 알린다(내장 정책이 이긴다).
 * - 추가 정책끼리 이름이 같으면 먼저 온 것만 등록하고 오류로 알린다.
 * - 예약 이름(manual)은 등록하지 않고 오류로 알린다.
 */
export function createRegistry(extra: readonly PolicyEntry[] = []): PolicyRegistry {
  const policies: PolicyEntry[] = [...POLICIES];
  const errors: string[] = [];
  for (const entry of extra) {
    if (RESERVED_POLICY_NAMES.includes(entry.name)) {
      errors.push(`${describe(entry)}: "${entry.name}"은(는) 예약된 이름이라 쓸 수 없습니다`);
      continue;
    }
    const builtin = POLICIES.find((p) => p.name === entry.name);
    if (builtin) {
      if (builtin.ruleClass !== undefined && builtin.ruleClass === entry.ruleClass) continue;
      errors.push(`${describe(entry)}: 이름 "${entry.name}"을(를) 이미 내장 정책(${describe(builtin)})이 써서 무시합니다`);
      continue;
    }
    const dup = policies.find((p) => p.name === entry.name);
    if (dup) {
      errors.push(`${describe(entry)}: 이름 "${entry.name}"을(를) 이미 ${describe(dup)}에서 써서 무시합니다`);
      continue;
    }
    policies.push(entry);
  }
  const frozen = Object.freeze(policies);
  return {
    policies: frozen,
    find: (name) => frozen.find((p) => p.name === name),
    errors: Object.freeze(errors),
  };
}
