// 브라우저(Vite)용 룰 수집: 저장소 루트 rules/*.ts를 빌드 때 모두 묶는다.
// 화면(main.ts)은 createRegistry(BROWSER_RULES.entries)로 감독관 목록을 만든다.
import { type LoadedRules, entriesFromRuleModules } from "./ruleLoader";

const modules: Record<string, unknown> = import.meta.glob("/rules/*.ts", { eager: true });

/** rules/ 폴더의 룰 (경로 순서) */
export const BROWSER_RULES: LoadedRules = entriesFromRuleModules(modules);
