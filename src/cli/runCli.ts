// CLI 핵심 로직. node API(fs, path, process)를 직접 쓰지 않고 CliIo로 받는다.
// 그래서 테스트에서 파일 시스템 없이 돌릴 수 있다. 진입점은 run.ts.

import { computeMetrics } from "../engine/metrics";
import { buildRunResult, serializeRunResult } from "../engine/report";
import { runHeadless } from "../engine/runner";
import { parseScenario } from "../engine/scenario";
import type { Scenario } from "../engine/types";
import { SCENARIOS, findScenario } from "../scenarios";
import { POLICIES, findPolicy } from "../supervisor/registry";
import { type CliOptions, USAGE } from "./args";
import { formatMetricsTable } from "./format";

/** 종료 코드 */
export const EXIT_OK = 0;
/** 입력 오류 (없는 시나리오/정책, 잘못된 파일 등) */
export const EXIT_ERROR = 1;
/** 아직 지원하지 않는 기능, 인자 형식 오류 */
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

function policyList(): string {
  return POLICIES.map((p) => p.name).join(", ");
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

/** CLI를 실행하고 종료 코드를 돌려준다. */
export function runCli(options: Readonly<CliOptions>, io: CliIo): number {
  if (options.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (options.compare !== undefined) {
    io.stderr("오류: --compare(여러 정책 비교)는 M6에서 지원 예정입니다.");
    return EXIT_UNSUPPORTED;
  }
  if (options.scenario === undefined) {
    io.stderr(`오류: --scenario가 필요합니다.\n사용 가능한 시나리오: ${scenarioList()}`);
    return EXIT_ERROR;
  }
  if (options.policy === undefined) {
    io.stderr(`오류: --policy가 필요합니다.\n사용 가능한 정책: ${policyList()}`);
    return EXIT_ERROR;
  }

  const policy = findPolicy(options.policy);
  if (!policy) {
    io.stderr(`오류: 정책을 찾을 수 없습니다: ${options.policy}\n사용 가능한 정책: ${policyList()}`);
    return EXIT_ERROR;
  }
  const loaded = loadScenario(options.scenario, io);
  if ("error" in loaded) {
    io.stderr(`오류: ${loaded.error}`);
    return EXIT_ERROR;
  }
  const scenario = loaded;
  const seed = options.seed ?? scenario.seed;

  const { world, commandLog } = runHeadless(scenario, policy.create(seed), { seed });
  const metrics = computeMetrics(world);
  io.stdout(formatMetricsTable(metrics, { scenario: scenario.name, policy: policy.name, seed }));

  if (options.out !== undefined) {
    const result = buildRunResult(world, { scenario: scenario.name, policy: policy.name, seed, commandLog });
    const path = resultFilePath(options.out, scenario.name, policy.name, seed);
    try {
      io.mkdir(options.out);
      io.writeFile(path, serializeRunResult(result));
    } catch (e) {
      io.stderr(`오류: 결과 파일을 쓰지 못했습니다: ${path} (${errorMessage(e)})`);
      return EXIT_ERROR;
    }
    io.stdout(`\n결과 저장: ${path}`);
  }
  return EXIT_OK;
}
