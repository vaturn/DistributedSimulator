// rules/*.ts 모듈 → 정책 항목. 모듈을 모으는 일(브라우저: import.meta.glob, CLI: node fs + import)은
// 각 환경의 진입점이 하고, 검사와 변환은 모두 이 파일 한 곳에서 한다.
import { type RuleClass, isRuleClass, ruleToSupervisor } from "./rule";
import type { PolicyEntry } from "./types";

/** 룰 이름 형식: 영문, 숫자, `_`, `-` (CLI 인자와 결과 파일 이름에 그대로 쓴다) */
export const RULE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 로드 결과. 오류가 있는 룰은 entries에서 빠지고 errors에 한국어 메시지로 남는다. */
export interface LoadedRules {
  entries: PolicyEntry[];
  errors: string[];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 룰 클래스 하나를 정책 항목으로 바꾼다. 형식이 틀리면 오류 메시지를 던진다. */
export function ruleEntry(RuleCtor: RuleClass, source: string): PolicyEntry {
  let probe;
  try {
    probe = new RuleCtor();
  } catch (e) {
    throw new Error(`${source}: 룰 클래스를 만들지 못했습니다 (${errorMessage(e)})`);
  }
  const name: unknown = probe.name;
  if (typeof name !== "string" || !RULE_NAME_PATTERN.test(name)) {
    throw new Error(`${source}: name은 영문, 숫자, _, -로 된 문자열이어야 합니다 (현재: ${JSON.stringify(name)})`);
  }
  const label: unknown = probe.label;
  if (label !== undefined && (typeof label !== "string" || label === "")) {
    throw new Error(`${source}: label은 비어 있지 않은 문자열이어야 합니다`);
  }
  if (typeof probe.decide !== "function") {
    throw new Error(`${source}: decide(ctx) 메서드가 없습니다`);
  }
  return {
    name,
    label: label ?? name,
    create: (seed: number) => ruleToSupervisor(RuleCtor, seed),
    source,
    ruleClass: RuleCtor,
  };
}

/** 모듈 경로(키)를 메시지용으로 다듬는다: 앞의 "/" 제거 */
function displayPath(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * { 파일 경로: 모듈 } → 정책 항목. 파일 경로 순서로 검사한다(결정성).
 * - default export가 Rule 하위 클래스가 아니면 오류
 * - name 형식이 틀리면 오류
 * - name이 앞 파일과 겹치면 뒤 파일을 빼고 오류
 */
export function entriesFromRuleModules(mods: Readonly<Record<string, unknown>>): LoadedRules {
  const entries: PolicyEntry[] = [];
  const errors: string[] = [];
  for (const key of Object.keys(mods).sort()) {
    const source = displayPath(key);
    const mod = mods[key];
    const def: unknown = typeof mod === "object" && mod !== null ? (mod as { default?: unknown }).default : undefined;
    if (def === undefined) {
      errors.push(`${source}: default export가 없습니다. "export default class 이름 extends Rule"로 내보내세요`);
      continue;
    }
    if (!isRuleClass(def)) {
      errors.push(`${source}: default export가 Rule을 상속한 클래스가 아닙니다`);
      continue;
    }
    let entry: PolicyEntry;
    try {
      entry = ruleEntry(def, source);
    } catch (e) {
      errors.push(errorMessage(e));
      continue;
    }
    const dup = entries.find((x) => x.name === entry.name);
    if (dup) {
      errors.push(`${source}: 룰 이름 "${entry.name}"을(를) 이미 ${dup.source ?? "다른 룰"}에서 써서 무시합니다`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, errors };
}
