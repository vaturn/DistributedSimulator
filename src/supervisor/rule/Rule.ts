// 룰 기반 감독관의 기반 클래스. rules/*.ts 파일은 이 클래스를 상속한 클래스를 default export 한다.
// 룰은 RuleContext로 월드를 읽고, JobRef.assignTo/unassign으로 명령을 "요청"만 한다.
import type { RuleContext } from "./types";

/**
 * 룰 기반 감독관.
 * - 인스턴스는 seed(실행)마다 새로 만든다. 필드에 상태를 두어도 실행끼리 섞이지 않는다.
 * - 생성자 인자는 없다(로더가 `new RuleClass()`로 만든다).
 */
export abstract class Rule {
  /** 고유 식별자. CLI(--policy)와 결과 파일에 쓴다. 영문, 숫자, `_`, `-`만 쓴다. */
  abstract name: string;
  /** 화면에 보이는 이름. 생략하면 name */
  label?: string;
  /** 첫 decide 직전에 한 번 불린다. 첫 step의 ctx를 받으므로 여기서 요청한 명령도 첫 step에 들어간다. */
  init?(ctx: RuleContext): void;
  /** 매 step 불린다. ctx로 월드를 읽고 작업에 assignTo/unassign을 요청한다. */
  abstract decide(ctx: RuleContext): void;
}

/** Rule 하위 클래스 (인자 없는 생성자) */
export type RuleClass = new () => Rule;

/** 값이 Rule 하위 클래스인가 (Rule 자신은 추상 클래스라 제외) */
export function isRuleClass(value: unknown): value is RuleClass {
  return typeof value === "function" && value.prototype instanceof Rule;
}
