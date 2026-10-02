import { describe, expect, it } from "vitest";
import { parseScenario } from "../src/engine/scenario";
import { createWorld } from "../src/engine/world";
import basicJson from "../src/scenarios/basic.json";
import { findScenario, SCENARIOS } from "../src/scenarios";

/** 올바른 최소 시나리오 (매번 새로 만든다) */
function valid(): Record<string, unknown> {
  return {
    name: "t",
    seed: 1,
    modules: [
      { id: "M1", resultType: "A", processTime: 2 },
      { id: "M2", resultType: "B", processTime: 1, capacity: 2 },
    ],
    jobs: {
      initial: [{ required: ["A", "B"] }],
      arrival: { kind: "poisson", rate: 0.2, requiredPool: ["A", "B"], minReq: 1, maxReq: 2 },
    },
    config: { dt: 0.1, queueLimit: null, endCondition: { kind: "allDone" } },
  };
}

/** 점으로 구분한 경로("modules.0.id")의 값을 바꾼다. value가 undefined면 지운다. */
function setPath(root: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = root as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  const last = keys[keys.length - 1]!;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

/** valid()의 여러 경로를 고친 시나리오로 parseScenario를 부르는 함수 */
function broken(edits: Record<string, unknown>): () => unknown {
  const s = valid();
  for (const [path, value] of Object.entries(edits)) setPath(s, path, value);
  return () => parseScenario(s);
}

describe("내장 시나리오", () => {
  it("모든 SCENARIOS는 parseScenario를 통과하고 이름이 유일하며 월드를 만들 수 있다", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(2);
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SCENARIOS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(parseScenario(s.scenario)).toEqual(s.scenario);
      expect(() => createWorld(s.scenario)).not.toThrow();
    }
  });

  it("basic.json은 파싱 결과가 원본과 같다", () => {
    expect(parseScenario(basicJson)).toEqual(basicJson);
    expect(findScenario("basic")?.scenario).toEqual(basicJson);
    expect(findScenario("없음")).toBeUndefined();
  });
});

describe("parseScenario", () => {
  it("올바른 시나리오를 받아들이고 입력을 바꾸지 않는다", () => {
    const s = valid();
    const copy = JSON.parse(JSON.stringify(s));
    const parsed = parseScenario(s);
    expect(parsed.modules[1]?.capacity).toBe(2);
    expect(parsed.modules[0]?.capacity).toBeUndefined();
    expect(s).toEqual(copy);
  });

  it("arrival과 config를 생략할 수 있다", () => {
    const parsed = parseScenario({ name: "x", seed: 0, modules: [{ id: "M", resultType: "A", processTime: 1 }], jobs: { initial: [] } });
    expect(parsed.jobs.arrival).toBeUndefined();
    expect(parsed.config).toBeUndefined();
  });

  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["modules가 배열 아님", { modules: 3 }, /modules/],
    ["name 없음", { name: undefined }, /name/],
    ["seed가 문자열", { seed: "1" }, /seed/],
    ["seed가 정수 아님", { seed: 1.5 }, /seed/],
    ["모듈 없음", { modules: [] }, /modules/],
    ["processTime 0", { "modules.0.processTime": 0 }, /processTime/],
    ["processTime 음수", { "modules.0.processTime": -1 }, /processTime/],
    ["capacity 0", { "modules.0.capacity": 0 }, /capacity/],
    ["capacity 소수", { "modules.0.capacity": 1.5 }, /capacity/],
    ["모듈 id 중복", { "modules.1.id": "M1" }, /중복/],
    ["resultType 없음", { "modules.0.resultType": undefined }, /resultType/],
    ["jobs 없음", { jobs: undefined }, /jobs/],
    ["initial이 배열 아님", { "jobs.initial": {} }, /jobs\.initial/],
    ["required 비어 있음", { "jobs.initial.0.required": [] }, /required/],
    ["주는 모듈 없는 결과", { "jobs.initial.0.required": ["Z"] }, /Z/],
    ["arrival kind 이상", { "jobs.arrival.kind": "burst" }, /arrival\.kind/],
    ["arrival rate 음수", { "jobs.arrival.rate": -1 }, /rate/],
    ["minReq > maxReq", { "jobs.arrival.minReq": 2, "jobs.arrival.maxReq": 1 }, /minReq/],
    ["maxReq > pool 크기", { "jobs.arrival.maxReq": 3 }, /maxReq/],
    ["requiredPool 비어 있음", { "jobs.arrival.requiredPool": [] }, /requiredPool/],
    ["requiredPool에 주는 모듈 없는 결과", { "jobs.arrival.requiredPool": ["A", "Q"] }, /Q/],
    ["config 알 수 없는 키", { "config.speed": 2 }, /config\.speed/],
    ["dt 0", { "config.dt": 0 }, /dt/],
    ["occupyWhenDone 문자열", { "config.occupyWhenDone": "yes" }, /occupyWhenDone/],
    ["endCondition kind 이상", { "config.endCondition": { kind: "never" } }, /endCondition/],
    ["endCondition time 값 없음", { "config.endCondition": { kind: "time" } }, /endCondition\.value/],
  ];

  for (const [label, edits, pattern] of cases) {
    it(`오류: ${label}`, () => {
      expect(broken(edits)).toThrow(pattern);
    });
  }

  it("null이나 배열은 시나리오가 아니다", () => {
    expect(() => parseScenario(null)).toThrow(/시나리오/);
    expect(() => parseScenario([])).toThrow(/시나리오/);
  });
});
