// 시나리오 편집기의 순수 로직 (DOM 없음). DOM은 scenarioEditor.ts가 맡는다.
// 현재 시나리오 → 편집용 초안, 초안 조작(모듈 추가·삭제·수정, 작업 도착, 종료 조건, 설정),
// 초안 → Scenario 변환을 다룬다. 검증 규칙은 여기서 새로 만들지 않고 engine/scenario.ts의 parseScenario를 그대로 쓴다.

import { parseScenario } from "../engine/scenario";
import type { ArrivalSpec, EndCondition, ResultType, Scenario, ScenarioModule, SimConfig } from "../engine/types";

/** 편집 중인 모듈 한 줄. 입력이 비었거나 숫자가 아니면 NaN(→ parseScenario가 오류로 알린다). */
export interface ModuleDraft {
  id: string;
  resultType: ResultType;
  processTime: number;
  /** null이면 생략(엔진 기본 용량) */
  capacity: number | null;
}

/** 작업 도착(포아송) 편집 값 */
export interface ArrivalDraft {
  /** 포아송 도착을 쓰는가 */
  enabled: boolean;
  /** 도착을 끌 때의 표현: 원래 시나리오가 arrival을 생략했으면 "omit", { kind: "none" }이면 "none" */
  offKind: "omit" | "none";
  rate: number;
  minReq: number;
  maxReq: number;
  /** autoPool이 false일 때 쓰는 결과 목록 */
  requiredPool: ResultType[];
  /** true면 requiredPool을 모듈 resultType 목록에서 자동으로 만든다 */
  autoPool: boolean;
}

/** 종료 조건 종류. "default"는 생략(엔진 기본 종료 조건) */
export type EndKind = "default" | EndCondition["kind"];

export interface EndDraft {
  kind: EndKind;
  /** time(초)·completed(개수)에서 쓰는 값 */
  value: number;
}

/** 편집용 초안. 모든 조작 함수는 초안을 바꾸지 않고 새 초안을 돌려준다. */
export interface ScenarioDraft {
  name: string;
  seed: number;
  modules: ModuleDraft[];
  /** 초기 작업마다 목표 결과 목록 */
  initial: ResultType[][];
  arrival: ArrivalDraft;
  end: EndDraft;
  /** null이면 생략(엔진 기본값) */
  moveTime: number | null;
  occupyWhenDone: boolean | null;
  cancelOnMove: boolean | null;
  /** 편집기에서 다루지 않는 나머지 설정(dt, queueLimit 등)은 그대로 보존한다 */
  extraConfig: Partial<SimConfig>;
  /** 원래 시나리오에 config가 있었는가 (빈 config도 왕복 보존) */
  hasConfig: boolean;
}

/** 오류 하나. path는 parseScenario 오류 경로(예: "modules[2].processTime"), 알 수 없으면 null */
export interface DraftError {
  path: string | null;
  message: string;
}

export type DraftResult = { ok: true; scenario: Scenario } | { ok: false; errors: DraftError[] };

/** 새로 켜는 도착 설정의 기본값 (원래 시나리오에 포아송 도착이 없을 때) */
export const NEW_ARRIVAL_RATE = 0.3;
export const NEW_ARRIVAL_MIN_REQ = 1;
/** 종료 조건 값이 없을 때(기본값·allDone에서 바꿀 때) 채우는 값 */
export const NEW_END_VALUE = 300;
/** 모듈이 하나도 없을 때 새 모듈의 기본값 */
export const NEW_MODULE_PREFIX = "M";
export const NEW_MODULE_PROCESS_TIME = 1;

/** 편집하는 설정 키 (나머지는 extraConfig로 보존) */
const EDITED_CONFIG_KEYS: readonly (keyof SimConfig)[] = ["moveTime", "occupyWhenDone", "cancelOnMove", "endCondition"];

/** 모듈 resultType 목록에서 만든 requiredPool (모듈 순서, 중복·빈 값 제외) */
export function autoRequiredPool(modules: readonly ModuleDraft[]): ResultType[] {
  const pool: ResultType[] = [];
  for (const m of modules) {
    if (m.resultType.trim() !== "" && !pool.includes(m.resultType)) pool.push(m.resultType);
  }
  return pool;
}

/** 초안이 실제로 쓰는 requiredPool */
export function effectiveRequiredPool(draft: ScenarioDraft): ResultType[] {
  return draft.arrival.autoPool ? autoRequiredPool(draft.modules) : [...draft.arrival.requiredPool];
}

function samePool(a: readonly ResultType[], b: readonly ResultType[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

function moduleToDraft(m: ScenarioModule): ModuleDraft {
  return { id: m.id, resultType: m.resultType, processTime: m.processTime, capacity: m.capacity ?? null };
}

function arrivalToDraft(arrival: ArrivalSpec | undefined, modules: readonly ModuleDraft[]): ArrivalDraft {
  const auto = autoRequiredPool(modules);
  if (arrival?.kind === "poisson") {
    return {
      enabled: true,
      offKind: "omit",
      rate: arrival.rate,
      minReq: arrival.minReq,
      maxReq: arrival.maxReq,
      requiredPool: [...arrival.requiredPool],
      // 원래 목록이 자동 목록과 같을 때만 자동 동기화로 둔다 (왕복 보존).
      autoPool: samePool(arrival.requiredPool, auto),
    };
  }
  return {
    enabled: false,
    offKind: arrival?.kind === "none" ? "none" : "omit",
    rate: NEW_ARRIVAL_RATE,
    minReq: NEW_ARRIVAL_MIN_REQ,
    maxReq: Math.max(NEW_ARRIVAL_MIN_REQ, auto.length),
    requiredPool: auto,
    autoPool: true,
  };
}

function endToDraft(end: EndCondition | undefined): EndDraft {
  if (!end) return { kind: "default", value: NEW_END_VALUE };
  if (end.kind === "allDone") return { kind: "allDone", value: NEW_END_VALUE };
  return { kind: end.kind, value: end.value };
}

/** 시나리오 → 편집용 초안 (입력 시나리오는 바꾸지 않는다) */
export function scenarioToDraft(scenario: Scenario): ScenarioDraft {
  const modules = scenario.modules.map(moduleToDraft);
  const config = scenario.config ?? {};
  const extraConfig: Partial<SimConfig> = { ...config };
  for (const key of EDITED_CONFIG_KEYS) delete extraConfig[key];
  return {
    name: scenario.name,
    seed: scenario.seed,
    modules,
    initial: scenario.jobs.initial.map((j) => [...j.required]),
    arrival: arrivalToDraft(scenario.jobs.arrival, modules),
    end: endToDraft(config.endCondition),
    moveTime: config.moveTime ?? null,
    occupyWhenDone: config.occupyWhenDone ?? null,
    cancelOnMove: config.cancelOnMove ?? null,
    extraConfig,
    hasConfig: scenario.config !== undefined,
  };
}

/** 초안 → parseScenario에 넘길 원시 객체 (검증 전) */
export function draftToRaw(draft: ScenarioDraft): Record<string, unknown> {
  const modules = draft.modules.map((m) => {
    const raw: Record<string, unknown> = { id: m.id, resultType: m.resultType, processTime: m.processTime };
    if (m.capacity !== null) raw.capacity = m.capacity;
    return raw;
  });
  const jobs: Record<string, unknown> = { initial: draft.initial.map((required) => ({ required: [...required] })) };
  const a = draft.arrival;
  if (a.enabled) {
    jobs.arrival = {
      kind: "poisson",
      rate: a.rate,
      requiredPool: effectiveRequiredPool(draft),
      minReq: a.minReq,
      maxReq: a.maxReq,
    };
  } else if (a.offKind === "none") {
    jobs.arrival = { kind: "none" };
  }
  const config: Record<string, unknown> = { ...draft.extraConfig };
  if (draft.moveTime !== null) config.moveTime = draft.moveTime;
  if (draft.occupyWhenDone !== null) config.occupyWhenDone = draft.occupyWhenDone;
  if (draft.cancelOnMove !== null) config.cancelOnMove = draft.cancelOnMove;
  if (draft.end.kind === "allDone") config.endCondition = { kind: "allDone" };
  else if (draft.end.kind !== "default") config.endCondition = { kind: draft.end.kind, value: draft.end.value };

  const raw: Record<string, unknown> = { name: draft.name, seed: draft.seed, modules, jobs };
  if (draft.hasConfig || Object.keys(config).length > 0) raw.config = config;
  return raw;
}

/** parseScenario 오류 메시지 "시나리오 형식 오류 (경로): 내용"을 경로와 내용으로 나눈다. */
const PARSE_ERROR_PATTERN = /^시나리오 형식 오류 \((.+?)\): (.*)$/s;

export function errorFromException(e: unknown): DraftError {
  const message = e instanceof Error ? e.message : String(e);
  const m = PARSE_ERROR_PATTERN.exec(message);
  return m ? { path: m[1] ?? null, message: m[2] ?? message } : { path: null, message };
}

/** 모듈 하나만 담은 시험용 시나리오 (모듈별 오류를 한꺼번에 모으기 위해 parseScenario에 따로 넘긴다) */
const PROBE_NAME = "probe";
const PROBE_MODULE_PATH = "modules[0]";

function moduleErrors(raw: Record<string, unknown>): DraftError[] {
  const modules = raw.modules;
  if (!Array.isArray(modules)) return [];
  const errors: DraftError[] = [];
  modules.forEach((m, i) => {
    try {
      parseScenario({ name: PROBE_NAME, seed: 0, modules: [m], jobs: { initial: [] } });
    } catch (e) {
      const err = errorFromException(e);
      const path = err.path?.startsWith(PROBE_MODULE_PATH)
        ? `modules[${i}]${err.path.slice(PROBE_MODULE_PATH.length)}`
        : err.path;
      errors.push({ path, message: err.message });
    }
  });
  return errors;
}

/**
 * 초안 → Scenario. 반드시 parseScenario로 검증한다.
 * 모듈마다 따로 검증해 모듈 칸 오류는 한꺼번에 돌려주고, 모듈이 모두 맞으면 전체를 검증한다
 * (parseScenario는 첫 오류에서 멈추므로 나머지 오류는 그 오류를 고친 뒤 보인다).
 */
export function draftToScenario(draft: ScenarioDraft): DraftResult {
  const raw = draftToRaw(draft);
  const perModule = moduleErrors(raw);
  if (perModule.length > 0) return { ok: false, errors: perModule };
  try {
    return { ok: true, scenario: parseScenario(raw) };
  } catch (e) {
    return { ok: false, errors: [errorFromException(e)] };
  }
}

/** 오류 경로가 입력 경로(또는 그 아래)에 속하는가. 예: "jobs.initial[0].required" ⊂ "jobs.initial" */
export function pathMatches(errorPath: string, fieldPath: string): boolean {
  if (errorPath === fieldPath) return true;
  if (!errorPath.startsWith(fieldPath)) return false;
  const next = errorPath.charAt(fieldPath.length);
  return next === "." || next === "[";
}

/** 기존 id와 겹치지 않는 새 모듈 id. 마지막 모듈 id의 숫자 앞부분을 접두어로 쓴다. */
export function nextModuleId(ids: readonly string[]): string {
  const last = ids[ids.length - 1];
  const match = last === undefined ? null : /^(.*?)(\d+)$/.exec(last);
  const prefix = match ? (match[1] ?? "") : (last ?? NEW_MODULE_PREFIX);
  const used = new Set(ids);
  for (let n = ids.length + 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * 모듈을 끝에 추가한다. 결과 종류·처리 시간·용량은 마지막 모듈을 따른다.
 * 모듈이 없으면 결과 종류는 도착 목록·초기 작업의 첫 결과, 그것도 없으면 빈 값(사용자가 채운다).
 */
export function addModule(draft: ScenarioDraft): ScenarioDraft {
  const last = draft.modules[draft.modules.length - 1];
  const module: ModuleDraft = {
    id: nextModuleId(draft.modules.map((m) => m.id)),
    resultType: last?.resultType ?? draft.arrival.requiredPool[0] ?? draft.initial[0]?.[0] ?? "",
    processTime: last?.processTime ?? NEW_MODULE_PROCESS_TIME,
    capacity: last?.capacity ?? null,
  };
  return { ...draft, modules: [...draft.modules, module] };
}

/** index번째 모듈을 지운다. 범위 밖이면 그대로 돌려준다. */
export function removeModule(draft: ScenarioDraft, index: number): ScenarioDraft {
  if (index < 0 || index >= draft.modules.length) return draft;
  return { ...draft, modules: draft.modules.filter((_, i) => i !== index) };
}

/** index번째 모듈의 필드를 바꾼다. */
export function updateModule(draft: ScenarioDraft, index: number, patch: Partial<ModuleDraft>): ScenarioDraft {
  if (index < 0 || index >= draft.modules.length) return draft;
  return { ...draft, modules: draft.modules.map((m, i) => (i === index ? { ...m, ...patch } : m)) };
}

/** 작업 도착 설정을 바꾼다. 자동 동기화를 끌 때는 지금 자동 목록을 수동 목록의 시작값으로 쓴다. */
export function updateArrival(draft: ScenarioDraft, patch: Partial<ArrivalDraft>): ScenarioDraft {
  const arrival = { ...draft.arrival, ...patch };
  if (draft.arrival.autoPool && patch.autoPool === false && patch.requiredPool === undefined) {
    arrival.requiredPool = autoRequiredPool(draft.modules);
  }
  return { ...draft, arrival };
}

/** 모듈·도착 밖의 필드(이름, 시드, 초기 작업, 종료 조건, 설정)를 바꾼다. */
export function updateDraft(
  draft: ScenarioDraft,
  patch: Partial<Omit<ScenarioDraft, "modules" | "arrival">>,
): ScenarioDraft {
  return { ...draft, ...patch };
}

/** 쉼표로 구분한 결과 목록 텍스트 ↔ 배열 (앞뒤 공백·빈 칸 제거) */
export function parseResultListText(text: string): ResultType[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function formatResultListText(list: readonly ResultType[]): string {
  return list.join(", ");
}

/** 초기 작업 텍스트(한 줄에 작업 하나, 결과는 쉼표로) ↔ 배열. 빈 줄은 건너뛴다. */
export function parseInitialJobsText(text: string): ResultType[][] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parseResultListText);
}

export function formatInitialJobsText(initial: readonly (readonly ResultType[])[]): string {
  return initial.map(formatResultListText).join("\n");
}

/** 두 초안이 같은 내용인가 (적용하지 않은 편집이 있는지 표시용) */
export function sameDraft(a: ScenarioDraft, b: ScenarioDraft): boolean {
  return JSON.stringify(draftToRaw(a)) === JSON.stringify(draftToRaw(b));
}

/** 시나리오 JSON 들여쓰기 */
const JSON_INDENT = 2;

/** 시나리오 → 저장용 JSON 텍스트 */
export function scenarioJson(scenario: Scenario): string {
  return `${JSON.stringify(scenario, null, JSON_INDENT)}\n`;
}

export type LoadScenarioResult = { ok: true; scenario: Scenario } | { ok: false; message: string };

/** JSON 텍스트 → Scenario (JSON 문법 오류와 parseScenario 오류를 한국어 메시지로) */
export function loadScenarioJson(text: string): LoadScenarioResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: "JSON 형식이 아닙니다." };
  }
  try {
    return { ok: true, scenario: parseScenario(data) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 편집 시나리오를 저장하는 localStorage 키 */
export const CUSTOM_SCENARIO_STORAGE_KEY = "sim.customScenario";

/** localStorage에서 쓰는 부분 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 저장된 편집 시나리오를 읽는다. 없거나, 읽을 수 없거나, 형식이 틀리면 null. */
export function loadCustomScenario(storage: StorageLike | null): Scenario | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(CUSTOM_SCENARIO_STORAGE_KEY);
    if (text === null) return null;
    const result = loadScenarioJson(text);
    return result.ok ? result.scenario : null;
  } catch {
    return null;
  }
}

/** 편집 시나리오를 저장한다. 실패하면 false (저장하지 못해도 화면은 그대로 동작한다). */
export function saveCustomScenario(storage: StorageLike | null, scenario: Scenario): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CUSTOM_SCENARIO_STORAGE_KEY, JSON.stringify(scenario));
    return true;
  } catch {
    return false;
  }
}
