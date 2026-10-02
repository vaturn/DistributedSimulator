// 화면 없이 시뮬레이션을 실행하는 CLI 진입점 (make sim, make compare).
// node API(fs, process)는 이 파일에서만 쓴다. 핵심 로직은 runCli.ts에 있다.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { USAGE, isArgsError, parseArgs } from "./args";
import { type CliIo, EXIT_UNSUPPORTED, runCli } from "./runCli";

const nodeIo: CliIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content, "utf8"),
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

function main(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  if (isArgsError(parsed)) {
    nodeIo.stderr(`오류: ${parsed.error}\n\n${USAGE}`);
    return EXIT_UNSUPPORTED;
  }
  return runCli(parsed, nodeIo);
}

process.exitCode = main(process.argv.slice(2));
