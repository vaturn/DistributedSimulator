// 시나리오 파일(JSON) 형식 검증 (기획서 §5.1).
// 화면(시나리오 선택)과 CLI(파일 경로로 받은 JSON) 모두 이 함수로 시나리오를 읽는다.
// 실패하면 어디가 잘못되었는지 한국어 메시지로 Error를 던진다.

import type { ArrivalSpec, EndCondition, ResultType, Scenario, ScenarioModule, SimConfig } from "./types";

type Obj = Record<string, unknown>;

/** config에 들어올 수 있는 키 (오타를 잡기 위해 이 밖의 키는 거부한다) */
const CONFIG_KEYS: readonly (keyof SimConfig)[] = [
  "dt",
  "moveTime",
  "occupyWhenDone",
  "cancelOnMove",
  "queueLimit",
  "endCondition",
];

function fail(path: string, message: string): never {
  throw new Error(`시나리오 형식 오류 (${path}): ${message}`);
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) fail(path, "객체여야 합니다.");
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "배열이어야 합니다.");
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(path, "비어 있지 않은 문자열이어야 합니다.");
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "유한한 숫자여야 합니다.");
  return v;
}

function positive(v: unknown, path: string): number {
  const n = num(v, path);
  if (n <= 0) fail(path, "0보다 커야 합니다.");
  return n;
}

function nonNegative(v: unknown, path: string): number {
  const n = num(v, path);
  if (n < 0) fail(path, "0 이상이어야 합니다.");
  return n;
}

function integerAtLeast(v: unknown, min: number, path: string): number {
  const n = num(v, path);
  if (!Number.isInteger(n) || n < min) fail(path, `${min} 이상의 정수여야 합니다.`);
  return n;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "true 또는 false여야 합니다.");
  return v;
}

function resultList(v: unknown, path: string): ResultType[] {
  const list = arr(v, path).map((r, i) => str(r, `${path}[${i}]`));
  if (list.length === 0) fail(path, "결과가 하나 이상 있어야 합니다.");
  if (new Set(list).size !== list.length) fail(path, "같은 결과가 중복되었습니다.");
  return list;
}

function parseModules(v: unknown): ScenarioModule[] {
  const list = arr(v, "modules");
  if (list.length === 0) fail("modules", "모듈이 하나 이상 있어야 합니다.");
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const path = `modules[${i}]`;
    const m = obj(raw, path);
    const id = str(m.id, `${path}.id`);
    if (seen.has(id)) fail(`${path}.id`, `모듈 id가 중복되었습니다: ${id}`);
    seen.add(id);
    const module: ScenarioModule = {
      id,
      resultType: str(m.resultType, `${path}.resultType`),
      processTime: positive(m.processTime, `${path}.processTime`),
    };
    if (m.capacity !== undefined) module.capacity = integerAtLeast(m.capacity, 1, `${path}.capacity`);
    return module;
  });
}

function parseArrival(v: unknown): ArrivalSpec {
  const a = obj(v, "jobs.arrival");
  switch (a.kind) {
    case "none":
      return { kind: "none" };
    case "poisson": {
      const requiredPool = resultList(a.requiredPool, "jobs.arrival.requiredPool");
      const minReq = integerAtLeast(a.minReq, 1, "jobs.arrival.minReq");
      const maxReq = integerAtLeast(a.maxReq, 1, "jobs.arrival.maxReq");
      if (minReq > maxReq) fail("jobs.arrival", "minReq는 maxReq보다 클 수 없습니다.");
      if (maxReq > requiredPool.length) fail("jobs.arrival.maxReq", "requiredPool의 결과 수보다 클 수 없습니다.");
      return { kind: "poisson", rate: nonNegative(a.rate, "jobs.arrival.rate"), requiredPool, minReq, maxReq };
    }
    default:
      return fail("jobs.arrival.kind", '"poisson" 또는 "none"이어야 합니다.');
  }
}

function parseEndCondition(v: unknown): EndCondition {
  const path = "config.endCondition";
  const e = obj(v, path);
  switch (e.kind) {
    case "time":
      return { kind: "time", value: positive(e.value, `${path}.value`) };
    case "completed":
      return { kind: "completed", value: integerAtLeast(e.value, 1, `${path}.value`) };
    case "allDone":
      return { kind: "allDone" };
    default:
      return fail(`${path}.kind`, '"time", "completed", "allDone" 중 하나여야 합니다.');
  }
}

function parseConfig(v: unknown): Partial<SimConfig> {
  const c = obj(v, "config");
  for (const key of Object.keys(c)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) fail(`config.${key}`, "알 수 없는 설정입니다.");
  }
  const config: Partial<SimConfig> = {};
  if (c.dt !== undefined) config.dt = positive(c.dt, "config.dt");
  if (c.moveTime !== undefined) config.moveTime = nonNegative(c.moveTime, "config.moveTime");
  if (c.occupyWhenDone !== undefined) config.occupyWhenDone = bool(c.occupyWhenDone, "config.occupyWhenDone");
  if (c.cancelOnMove !== undefined) config.cancelOnMove = bool(c.cancelOnMove, "config.cancelOnMove");
  if (c.queueLimit !== undefined) {
    config.queueLimit = c.queueLimit === null ? null : integerAtLeast(c.queueLimit, 0, "config.queueLimit");
  }
  if (c.endCondition !== undefined) config.endCondition = parseEndCondition(c.endCondition);
  return config;
}

/** 모든 목표 결과를 만들 수 있는 모듈이 있는지 확인한다 (없으면 그 작업은 영영 완료되지 않는다). */
function checkProducible(scenario: Scenario): void {
  const produced = new Set(scenario.modules.map((m) => m.resultType));
  scenario.jobs.initial.forEach((j, i) => {
    for (const r of j.required) {
      if (!produced.has(r)) fail(`jobs.initial[${i}].required`, `결과 "${r}"를 주는 모듈이 없습니다.`);
    }
  });
  const arrival = scenario.jobs.arrival;
  if (arrival?.kind === "poisson") {
    for (const r of arrival.requiredPool) {
      if (!produced.has(r)) fail("jobs.arrival.requiredPool", `결과 "${r}"를 주는 모듈이 없습니다.`);
    }
  }
}

/**
 * 알 수 없는 값(JSON.parse 결과 등)을 검증해서 Scenario로 만든다.
 * 입력을 바꾸지 않고 새 객체를 돌려준다. 형식이 틀리면 한국어 메시지로 Error를 던진다.
 */
export function parseScenario(data: unknown): Scenario {
  const root = obj(data, "시나리오");
  const name = str(root.name, "name");
  const seed = num(root.seed, "seed");
  if (!Number.isInteger(seed)) fail("seed", "정수여야 합니다.");
  const modules = parseModules(root.modules);

  const jobs = obj(root.jobs, "jobs");
  const initial = arr(jobs.initial, "jobs.initial").map((raw, i) => {
    const j = obj(raw, `jobs.initial[${i}]`);
    return { required: resultList(j.required, `jobs.initial[${i}].required`) };
  });

  const scenario: Scenario = { name, seed, modules, jobs: { initial } };
  if (jobs.arrival !== undefined) scenario.jobs.arrival = parseArrival(jobs.arrival);
  if (root.config !== undefined) scenario.config = parseConfig(root.config);
  checkProducible(scenario);
  return scenario;
}
