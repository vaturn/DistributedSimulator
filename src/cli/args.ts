// CLI 인자 파서 (순수 함수). node API를 쓰지 않는다.
// 지원 인자: --scenario, --policy, --seed, --compare, --replay, --out, --list, --help (`--키 값` 또는 `--키=값`)

/** 파싱된 CLI 옵션 */
export interface CliOptions {
  /** 시나리오 이름 또는 .json 파일 경로 */
  scenario?: string;
  /** 정책 이름 (supervisor/registry) */
  policy?: string;
  /** 시드. 생략하면 시나리오의 seed */
  seed?: number;
  /** 비교할 정책 목록 (M6) */
  compare?: string[];
  /** 재생할 결과 JSON 파일 경로 (M6 리플레이) */
  replay?: string;
  /** 결과 JSON을 저장할 디렉터리 */
  out?: string;
  /** 정책 목록(내장 + rules/)과 룰 로드 오류 출력 (make rules) */
  list?: boolean;
  /** 도움말 출력 */
  help: boolean;
}

export interface ArgsError {
  error: string;
}

/** 값을 받는 옵션 이름 */
const VALUE_OPTIONS = ["scenario", "policy", "seed", "compare", "replay", "out"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

const INTEGER_PATTERN = /^-?\d+$/;

/** 도움말 문자열 */
export const USAGE = [
  "사용법: tsx src/cli/run.ts --scenario <이름|파일.json> --policy <정책> [--seed <정수>] [--out <디렉터리>]",
  "       tsx src/cli/run.ts --scenario <이름|파일.json> --compare <a,b,...> [--seed <정수>] [--out <디렉터리>]",
  "       tsx src/cli/run.ts --replay <결과.json>",
  "       tsx src/cli/run.ts --list",
  "",
  "  --scenario <이름|경로>  시나리오 이름 또는 .json 파일 경로",
  "  --policy <이름>         감독관 정책 이름 (내장 정책 또는 rules/의 룰 이름)",
  "  --seed <정수>           시드 (생략하면 시나리오의 seed)",
  "  --compare <a,b,...>     여러 정책을 같은 시나리오·시드로 실행해 지표 비교 (--policy 대신)",
  "  --replay <결과.json>    결과 JSON의 명령 로그를 재생해 지표가 같은지 확인 (단독으로 쓴다)",
  "  --out <디렉터리>        결과 JSON 저장 위치 (<시나리오>-<정책>-<시드>.json,",
  "                          비교 요약은 <시나리오>-compare-<시드>.json)",
  "  --list                  정책 목록(내장 + rules/)과 룰 로드 오류 출력 (단독으로 쓴다)",
  "  --help                  이 도움말",
].join("\n");

function isValueOption(name: string): name is ValueOption {
  return (VALUE_OPTIONS as readonly string[]).includes(name);
}

/** 정수 문자열 → 안전한 정수. 아니면 null */
function parseSeed(raw: string): number | null {
  if (!INTEGER_PATTERN.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** argv(프로그램 이름 제외)를 옵션으로 바꾼다. 잘못된 입력이면 { error }. */
export function parseArgs(argv: readonly string[]): CliOptions | ArgsError {
  const options: CliOptions = { help: false };
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      return { error: `알 수 없는 인자입니다: ${token}` };
    }
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);

    if (name === "help") {
      if (eq >= 0) return { error: "--help는 값을 받지 않습니다." };
      options.help = true;
      continue;
    }
    if (name === "list") {
      if (eq >= 0) return { error: "--list는 값을 받지 않습니다." };
      if (options.list) return { error: "--list 옵션이 두 번 지정되었습니다." };
      options.list = true;
      continue;
    }
    if (!isValueOption(name)) {
      return { error: `알 수 없는 옵션입니다: --${name}` };
    }
    if (seen.has(name)) {
      return { error: `--${name} 옵션이 두 번 지정되었습니다.` };
    }
    seen.add(name);

    let value: string | undefined;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === "") {
      return { error: `--${name} 옵션에 값이 필요합니다.` };
    }

    switch (name) {
      case "scenario":
        options.scenario = value;
        break;
      case "policy":
        options.policy = value;
        break;
      case "seed": {
        const seed = parseSeed(value);
        if (seed === null) return { error: `--seed는 정수여야 합니다: ${value}` };
        options.seed = seed;
        break;
      }
      case "compare": {
        const list = value.split(",").map((s) => s.trim());
        if (list.some((s) => s === "")) return { error: `--compare 목록에 빈 항목이 있습니다: ${value}` };
        options.compare = list;
        break;
      }
      case "replay":
        options.replay = value;
        break;
      case "out":
        options.out = value;
        break;
    }
  }
  return options;
}

/** parseArgs 결과가 오류인지 */
export function isArgsError(r: CliOptions | ArgsError): r is ArgsError {
  return "error" in r;
}
