// 실행 결과 내보내기와 리플레이 (기획서 §8: 종료 후 결과 JSON, 정책 비교용, §10 M6: 리플레이).
// 화면과 CLI가 같은 형식으로 내보내고 읽도록 이곳에서만 만든다.

import { computeMetrics } from "./metrics";
import { EPSILON } from "./rules";
import { type CommandLogEntry, DEFAULT_MAX_STEPS, createReplayDecider, runHeadless } from "./runner";
import { parseScenario } from "./scenario";
import type { Command, Metrics, ModuleMetrics, Scenario, SimConfig, WorldState } from "./types";

/** 결과 파일 형식 버전 (2: scenarioSpec 추가) */
export const RUN_RESULT_VERSION = 2;
/** JSON 들여쓰기 칸 수 */
const JSON_INDENT = 2;

export interface RunResult {
  version: typeof RUN_RESULT_VERSION;
  /** 시나리오 이름 */
  scenario: string;
  /** 감독관(정책) 이름 */
  policy: string;
  /** 실제로 쓴 시드 (seed 덮어쓰기 반영) */
  seed: number;
  simTime: number;
  /** 종료 조건에 도달했는가 (false면 maxSteps 등으로 중간에 멈춘 결과) */
  ended: boolean;
  metrics: Metrics;
  config: SimConfig;
  /** 실행에 쓴 시나리오 전체 (seed는 실제로 쓴 seed). 리플레이에 쓴다 */
  scenarioSpec: Scenario;
  /** 명령 로그 (리플레이용) */
  commandLog: CommandLogEntry[];
}

export interface RunResultMeta {
  scenario: string;
  policy: string;
  seed: number;
  /** 실행에 쓴 시나리오 전체. seed는 meta.seed로 덮어써서 저장한다 */
  scenarioSpec: Scenario;
  commandLog: CommandLogEntry[];
}

/** 순수 데이터(JSON으로 표현되는 값)를 깊게 복사한다. */
function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function copyMetrics(m: Readonly<Metrics>): Metrics {
  return { ...m, modules: m.modules.map((mm) => ({ ...mm })) };
}

function copyCommandLog(log: readonly CommandLogEntry[]): CommandLogEntry[] {
  return log.map((e) => ({ ...e, commands: e.commands.map((c) => ({ ...c })) }));
}

/**
 * 월드의 현재 상태로 결과를 만든다. world에는 시드 원본이 남지 않으므로(RNG 상태만 있다)
 * seed는 meta.seed를 그대로 쓴다. 호출하는 쪽이 실제로 쓴 시드를 넘겨야 한다.
 * 모든 값은 복사하므로 이후 world가 바뀌어도 결과는 바뀌지 않는다.
 */
export function buildRunResult(world: Readonly<WorldState>, meta: RunResultMeta): RunResult {
  return {
    version: RUN_RESULT_VERSION,
    scenario: meta.scenario,
    policy: meta.policy,
    seed: meta.seed,
    simTime: world.simTime,
    ended: world.rules.isEnded(world),
    metrics: copyMetrics(computeMetrics(world)),
    config: { ...world.config, endCondition: { ...world.config.endCondition } },
    scenarioSpec: { ...cloneData(meta.scenarioSpec), seed: meta.seed },
    commandLog: copyCommandLog(meta.commandLog),
  };
}

/** Map/Set은 JSON으로 그대로 직렬화되지 않으므로(빈 객체가 된다) 발견하면 오류로 알린다. */
function rejectCollections(key: string, value: unknown): unknown {
  if (value instanceof Map || value instanceof Set) {
    throw new Error(`결과 직렬화 오류: "${key}"에 Map/Set이 있습니다.`);
  }
  return value;
}

/** 결과를 JSON 문자열로 만든다 (들여쓰기 2). */
export function serializeRunResult(r: RunResult): string {
  return JSON.stringify(r, rejectCollections, JSON_INDENT);
}

// ---------------------------------------------------------------------------
// 결과 파일 읽기 (형식 검증)

type Obj = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`결과 파일 형식 오류 (${path}): ${message}`);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "객체여야 합니다.");
  return v as Obj;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "배열이어야 합니다.");
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v === "") fail(path, "비어 있지 않은 문자열이어야 합니다.");
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "유한한 숫자여야 합니다.");
  return v;
}

function nonNegative(v: unknown, path: string): number {
  const n = num(v, path);
  if (n < 0) fail(path, "0 이상이어야 합니다.");
  return n;
}

function int(v: unknown, path: string, min?: number): number {
  const n = num(v, path);
  if (!Number.isInteger(n)) fail(path, "정수여야 합니다.");
  if (min !== undefined && n < min) fail(path, `${min} 이상이어야 합니다.`);
  return n;
}

function nullableNum(v: unknown, path: string): number | null {
  return v === null ? null : num(v, path);
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "true 또는 false여야 합니다.");
  return v;
}

function parseCommand(v: unknown, path: string): Command {
  const c = obj(v, path);
  switch (c.type) {
    case "assign":
      return { type: "assign", jobId: str(c.jobId, `${path}.jobId`), moduleId: str(c.moduleId, `${path}.moduleId`) };
    case "unassign":
      return { type: "unassign", jobId: str(c.jobId, `${path}.jobId`) };
    default:
      return fail(`${path}.type`, '"assign" 또는 "unassign"이어야 합니다.');
  }
}

function parseCommandLog(v: unknown): CommandLogEntry[] {
  return arr(v, "commandLog").map((raw, i) => {
    const path = `commandLog[${i}]`;
    const e = obj(raw, path);
    return {
      step: int(e.step, `${path}.step`, 0),
      t: nonNegative(e.t, `${path}.t`),
      commands: arr(e.commands, `${path}.commands`).map((c, j) => parseCommand(c, `${path}.commands[${j}]`)),
    };
  });
}

function parseModuleMetrics(v: unknown, path: string): ModuleMetrics {
  const m = obj(v, path);
  return {
    id: str(m.id, `${path}.id`),
    utilization: nonNegative(m.utilization, `${path}.utilization`),
    busyTime: nonNegative(m.busyTime, `${path}.busyTime`),
    doneOccupiedTime: nonNegative(m.doneOccupiedTime, `${path}.doneOccupiedTime`),
    queueLength: int(m.queueLength, `${path}.queueLength`, 0),
  };
}

function parseMetrics(v: unknown): Metrics {
  const m = obj(v, "metrics");
  return {
    simTime: nonNegative(m.simTime, "metrics.simTime"),
    completedCount: int(m.completedCount, "metrics.completedCount", 0),
    spawnedCount: int(m.spawnedCount, "metrics.spawnedCount", 0),
    throughput: nonNegative(m.throughput, "metrics.throughput"),
    avgLeadTime: nullableNum(m.avgLeadTime, "metrics.avgLeadTime"),
    avgWaitTime: nullableNum(m.avgWaitTime, "metrics.avgWaitTime"),
    poolWaitTime: nonNegative(m.poolWaitTime, "metrics.poolWaitTime"),
    queueWaitTime: nonNegative(m.queueWaitTime, "metrics.queueWaitTime"),
    wastedProcessCount: int(m.wastedProcessCount, "metrics.wastedProcessCount", 0),
    uselessProcessCount: int(m.uselessProcessCount, "metrics.uselessProcessCount", 0),
    cancelledProcessCount: int(m.cancelledProcessCount, "metrics.cancelledProcessCount", 0),
    modules: arr(m.modules, "metrics.modules").map((mm, i) => parseModuleMetrics(mm, `metrics.modules[${i}]`)),
  };
}

/** config는 시나리오 검증(parseScenario)을 통과한 뒤 빠진 값이 없어야 한다. */
function parseConfig(v: unknown, scenarioSpec: Scenario): SimConfig {
  const c = obj(v, "config");
  let checked: Partial<SimConfig>;
  try {
    checked = parseScenario({ ...scenarioSpec, config: c }).config ?? {};
  } catch (e) {
    fail("config", e instanceof Error ? e.message : String(e));
  }
  const { dt, moveTime, occupyWhenDone, cancelOnMove, queueLimit, endCondition } = checked;
  if (
    dt === undefined ||
    moveTime === undefined ||
    occupyWhenDone === undefined ||
    cancelOnMove === undefined ||
    queueLimit === undefined ||
    endCondition === undefined
  ) {
    fail("config", "dt, moveTime, occupyWhenDone, cancelOnMove, queueLimit, endCondition이 모두 있어야 합니다.");
  }
  return { dt, moveTime, occupyWhenDone, cancelOnMove, queueLimit, endCondition };
}

/**
 * 알 수 없는 값(결과 JSON을 JSON.parse한 값)을 검증해서 RunResult로 만든다.
 * 입력을 바꾸지 않고 새 객체를 돌려준다. 형식이 틀리면 한국어 메시지로 Error를 던진다.
 */
export function parseRunResult(data: unknown): RunResult {
  const root = obj(data, "결과");
  if (root.version !== RUN_RESULT_VERSION) {
    fail("version", `지원하는 버전은 ${RUN_RESULT_VERSION}입니다 (받은 값: ${JSON.stringify(root.version)}).`);
  }
  const seed = int(root.seed, "seed");
  let scenarioSpec: Scenario;
  try {
    scenarioSpec = parseScenario(root.scenarioSpec);
  } catch (e) {
    fail("scenarioSpec", e instanceof Error ? e.message : String(e));
  }
  if (scenarioSpec.seed !== seed) fail("scenarioSpec.seed", `seed(${seed})와 같아야 합니다.`);
  return {
    version: RUN_RESULT_VERSION,
    scenario: str(root.scenario, "scenario"),
    policy: str(root.policy, "policy"),
    seed,
    simTime: nonNegative(root.simTime, "simTime"),
    ended: bool(root.ended, "ended"),
    metrics: parseMetrics(root.metrics),
    config: parseConfig(root.config, scenarioSpec),
    scenarioSpec,
    commandLog: parseCommandLog(root.commandLog),
  };
}

// ---------------------------------------------------------------------------
// 리플레이

/** 두 숫자(또는 null)가 같은가. 부동소수는 EPSILON 차이까지 같다고 본다. */
function sameNumber(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= EPSILON;
}

function describeValue(v: number | null): string {
  return v === null ? "null" : String(v);
}

/** 요약 지표 중 숫자(또는 null) 키 */
const SUMMARY_KEYS = [
  "simTime",
  "completedCount",
  "spawnedCount",
  "throughput",
  "avgLeadTime",
  "avgWaitTime",
  "poolWaitTime",
  "queueWaitTime",
  "wastedProcessCount",
  "uselessProcessCount",
  "cancelledProcessCount",
] as const satisfies readonly (keyof Metrics)[];

/** 모듈 지표 중 숫자 키 */
const MODULE_KEYS = ["utilization", "busyTime", "doneOccupiedTime", "queueLength"] as const satisfies readonly (keyof ModuleMetrics)[];

/**
 * 두 지표를 비교해서 다른 항목을 한 줄씩 돌려준다 (같으면 빈 배열).
 * 부동소수는 EPSILON 차이까지 같다고 본다. 메시지는 "<항목>: <a> ≠ <b>" 형식이다.
 */
export function compareMetrics(a: Readonly<Metrics>, b: Readonly<Metrics>): string[] {
  const diffs: string[] = [];
  for (const key of SUMMARY_KEYS) {
    if (!sameNumber(a[key], b[key])) diffs.push(`metrics.${key}: ${describeValue(a[key])} ≠ ${describeValue(b[key])}`);
  }
  if (a.modules.length !== b.modules.length) {
    diffs.push(`metrics.modules 개수: ${a.modules.length} ≠ ${b.modules.length}`);
    return diffs;
  }
  a.modules.forEach((ma, i) => {
    const mb = b.modules[i];
    if (!mb) return;
    if (ma.id !== mb.id) {
      diffs.push(`metrics.modules[${i}].id: ${ma.id} ≠ ${mb.id}`);
      return;
    }
    for (const key of MODULE_KEYS) {
      if (!sameNumber(ma[key], mb[key])) diffs.push(`metrics.modules[${ma.id}].${key}: ${ma[key]} ≠ ${mb[key]}`);
    }
  });
  return diffs;
}

/** 값 두 개가 같은 데이터인가 (객체 키 순서는 보지 않는다) */
function sameData(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameData((a as Obj)[k], (b as Obj)[k]));
}

export interface ReplayOptions {
  /**
   * 최대 step 수. 생략하면 종료된 결과(ended=true)는 DEFAULT_MAX_STEPS,
   * 중간에 멈춘 결과는 저장된 simTime까지의 step 수(simTime / dt)만큼 돌린다.
   */
  maxSteps?: number;
}

export interface ReplayResult {
  /** 다시 실행한 월드 */
  world: WorldState;
  /** 저장된 결과와 재실행 결과가 같은가 */
  matches: boolean;
  /** 다른 항목 목록 ("<항목>: <저장값> ≠ <재실행값>") */
  mismatches: string[];
}

/**
 * 저장된 결과의 scenarioSpec과 commandLog로 화면 없이 다시 실행하고(createReplayDecider),
 * 저장된 지표·시간·종료 여부·설정과 재실행 결과를 비교한다. 결정성(기획서 §3) 확인용이다.
 */
export function replayRun(result: Readonly<RunResult>, options: ReplayOptions = {}): ReplayResult {
  const maxSteps =
    options.maxSteps ?? (result.ended ? DEFAULT_MAX_STEPS : Math.round(result.simTime / result.config.dt));
  const inner = createReplayDecider(result.commandLog);
  let stepsRun = 0;
  const decider = {
    decide(view: Readonly<WorldState>): Command[] {
      stepsRun++;
      return inner.decide(view);
    },
  };
  const { world } = runHeadless(result.scenarioSpec, decider, { seed: result.seed, maxSteps });
  const replayed = buildRunResult(world, {
    scenario: result.scenario,
    policy: result.policy,
    seed: result.seed,
    scenarioSpec: result.scenarioSpec,
    commandLog: [],
  });

  const mismatches: string[] = [];
  if (!sameNumber(result.simTime, replayed.simTime)) mismatches.push(`simTime: ${result.simTime} ≠ ${replayed.simTime}`);
  if (result.ended !== replayed.ended) mismatches.push(`ended: ${result.ended} ≠ ${replayed.ended}`);
  if (!sameData(result.config, replayed.config)) {
    mismatches.push(`config: ${JSON.stringify(result.config)} ≠ ${JSON.stringify(replayed.config)}`);
  }
  mismatches.push(...compareMetrics(result.metrics, replayed.metrics));
  const unplayed = result.commandLog.filter((e) => e.step >= stepsRun).length;
  if (unplayed > 0) mismatches.push(`commandLog: 실행되지 않은 step의 명령 ${unplayed}줄 (실행한 step 수 ${stepsRun})`);
  return { world, matches: mismatches.length === 0, mismatches };
}
