// 화면 없이 시뮬레이션을 실행하는 CLI 진입점 (make sim, make compare, make rules).
// node API(fs, process)는 이 파일에서만 쓴다. 핵심 로직은 runCli.ts에 있다.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { entriesFromRuleModules } from "../supervisor/ruleLoader";
import { USAGE, isArgsError, parseArgs } from "./args";
import { type CliIo, type CliPolicies, EXIT_UNSUPPORTED, cliPolicies, runCli } from "./runCli";

/** 룰 폴더 (저장소 루트의 rules/) */
const RULES_DIR = new URL("../../rules/", import.meta.url);
/** 룰 파일 메시지에 쓰는 경로 앞부분 */
const RULES_DISPLAY_DIR = "rules";

const nodeIo: CliIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** rules/*.ts를 모두 import해서 정책 목록을 만든다. 실패한 파일은 오류로 남기고 나머지는 계속한다. */
async function loadPolicies(): Promise<CliPolicies> {
  let files: string[];
  try {
    files = readdirSync(RULES_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .sort();
  } catch {
    // 룰 폴더가 없으면 내장 정책만 쓴다.
    return cliPolicies();
  }
  const modules: Record<string, unknown> = {};
  const importErrors: string[] = [];
  for (const file of files) {
    const path = `${RULES_DISPLAY_DIR}/${file}`;
    try {
      modules[path] = (await import(new URL(file, RULES_DIR).href)) as unknown;
    } catch (e) {
      importErrors.push(`${path}: 파일을 불러오지 못했습니다 (${errorMessage(e)})`);
    }
  }
  return cliPolicies(entriesFromRuleModules(modules), importErrors);
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (isArgsError(parsed)) {
    nodeIo.stderr(`오류: ${parsed.error}\n\n${USAGE}`);
    return EXIT_UNSUPPORTED;
  }
  return runCli(parsed, nodeIo, await loadPolicies());
}

process.exitCode = await main(process.argv.slice(2));
