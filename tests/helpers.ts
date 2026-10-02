// 엔진 테스트 공용 헬퍼. 엔진의 공개 API(createWorld, step)만 사용한다.
import type { Command, Job, Module, ResultType, Scenario, SimConfig, SimEvent, WorldState } from "../src/engine/types";
import type { RuleSet } from "../src/engine/rules";
import { createWorld, step } from "../src/engine/world";

/** 테스트 기본 설정. 엔진 기본값에 기대지 않도록 모든 항목을 명시한다. */
export const TEST_CONFIG: SimConfig = {
  dt: 0.1,
  moveTime: 0,
  occupyWhenDone: true,
  cancelOnMove: true,
  queueLimit: null,
  endCondition: { kind: "time", value: 1000 },
};

/** 부동소수점 비교 허용 오차 */
export const EPS = 1e-9;

export interface ScenarioInput {
  modules: Scenario["modules"];
  initial: ResultType[][];
  config?: Partial<SimConfig>;
  seed?: number;
  arrival?: Scenario["jobs"]["arrival"];
}

/** 도착 없는 작은 시나리오를 만든다. config는 TEST_CONFIG 위에 덮어쓴다. */
export function makeScenario(input: ScenarioInput): Scenario {
  return {
    name: "test",
    seed: input.seed ?? 1,
    modules: input.modules,
    jobs: {
      initial: input.initial.map((required) => ({ required })),
      arrival: input.arrival ?? { kind: "none" },
    },
    config: { ...TEST_CONFIG, ...input.config },
  };
}

/** 규칙 구현을 바꿔 같은 테스트를 돌릴 수 있도록 월드 생성기를 만든다. */
export type WorldFactory = (scenario: Scenario) => WorldState;

export function worldFactory(rules: RuleSet): WorldFactory {
  return (scenario) => createWorld(scenario, { rules });
}

/**
 * n번 step을 돌린다. commandsByStep[i]는 i번째(0부터) step에 넘길 명령이다.
 * 각 step의 이벤트를 모아 돌려준다.
 */
export function runSteps(
  world: WorldState,
  n: number,
  commandsByStep: Record<number, Command[]> = {},
): SimEvent[][] {
  const eventsPerStep: SimEvent[][] = [];
  for (let i = 0; i < n; i++) {
    step(world, commandsByStep[i] ?? []);
    eventsPerStep.push([...world.events]);
  }
  return eventsPerStep;
}

/**
 * 조건이 참이 될 때까지 명령 없이 step을 돌린다.
 * 조건을 처음 만족한 step의 번호(1부터)를 돌려준다. maxSteps 안에 만족하지 않으면 예외.
 */
export function stepUntil(world: WorldState, predicate: (w: WorldState) => boolean, maxSteps: number): number {
  for (let i = 1; i <= maxSteps; i++) {
    step(world, []);
    if (predicate(world)) return i;
  }
  throw new Error(`stepUntil: ${maxSteps} step 안에 조건을 만족하지 않음`);
}

export function job(world: WorldState, id: string): Job {
  const j = world.jobs.get(id);
  if (!j) throw new Error(`작업 ${id} 없음`);
  return j;
}

export function mod(world: WorldState, id: string): Module {
  const m = world.modules.get(id);
  if (!m) throw new Error(`모듈 ${id} 없음`);
  return m;
}

export function hasEvent(events: SimEvent[], type: SimEvent["type"], jobId?: string): boolean {
  return events.some((e) => e.type === type && (jobId === undefined || ("jobId" in e && e.jobId === jobId)));
}

/**
 * 값을 깊은 복사한다. Map/Set/배열/평범한 객체를 복사하고 함수(규칙 구현 등)는 참조를 유지한다.
 * structuredClone은 함수를 복사하지 못하므로 직접 구현한다.
 */
export function deepCopy<T>(value: T): T {
  return copyValue(value) as T;
}

function copyValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [copyValue(k), copyValue(v)]));
  if (value instanceof Set) return new Set([...value].map(copyValue));
  if (Array.isArray(value)) return value.map(copyValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = copyValue(v);
  return out;
}

/** events를 제외한 월드 상태 사본 (상태 불변 비교용) */
export function stateWithoutEvents(world: WorldState): Omit<WorldState, "events"> {
  const { events: _events, ...rest } = deepCopy(world);
  void _events;
  return rest;
}

export function assign(jobId: string, moduleId: string): Command {
  return { type: "assign", jobId, moduleId };
}

export function unassign(jobId: string): Command {
  return { type: "unassign", jobId };
}
