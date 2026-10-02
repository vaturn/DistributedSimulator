// 감독관·시나리오 선택의 순수 로직 (기획서 §7 컨트롤, §10 M5).
// URL 쿼리 파싱, 기본값 결정, 선택 → 세션 설정 결정을 DOM 없이 다룬다. DOM은 selectors.ts가 맡는다.

import type { Scenario } from "../engine/types";
import type { Supervisor } from "../supervisor/types";

/** 감독관을 고르는 URL 쿼리 이름 (?supervisor=...) */
export const SUPERVISOR_QUERY = "supervisor";
/** 시나리오를 고르는 URL 쿼리 이름 (?scenario=...) */
export const SCENARIO_QUERY = "scenario";
/** 수동 감독관의 선택 값. 정책 registry에는 없고 UI가 직접 옵션으로 추가한다. */
export const MANUAL_SUPERVISOR = "manual";
/** 수동 감독관 옵션 라벨 */
export const MANUAL_LABEL = "수동";
/** 기본 감독관 */
export const DEFAULT_SUPERVISOR = MANUAL_SUPERVISOR;
/** 기본 시나리오 */
export const DEFAULT_SCENARIO = "basic";

/** select 옵션 하나 */
export interface SelectOption {
  value: string;
  label: string;
}

/** 현재 선택 */
export interface Selection {
  supervisor: string;
  scenario: string;
}

/** 쿼리 파싱 결과. warnings는 알 수 없는 값을 기본값으로 바꾼 내역이다(콘솔에 띄운다). */
export interface ParsedSelection {
  selection: Selection;
  warnings: string[];
}

/** 선택 가능한 값 목록 */
export interface SelectionChoices {
  supervisors: readonly SelectOption[];
  scenarios: readonly SelectOption[];
}

/** 정책 registry 항목 중 선택 UI에 필요한 부분 */
export interface PolicyLike {
  name: string;
  label: string;
  create(seed: number): Supervisor;
}

/** 시나리오 목록 항목 중 선택 UI에 필요한 부분 */
export interface ScenarioLike {
  name: string;
  label: string;
  scenario: Scenario;
}

/** 감독관 옵션: 수동 + 정책들 (registry 순서) */
export function supervisorOptions(policies: readonly PolicyLike[]): SelectOption[] {
  return [{ value: MANUAL_SUPERVISOR, label: MANUAL_LABEL }, ...policies.map((p) => ({ value: p.name, label: p.label }))];
}

/** 시나리오 옵션 (목록 순서) */
export function scenarioOptions(scenarios: readonly ScenarioLike[]): SelectOption[] {
  return scenarios.map((s) => ({ value: s.name, label: s.label }));
}

/** 기본값이 목록에 없으면 첫 옵션을 쓴다. 목록이 비면 기본값 그대로. */
function fallbackValue(options: readonly SelectOption[], preferred: string): string {
  if (options.some((o) => o.value === preferred)) return preferred;
  return options[0]?.value ?? preferred;
}

/** 쿼리 값 하나를 고른다: 없으면 기본값, 알 수 없으면 기본값 + 경고 */
function pick(
  raw: string | null,
  options: readonly SelectOption[],
  preferred: string,
  kind: string,
  warnings: string[],
): string {
  const fallback = fallbackValue(options, preferred);
  if (raw === null || raw === "") return fallback;
  if (options.some((o) => o.value === raw)) return raw;
  warnings.push(
    `알 수 없는 ${kind} "${raw}" → ${fallback}로 실행합니다. 가능한 값: ${options.map((o) => o.value).join(", ")}`,
  );
  return fallback;
}

/** URL 쿼리 문자열(location.search)에서 선택을 읽는다. */
export function parseSelectionQuery(search: string, choices: SelectionChoices): ParsedSelection {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];
  const supervisor = pick(params.get(SUPERVISOR_QUERY), choices.supervisors, DEFAULT_SUPERVISOR, "감독관", warnings);
  const scenario = pick(params.get(SCENARIO_QUERY), choices.scenarios, DEFAULT_SCENARIO, "시나리오", warnings);
  return { selection: { supervisor, scenario }, warnings };
}

/** 선택을 쿼리 문자열에 반영한다. 다른 쿼리 값은 그대로 둔다. 결과는 "?..." 형태. */
export function selectionToQuery(search: string, selection: Selection): string {
  const params = new URLSearchParams(search);
  params.set(SUPERVISOR_QUERY, selection.supervisor);
  params.set(SCENARIO_QUERY, selection.scenario);
  return `?${params.toString()}`;
}

/** 선택으로 정한 세션 설정. 감독관은 세션을 만들 때마다 새로 만든다(쌓인 명령 폐기). */
export interface SessionConfig {
  scenarioName: string;
  scenario: Scenario;
  /** 결과 JSON·파일명에 쓰는 감독관 이름 (수동이면 "manual") */
  policyName: string;
  /** 시나리오 seed */
  seed: number;
  /** 수동 감독관인가 (드래그 입력 연결 여부) */
  manual: boolean;
  /** 정책 감독관을 만든다. 수동이면 null (UI가 createManualSupervisor로 만든다). */
  createPolicy: ((seed: number) => Supervisor) | null;
}

/** 선택 → 세션 설정. 목록에 없는 값이면 오류 (parseSelectionQuery를 거친 값만 넘긴다). */
export function resolveSessionConfig(
  selection: Selection,
  policies: readonly PolicyLike[],
  scenarios: readonly ScenarioLike[],
): SessionConfig {
  const entry = scenarios.find((s) => s.name === selection.scenario);
  if (!entry) throw new Error(`알 수 없는 시나리오: ${selection.scenario}`);
  const base = { scenarioName: entry.name, scenario: entry.scenario, seed: entry.scenario.seed };
  if (selection.supervisor === MANUAL_SUPERVISOR) {
    return { ...base, policyName: MANUAL_SUPERVISOR, manual: true, createPolicy: null };
  }
  const policy = policies.find((p) => p.name === selection.supervisor);
  if (!policy) throw new Error(`알 수 없는 감독관: ${selection.supervisor}`);
  return { ...base, policyName: policy.name, manual: false, createPolicy: (seed) => policy.create(seed) };
}
