// 룰 API 진입점. rules/*.ts는 여기서 import한다: import { Rule, type RuleContext } from "../src/supervisor/rule";
export { Rule, isRuleClass, type RuleClass } from "./Rule";
export { ruleToSupervisor, RULE_LOG_LIMIT, type RuleSupervisor } from "./adapter";
export type { JobRef, ModuleRef, RuleContext, RuleLogEntry } from "./types";
