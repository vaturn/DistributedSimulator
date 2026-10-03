// CLI 핵심 로직. node API(fs, path, process)를 직접 쓰지 않고 CliIo로 받는다.
// 그래서 테스트에서 파일 시스템 없이 돌릴 수 있다. 진입점은 run.ts.

import { computeMetrics } from "../engine/metrics";
import { type RunResult, buildRunResult, parseRunResult, replayRun, serializeRunResult } from "../engine/report";
import { runHeadless } from "../engine/runner";
import { parseScenario } from "../engine/scenario";
import type { Metrics, Scenario } from "../engine/types";
import { SCENARIOS, findScenario } from "../scenarios";
import { type PolicyEntry, type PolicyRegistry, createRegistry } from "../supervisor/registry";
import type { LoadedRules } from "../supervisor/ruleLoader";
import { type CliOptions, USAGE } from "./args";
import { formatCompareTable, formatMetricsTable, formatRows } from "./format";

/** 종료 코드 */
export const EXIT_OK = 0;
/** 입력 오류 (없는 시나리오/정책, 잘못된 파일 등) */
export const EXIT_ERROR = 1;
/** 인자 형식 오류, 함께 쓸 수 없는 인자 조합 */
export const EXIT_UNSUPPORTED = 2;

/** CLI가 바깥 세계와 주고받는 통로 */
export interface CliIo {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  /** 디렉터리를 만든다 (이미 있으면 그대로, 상위 디렉터리도 만든다) */
  mkdir(path: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** 비교 요약 파일 형식 버전 */
export const COMPARE_SUMMARY_VERSION = 1;

/** 비교 요약 파일(<scenario>-compare-<seed>.json) 내용 */
export interface CompareSummary {
  version: typeof COMPARE_SUMMARY_VERSION;
  scenario: string;
  seed: number;
  /** --compare에 준 순서대로 */
  policies: { policy: string; metrics: Metrics }[];
}

/** 비교 요약 파일 이름에 쓰는 정책 자리 */
const COMPARE_FILE_PART = "compare";
/** JSON 들여쓰기 칸 수 */
const JSON_INDENT = 2;
/** --replay와 함께 쓸 수 없는 옵션 */
const REPLAY_EXCLUSIVE = ["scenario", "policy", "seed", "compare", "out"] as const;

/** --list와 함께 쓸 수 없는 옵션 */
const LIST_EXCLUSIVE = ["scenario", "policy", "seed", "compare", "replay", "out"] as const;

/** CLI가 쓰는 정책 목록과 룰 로드 오류 */
export interface CliPolicies {
  registry: PolicyRegistry;
  /** 불러오지 못한 룰과 이유 (파일 import 실패, 형식 오류, 이름 충돌) */
  errors: readonly string[];
}

/**
 * 룰 로드 결과로 CLI 정책 목록을 만든다.
 * importErrors: 파일을 import하지 못한 오류 (모듈 수집은 진입점 run.ts가 node로 한다)
 */
export function cliPolicies(loaded?: Readonly<LoadedRules>, importErrors: readonly string[] = []): CliPolicies {
  const registry = createRegistry(loaded?.entries ?? []);
  return { registry, errors: [...importErrors, ...(loaded?.errors ?? []), ...registry.errors] };
}

/** 시나리오 인자가 이름이 아니라 파일 경로인지 */
export function isScenarioPath(arg: string): boolean {
  return arg.endsWith(".json") || arg.includes("/") || arg.includes("\\");
}

/** 파일 이름에 쓸 수 없는 문자를 바꾼다 */
function safeFilePart(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 결과 JSON 파일 경로: <out>/<scenario>-<policy>-<seed>.json */
export function resultFilePath(out: string, scenario: string, policy: string, seed: number): string {
  const dir = out.replace(/[/\\]+$/, "") || out;
  return `${dir}/${safeFilePart(scenario)}-${safeFilePart(policy)}-${seed}.json`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function scenarioList(): string {
  return SCENARIOS.map((s) => s.name).join(", ");
}

function policyList(policies: CliPolicies): string {
  return policies.registry.policies.map((p) => p.name).join(", ");
}

/** 룰 로드 오류를 경고로 알린다 (실행은 계속한다) */
function warnRuleErrors(policies: CliPolicies, io: CliIo): void {
  for (const e of policies.errors) io.stderr(`경고: 룰을 불러오지 못했습니다: ${e}`);
}

/** 시나리오 인자를 Scenario로 바꾼다. 실패하면 오류 메시지 */
function loadScenario(arg: string, io: CliIo): Scenario | { error: string } {
  if (isScenarioPath(arg)) {
    let text: string;
    try {
      text = io.readFile(arg);
    } catch (e) {
      return { error: `시나리오 파일을 읽지 못했습니다: ${arg} (${errorMessage(e)})` };
    }
    try {
      return parseScenario(JSON.parse(text) as unknown);
    } catch (e) {
      return { error: `시나리오 파일이 올바르지 않습니다: ${arg}\n${errorMessage(e)}` };
    }
  }
  const entry = findScenario(arg);
  if (!entry) {
    return { error: `시나리오를 찾을 수 없습니다: ${arg}\n사용 가능한 시나리오: ${scenarioList()}` };
  }
  return entry.scenario;
}

/** 정책 하나를 실행한 결과 */
interface PolicyRun {
  policy: string;
  metrics: Metrics;
  result: RunResult;
}

/** 시나리오를 정책 하나로 화면 없이 실행한다 (단독 실행과 비교가 같은 경로를 쓴다). */
function runPolicy(scenario: Scenario, policy: PolicyEntry, seed: number): PolicyRun {
  const { world, commandLog } = runHeadless(scenario, policy.create(seed), { seed });
  const metrics = computeMetrics(world);
  const result = buildRunResult(world, {
    scenario: scenario.name,
    policy: policy.name,
    seed,
    scenarioSpec: scenario,
    commandLog,
  });
  return { policy: policy.name, metrics, result };
}

/** out 디렉터리에 파일들을 쓴다. 실패하면 오류를 알리고 false */
function writeFiles(out: string, files: readonly { path: string; content: string }[], io: CliIo): boolean {
  for (const f of files) {
    try {
      io.mkdir(out);
      io.writeFile(f.path, f.content);
    } catch (e) {
      io.stderr(`오류: 결과 파일을 쓰지 못했습니다: ${f.path} (${errorMessage(e)})`);
      return false;
    }
  }
  return true;
}

/** --scenario를 확인하고 읽는다. 실패하면 오류를 알리고 null */
function requireScenario(options: Readonly<CliOptions>, io: CliIo): Scenario | null {
  if (options.scenario === undefined) {
    io.stderr(`오류: --scenario가 필요합니다.\n사용 가능한 시나리오: ${scenarioList()}`);
    return null;
  }
  const loaded = loadScenario(options.scenario, io);
  if ("error" in loaded) {
    io.stderr(`오류: ${loaded.error}`);
    return null;
  }
  return loaded;
}

/** 정책 하나 실행 (--policy) */
function runSingle(options: Readonly<CliOptions>, io: CliIo, policies: CliPolicies): number {
  if (options.scenario === undefined) {
    io.stderr(`오류: --scenario가 필요합니다.\n사용 가능한 시나리오: ${scenarioList()}`);
    return EXIT_ERROR;
  }
  if (options.policy === undefined) {
    io.stderr(`오류: --policy가 필요합니다.\n사용 가능한 정책: ${policyList(policies)}`);
    return EXIT_ERROR;
  }
  const policy = policies.registry.find(options.policy);
  if (!policy) {
    io.stderr(`오류: 정책을 찾을 수 없습니다: ${options.policy}\n사용 가능한 정책: ${policyList(policies)}`);
    return EXIT_ERROR;
  }
  const scenario = requireScenario(options, io);
  if (!scenario) return EXIT_ERROR;
  const seed = options.seed ?? scenario.seed;

  const run = runPolicy(scenario, policy, seed);
  io.stdout(formatMetricsTable(run.metrics, { scenario: scenario.name, policy: policy.name, seed }));

  if (options.out !== undefined) {
    const path = resultFilePath(options.out, scenario.name, policy.name, seed);
    if (!writeFiles(options.out, [{ path, content: serializeRunResult(run.result) }], io)) return EXIT_ERROR;
    io.stdout(`\n결과 저장: ${path}`);
  }
  return EXIT_OK;
}

/** 여러 정책 비교 (--compare). 정책을 모두 확인한 뒤에 실행한다. */
function runCompare(names: readonly string[], options: Readonly<CliOptions>, io: CliIo, policies: CliPolicies): number {
  const find = (name: string): PolicyEntry | undefined => policies.registry.find(name);
  if (options.policy !== undefined) {
    io.stderr("오류: --compare와 --policy는 함께 쓸 수 없습니다.");
    return EXIT_UNSUPPORTED;
  }
  const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicated.length > 0) {
    io.stderr(`오류: --compare에 같은 정책이 두 번 있습니다: ${[...new Set(duplicated)].join(", ")}`);
    return EXIT_ERROR;
  }
  const missing = names.filter((n) => !find(n));
  if (missing.length > 0) {
    io.stderr(`오류: 정책을 찾을 수 없습니다: ${missing.join(", ")}\n사용 가능한 정책: ${policyList(policies)}`);
    return EXIT_ERROR;
  }
  const selected = names.map(find).filter((p): p is PolicyEntry => p !== undefined);
  const scenario = requireScenario(options, io);
  if (!scenario) return EXIT_ERROR;
  const seed = options.seed ?? scenario.seed;

  const runs = selected.map((p) => runPolicy(scenario, p, seed));
  io.stdout(formatCompareTable(runs, { scenario: scenario.name, seed }));

  if (options.out !== undefined) {
    const out = options.out;
    const summary: CompareSummary = {
      version: COMPARE_SUMMARY_VERSION,
      scenario: scenario.name,
      seed,
      policies: runs.map((r) => ({ policy: r.policy, metrics: r.metrics })),
    };
    const files = [
      ...runs.map((r) => ({
        path: resultFilePath(out, scenario.name, r.policy, seed),
        content: serializeRunResult(r.result),
      })),
      {
        path: resultFilePath(out, scenario.name, COMPARE_FILE_PART, seed),
        content: JSON.stringify(summary, null, JSON_INDENT),
      },
    ];
    if (!writeFiles(out, files, io)) return EXIT_ERROR;
    io.stdout("");
    for (const f of files) io.stdout(`결과 저장: ${f.path}`);
  }
  return EXIT_OK;
}

/** 결과 JSON의 명령 로그 재생 (--replay) */
function runReplay(file: string, options: Readonly<CliOptions>, io: CliIo): number {
  const conflicts = REPLAY_EXCLUSIVE.filter((k) => options[k] !== undefined);
  if (conflicts.length > 0) {
    io.stderr(`오류: --replay는 ${conflicts.map((k) => `--${k}`).join(", ")}와 함께 쓸 수 없습니다.`);
    return EXIT_UNSUPPORTED;
  }
  let text: string;
  try {
    text = io.readFile(file);
  } catch (e) {
    io.stderr(`오류: 결과 파일을 읽지 못했습니다: ${file} (${errorMessage(e)})`);
    return EXIT_ERROR;
  }
  let result: RunResult;
  try {
    result = parseRunResult(JSON.parse(text) as unknown);
  } catch (e) {
    io.stderr(`오류: 결과 파일이 올바르지 않습니다: ${file}\n${errorMessage(e)}`);
    return EXIT_ERROR;
  }

  const replay = replayRun(result);
  io.stdout(`리플레이: ${file} (명령 로그 ${result.commandLog.length}줄)`);
  io.stdout(formatMetricsTable(computeMetrics(replay.world), result));
  if (replay.matches) {
    io.stdout("\n일치: 저장된 결과와 재실행 결과가 같습니다.");
    return EXIT_OK;
  }
  io.stderr(`불일치: 저장된 결과와 재실행 결과가 다릅니다 (${replay.mismatches.length}건, 저장값 ≠ 재실행값)`);
  for (const m of replay.mismatches) io.stderr(`  ${m}`);
  return EXIT_ERROR;
}

/** 정책 목록과 룰 로드 오류 출력 (--list). 오류가 있으면 EXIT_ERROR */
function runList(options: Readonly<CliOptions>, io: CliIo, policies: CliPolicies): number {
  const conflicts = LIST_EXCLUSIVE.filter((k) => options[k] !== undefined);
  if (conflicts.length > 0) {
    io.stderr(`오류: --list는 ${conflicts.map((k) => `--${k}`).join(", ")}와 함께 쓸 수 없습니다.`);
    return EXIT_UNSUPPORTED;
  }
  const rows = [["이름", "표시 이름", "파일"], ...policies.registry.policies.map((p) => [p.name, p.label, p.source ?? "-"])];
  io.stdout(`정책 ${policies.registry.policies.length}개`);
  io.stdout(formatRows(rows).join("\n"));
  if (policies.errors.length === 0) return EXIT_OK;
  io.stderr(`\n룰 로드 오류 ${policies.errors.length}건:`);
  for (const e of policies.errors) io.stderr(`  ${e}`);
  return EXIT_ERROR;
}

/**
 * CLI를 실행하고 종료 코드를 돌려준다.
 * policies: 정책 목록. 생략하면 내장 정책만 쓴다(rules/ 폴더 수집은 진입점 run.ts가 해서 넘긴다).
 */
export function runCli(options: Readonly<CliOptions>, io: CliIo, policies: CliPolicies = cliPolicies()): number {
  if (options.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (options.list) return runList(options, io, policies);
  if (options.replay !== undefined) return runReplay(options.replay, options, io);
  warnRuleErrors(policies, io);
  if (options.compare !== undefined) return runCompare(options.compare, options, io, policies);
  return runSingle(options, io, policies);
}
