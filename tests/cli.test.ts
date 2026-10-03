// CLI 테스트. 인자 파서, 표 형식, 핵심 실행 로직(runCli)을 파일 시스템 없이 검증한다.
import { describe, expect, it } from "vitest";
import { type CliOptions, isArgsError, parseArgs } from "../src/cli/args";
import { displayWidth, formatCompareTable, formatMetricsTable } from "../src/cli/format";
import {
  type CliIo,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_UNSUPPORTED,
  cliPolicies,
  isScenarioPath,
  resultFilePath,
  runCli,
} from "../src/cli/runCli";
import { type RunResult, parseRunResult } from "../src/engine/report";
import type { Metrics } from "../src/engine/types";
import { findScenario } from "../src/scenarios";
import { POLICIES } from "../src/supervisor/registry";
import { BROWSER_RULES } from "../src/supervisor/rules.browser";

/** 메모리 위의 가짜 IO */
function memoryIo(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const dirs: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    readFile: (path) => {
      const content = store.get(path);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    writeFile: (path, content) => {
      store.set(path, content);
    },
    mkdir: (path) => {
      dirs.push(path);
    },
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
  };
  return { io, store, dirs, stdout: () => out.join("\n"), stderr: () => err.join("\n") };
}

function opts(partial: Partial<CliOptions>): CliOptions {
  return { help: false, ...partial };
}

function parsed(argv: string[]): CliOptions {
  const r = parseArgs(argv);
  if (isArgsError(r)) throw new Error(`예상하지 못한 오류: ${r.error}`);
  return r;
}

describe("parseArgs", () => {
  it("모든 옵션을 읽는다", () => {
    expect(parsed(["--scenario", "basic", "--policy", "greedy", "--seed", "42", "--out", "out"])).toEqual({
      help: false,
      scenario: "basic",
      policy: "greedy",
      seed: 42,
      out: "out",
    });
  });

  it("--replay 경로를 읽는다", () => {
    expect(parsed(["--replay", "out/a.json"])).toEqual({ help: false, replay: "out/a.json" });
  });

  it("--키=값 형식과 음수 seed, compare 목록을 읽는다", () => {
    expect(parsed(["--scenario=a.json", "--seed=-3", "--compare", "random, greedy"])).toEqual({
      help: false,
      scenario: "a.json",
      seed: -3,
      compare: ["random", "greedy"],
    });
  });

  it("인자가 없으면 기본값, --help를 읽는다", () => {
    expect(parsed([])).toEqual({ help: false });
    expect(parsed(["--help"]).help).toBe(true);
  });

  it.each([
    [["--unknown", "x"], "알 수 없는 옵션"],
    [["basic"], "알 수 없는 인자"],
    [["--policy"], "값이 필요"],
    [["--policy", "--seed", "1"], "값이 필요"],
    [["--out="], "값이 필요"],
    [["--seed", "1.5"], "정수"],
    [["--seed", "abc"], "정수"],
    [["--seed", "99999999999999999999"], "정수"],
    [["--compare", "a,,b"], "빈 항목"],
    [["--seed", "1", "--seed", "2"], "두 번"],
    [["--help=yes"], "값을 받지 않"],
  ])("오류: %j", (argv, message) => {
    const r = parseArgs(argv);
    expect(isArgsError(r)).toBe(true);
    if (isArgsError(r)) expect(r.error).toContain(message);
  });
});

describe("formatMetricsTable", () => {
  const metrics: Metrics = {
    simTime: 300,
    completedCount: 42,
    spawnedCount: 50,
    throughput: 0.14,
    avgLeadTime: 12.34,
    avgWaitTime: 5.5,
    poolWaitTime: 100,
    queueWaitTime: 20,
    wastedProcessCount: 3,
    uselessProcessCount: 2,
    cancelledProcessCount: 1,
    modules: [
      { id: "MX", utilization: 0.8, busyTime: 240, doneOccupiedTime: 1.5, queueLength: 2 },
      { id: "MY", utilization: 0.25, busyTime: 75, doneOccupiedTime: 0, queueLength: 0 },
    ],
  };

  it("요약 지표와 모듈별 가동률을 포함한다", () => {
    const text = formatMetricsTable(metrics, { scenario: "sc", policy: "pol", seed: 7 });
    expect(text).toContain("시나리오: sc");
    expect(text).toContain("정책: pol");
    expect(text).toContain("시드: 7");
    expect(text).toContain("300.0s");
    expect(text).toContain("42");
    expect(text).toContain("0.140/s");
    expect(text).toContain("12.3s");
    expect(text).toMatch(/MX\s+80%\s+1\.5s\s+2/);
    expect(text).toMatch(/MY\s+25%\s+0\.0s\s+0/);
  });

  it("완료 작업이 없으면 평균은 '-'", () => {
    const text = formatMetricsTable({ ...metrics, avgLeadTime: null, avgWaitTime: null });
    expect(text).toMatch(/평균 소요\s+-/);
    expect(text).not.toContain("시나리오:");
  });

  it("모듈 표의 열이 한글 폭을 고려해 맞춰진다", () => {
    const lines = formatMetricsTable(metrics).split("\n");
    const header = lines.find((l) => l.includes("가동률")) ?? "";
    const row = lines.find((l) => l.includes("MX")) ?? "";
    expect(displayWidth(header)).toBe(displayWidth(row));
  });
});

describe("runCli 보조 함수", () => {
  it("isScenarioPath: .json 또는 경로 구분자가 있으면 파일", () => {
    expect(isScenarioPath("basic")).toBe(false);
    expect(isScenarioPath("my.json")).toBe(true);
    expect(isScenarioPath("dir/file")).toBe(true);
  });

  it("resultFilePath: <out>/<scenario>-<policy>-<seed>.json", () => {
    expect(resultFilePath("out", "basic", "greedy", 42)).toBe("out/basic-greedy-42.json");
    expect(resultFilePath("out/", "a b", "p", 1)).toBe("out/a_b-p-1.json");
  });
});

describe("runCli", () => {
  it("basic + greedy: 지표 표를 출력하고 작업을 완료한다", () => {
    const m = memoryIo();
    const code = runCli(opts({ scenario: "basic", policy: "greedy", seed: 42 }), m.io);
    expect(code).toBe(EXIT_OK);
    expect(m.stderr()).toBe("");
    const out = m.stdout();
    expect(out).toContain("시나리오: basic");
    expect(out).toContain("정책: greedy");
    const completed = /완료\s+(\d+)/.exec(out);
    expect(Number(completed?.[1])).toBeGreaterThan(0);
    expect(m.store.size).toBe(0);
  });

  it("--out이 있으면 결과 JSON을 저장하고 경로를 출력한다", () => {
    const m = memoryIo();
    const code = runCli(opts({ scenario: "basic", policy: "greedy", seed: 42, out: "res" }), m.io);
    expect(code).toBe(EXIT_OK);
    expect(m.dirs).toEqual(["res"]);
    const saved = m.store.get("res/basic-greedy-42.json");
    expect(saved).toBeDefined();
    expect(() => JSON.parse(saved ?? "")).not.toThrow();
    expect(m.stdout()).toContain("res/basic-greedy-42.json");
  });

  it("같은 입력이면 같은 결과 (결정성)", () => {
    const a = memoryIo();
    const b = memoryIo();
    runCli(opts({ scenario: "basic", policy: "greedy", seed: 7, out: "o" }), a.io);
    runCli(opts({ scenario: "basic", policy: "greedy", seed: 7, out: "o" }), b.io);
    expect(a.stdout()).toBe(b.stdout());
    expect(a.store.get("o/basic-greedy-7.json")).toBe(b.store.get("o/basic-greedy-7.json"));
  });

  it("seed를 생략하면 시나리오의 seed를 쓴다", () => {
    const m = memoryIo();
    runCli(opts({ scenario: "basic", policy: "greedy" }), m.io);
    expect(m.stdout()).toContain(`시드: ${findScenario("basic")?.scenario.seed}`);
  });

  it("등록된 모든 정책이 실행된다", () => {
    for (const p of POLICIES) {
      const m = memoryIo();
      expect(runCli(opts({ scenario: "basic", policy: p.name, seed: 1 }), m.io)).toBe(EXIT_OK);
    }
  });

  it("없는 정책: 사용 가능한 목록과 함께 오류, 종료 코드 1", () => {
    const m = memoryIo();
    const code = runCli(opts({ scenario: "basic", policy: "nope" }), m.io);
    expect(code).toBe(EXIT_ERROR);
    expect(m.stderr()).toContain("정책을 찾을 수 없습니다: nope");
    for (const p of POLICIES) expect(m.stderr()).toContain(p.name);
    expect(m.stdout()).toBe("");
  });

  it("없는 시나리오: 사용 가능한 목록과 함께 오류, 종료 코드 1", () => {
    const m = memoryIo();
    const code = runCli(opts({ scenario: "nope", policy: "greedy" }), m.io);
    expect(code).toBe(EXIT_ERROR);
    expect(m.stderr()).toContain("시나리오를 찾을 수 없습니다: nope");
    expect(m.stderr()).toContain("basic");
  });

  it("시나리오 파일 경로를 읽어 실행한다", () => {
    const scenario = findScenario("basic")?.scenario;
    const m = memoryIo({ "my/sc.json": JSON.stringify({ ...scenario, name: "custom" }) });
    const code = runCli(opts({ scenario: "my/sc.json", policy: "greedy", seed: 3 }), m.io);
    expect(code).toBe(EXIT_OK);
    expect(m.stdout()).toContain("시나리오: custom");
  });

  it("없는 파일, 잘못된 JSON, 잘못된 형식은 오류", () => {
    const m = memoryIo({ "bad.json": "{", "wrong.json": JSON.stringify({ name: "x" }) });
    expect(runCli(opts({ scenario: "missing.json", policy: "greedy" }), m.io)).toBe(EXIT_ERROR);
    expect(runCli(opts({ scenario: "bad.json", policy: "greedy" }), m.io)).toBe(EXIT_ERROR);
    expect(runCli(opts({ scenario: "wrong.json", policy: "greedy" }), m.io)).toBe(EXIT_ERROR);
    expect(m.stderr()).toContain("읽지 못했습니다");
    expect(m.stderr()).toContain("올바르지 않습니다");
  });

  it("--scenario나 --policy가 없으면 오류", () => {
    expect(runCli(opts({ policy: "greedy" }), memoryIo().io)).toBe(EXIT_ERROR);
    expect(runCli(opts({ scenario: "basic" }), memoryIo().io)).toBe(EXIT_ERROR);
  });

  it("--help는 사용법을 출력한다", () => {
    const m = memoryIo();
    expect(runCli(opts({ help: true }), m.io)).toBe(EXIT_OK);
    expect(m.stdout()).toContain("사용법");
  });
});

describe("formatCompareTable", () => {
  const base: Metrics = {
    simTime: 300,
    completedCount: 42,
    spawnedCount: 50,
    throughput: 0.14,
    avgLeadTime: 12.34,
    avgWaitTime: 5.5,
    poolWaitTime: 100,
    queueWaitTime: 20,
    wastedProcessCount: 3,
    uselessProcessCount: 2,
    cancelledProcessCount: 1,
    modules: [
      { id: "MX", utilization: 0.8, busyTime: 240, doneOccupiedTime: 1.5, queueLength: 2 },
      { id: "MY", utilization: 0.25, busyTime: 75, doneOccupiedTime: 0, queueLength: 0 },
    ],
  };
  const other: Metrics = {
    ...base,
    completedCount: 30,
    avgLeadTime: null,
    modules: [
      { id: "MX", utilization: 0.5, busyTime: 150, doneOccupiedTime: 0, queueLength: 0 },
      { id: "MY", utilization: 0.1, busyTime: 30, doneOccupiedTime: 4, queueLength: 0 },
    ],
  };

  it("행은 지표, 열은 정책이고 모듈별 가동률·점유 낭비를 포함한다", () => {
    const text = formatCompareTable(
      [
        { policy: "p1", metrics: base },
        { policy: "p2", metrics: other },
      ],
      { scenario: "sc", seed: 7 },
    );
    expect(text).toContain("시나리오: sc  시드: 7  정책: p1, p2");
    expect(text).toMatch(/지표\s+p1\s+p2/);
    expect(text).toMatch(/완료\s+42\s+30/);
    expect(text).toMatch(/평균 소요\s+12\.3s\s+-/);
    expect(text).toMatch(/가동률 MX\s+80%\s+50%/);
    expect(text).toMatch(/가동률 MY\s+25%\s+10%/);
    expect(text).toMatch(/점유 낭비 MY\s+0\.0s\s+4\.0s/);
  });

  it("열이 한글 폭을 고려해 맞춰진다", () => {
    const lines = formatCompareTable([
      { policy: "p1", metrics: base },
      { policy: "p2", metrics: other },
    ]).split("\n");
    const widths = new Set(lines.map((l) => displayWidth(l)));
    expect(widths.size).toBe(1);
  });
});

describe("runCli --compare", () => {
  const names = POLICIES.map((p) => p.name);

  it("모든 정책이 표에 나오고, 각 열은 같은 seed의 단독 실행과 같다", () => {
    const m = memoryIo();
    expect(runCli(opts({ scenario: "basic", compare: names, seed: 42 }), m.io)).toBe(EXIT_OK);
    expect(m.stderr()).toBe("");
    const out = m.stdout();
    expect(out).toContain(`정책: ${names.join(", ")}`);
    expect(out).toMatch(new RegExp(`지표\\s+${names.join("\\s+")}`));
    const completedRow = /^완료\s+(.*)$/m.exec(out)?.[1]?.trim().split(/\s+/) ?? [];
    expect(completedRow).toHaveLength(names.length);
    names.forEach((name, i) => {
      const single = memoryIo();
      runCli(opts({ scenario: "basic", policy: name, seed: 42 }), single.io);
      const completed = /완료\s+(\d+)/.exec(single.stdout())?.[1];
      expect(completedRow[i]).toBe(completed);
    });
    expect(m.store.size).toBe(0);
  });

  it("--out이 있으면 정책별 결과 JSON과 비교 요약을 저장하고, 결과는 단독 sim과 같다", () => {
    const m = memoryIo();
    expect(runCli(opts({ scenario: "basic", compare: names, seed: 42, out: "res" }), m.io)).toBe(EXIT_OK);
    for (const name of names) {
      const path = `res/basic-${name}-42.json`;
      expect(m.stdout()).toContain(path);
      const single = memoryIo();
      runCli(opts({ scenario: "basic", policy: name, seed: 42, out: "res" }), single.io);
      expect(m.store.get(path)).toBe(single.store.get(path));
      expect(() => parseRunResult(JSON.parse(m.store.get(path) ?? "") as unknown)).not.toThrow();
    }
    const summary = JSON.parse(m.store.get("res/basic-compare-42.json") ?? "{}") as {
      scenario: string;
      seed: number;
      policies: { policy: string; metrics: Metrics }[];
    };
    expect(summary.scenario).toBe("basic");
    expect(summary.seed).toBe(42);
    expect(summary.policies.map((p) => p.policy)).toEqual(names);
    const greedy = parseRunResult(JSON.parse(m.store.get("res/basic-greedy-42.json") ?? "") as unknown);
    expect(summary.policies.find((p) => p.policy === "greedy")?.metrics).toEqual(greedy.metrics);
    expect(m.store.size).toBe(names.length + 1);
  });

  it("없는 정책이 섞이면 실행 전 오류, 종료 코드 1", () => {
    const m = memoryIo();
    const code = runCli(opts({ scenario: "basic", compare: ["greedy", "nope", "zzz"], out: "res" }), m.io);
    expect(code).toBe(EXIT_ERROR);
    expect(m.stderr()).toContain("정책을 찾을 수 없습니다: nope, zzz");
    expect(m.stdout()).toBe("");
    expect(m.store.size).toBe(0);
  });

  it("같은 정책이 두 번이면 오류", () => {
    const m = memoryIo();
    expect(runCli(opts({ scenario: "basic", compare: ["greedy", "greedy"] }), m.io)).toBe(EXIT_ERROR);
    expect(m.stderr()).toContain("두 번");
  });

  it("--policy와 함께 쓰거나 --scenario가 없으면 오류", () => {
    expect(runCli(opts({ scenario: "basic", policy: "greedy", compare: names }), memoryIo().io)).toBe(EXIT_UNSUPPORTED);
    expect(runCli(opts({ compare: names }), memoryIo().io)).toBe(EXIT_ERROR);
  });
});

describe("runCli --replay", () => {
  /** basic + greedy 결과를 저장한 메모리 IO */
  function saved() {
    const m = memoryIo();
    runCli(opts({ scenario: "basic", policy: "greedy", seed: 42, out: "res" }), m.io);
    const path = "res/basic-greedy-42.json";
    const text = m.store.get(path) ?? "";
    return { path, text, result: JSON.parse(text) as RunResult };
  }

  it("저장한 결과를 재생하면 일치, 지표 표를 출력한다", () => {
    const { path, text } = saved();
    const m = memoryIo({ [path]: text });
    expect(runCli(opts({ replay: path }), m.io)).toBe(EXIT_OK);
    expect(m.stderr()).toBe("");
    expect(m.stdout()).toContain(`리플레이: ${path}`);
    expect(m.stdout()).toContain("정책: greedy");
    expect(m.stdout()).toContain("일치");
    expect(m.stdout()).toMatch(/완료\s+\d+/);
  });

  it("명령 로그를 변조하면 불일치 목록과 종료 코드 1", () => {
    const { path, result } = saved();
    const tampered = { ...result, commandLog: result.commandLog.slice(1) };
    const m = memoryIo({ [path]: JSON.stringify(tampered) });
    expect(runCli(opts({ replay: path }), m.io)).toBe(EXIT_ERROR);
    expect(m.stderr()).toContain("불일치");
    expect(m.stderr()).toMatch(/metrics\.\w+: .+ ≠ .+/);
  });

  it("다른 인자와 함께 쓰면 인자 오류", () => {
    const { path, text } = saved();
    for (const extra of [{ scenario: "basic" }, { policy: "greedy" }, { seed: 1 }, { compare: ["greedy"] }]) {
      const m = memoryIo({ [path]: text });
      expect(runCli(opts({ replay: path, ...extra }), m.io)).toBe(EXIT_UNSUPPORTED);
      expect(m.stderr()).toContain("함께 쓸 수 없습니다");
    }
  });

  it("없는 파일, 잘못된 JSON, 잘못된 형식은 오류", () => {
    const m = memoryIo({ "bad.json": "{", "v1.json": JSON.stringify({ ...saved().result, version: 1 }) });
    expect(runCli(opts({ replay: "missing.json" }), m.io)).toBe(EXIT_ERROR);
    expect(runCli(opts({ replay: "bad.json" }), m.io)).toBe(EXIT_ERROR);
    expect(runCli(opts({ replay: "v1.json" }), m.io)).toBe(EXIT_ERROR);
    expect(m.stderr()).toContain("읽지 못했습니다");
    expect(m.stderr()).toContain("올바르지 않습니다");
    expect(m.stderr()).toContain("version");
  });
});

describe("rules/ 룰 정책 (--policy, --compare, --list)", () => {
  const withRules = () => cliPolicies(BROWSER_RULES);

  it("--list 파싱: 값 없이 한 번만", () => {
    expect(parsed(["--list"])).toEqual({ help: false, list: true });
    expect(parseArgs(["--list=1"])).toEqual({ error: "--list는 값을 받지 않습니다." });
    expect(isArgsError(parseArgs(["--list", "--list"]))).toBe(true);
  });

  it("룰 이름으로 단독 실행과 비교를 한다", () => {
    const single = memoryIo();
    expect(runCli(opts({ scenario: "basic", policy: "fastest", seed: 42 }), single.io, withRules())).toBe(EXIT_OK);
    expect(single.stdout()).toContain("fastest");
    expect(single.stderr()).toBe("");

    const cmp = memoryIo();
    expect(
      runCli(opts({ scenario: "basic", compare: ["random", "greedy", "fastest"], seed: 42 }), cmp.io, withRules()),
    ).toBe(EXIT_OK);
    expect(cmp.stdout()).toContain("fastest");
  });

  it("같은 seed면 룰 실행 결과 파일이 같다", () => {
    const a = memoryIo();
    const b = memoryIo();
    runCli(opts({ scenario: "basic", policy: "fastest", seed: 3, out: "o" }), a.io, withRules());
    runCli(opts({ scenario: "basic", policy: "fastest", seed: 3, out: "o" }), b.io, withRules());
    const path = resultFilePath("o", "basic", "fastest", 3);
    expect(a.store.get(path)).toBeDefined();
    expect(a.store.get(path)).toBe(b.store.get(path));
  });

  it("룰을 넘기지 않으면 내장 정책만 있어 룰 이름을 찾지 못한다", () => {
    const m = memoryIo();
    expect(runCli(opts({ scenario: "basic", policy: "fastest" }), m.io)).toBe(EXIT_ERROR);
    expect(m.stderr()).toContain("정책을 찾을 수 없습니다");
  });

  it("룰 로드 오류는 경고로 알리고 실행은 계속한다", () => {
    const policies = cliPolicies({ entries: BROWSER_RULES.entries, errors: ["rules/bad.ts: 형식 오류"] }, [
      "rules/broken.ts: 파일을 불러오지 못했습니다",
    ]);
    const m = memoryIo();
    expect(runCli(opts({ scenario: "basic", policy: "fastest", seed: 1 }), m.io, policies)).toBe(EXIT_OK);
    expect(m.stderr()).toContain("경고: 룰을 불러오지 못했습니다: rules/broken.ts");
    expect(m.stderr()).toContain("rules/bad.ts: 형식 오류");
  });

  it("--list는 정책 목록을 출력하고, 룰 로드 오류가 있으면 오류 코드", () => {
    const ok = memoryIo();
    expect(runCli(opts({ list: true }), ok.io, withRules())).toBe(EXIT_OK);
    for (const name of ["random", "greedy", "fastest", "rules/fastestModule.ts"]) expect(ok.stdout()).toContain(name);

    const bad = memoryIo();
    const policies = cliPolicies(BROWSER_RULES, ["rules/broken.ts: 파일을 불러오지 못했습니다"]);
    expect(runCli(opts({ list: true }), bad.io, policies)).toBe(EXIT_ERROR);
    expect(bad.stdout()).toContain("fastest");
    expect(bad.stderr()).toContain("rules/broken.ts");

    expect(runCli(opts({ list: true, scenario: "basic" }), memoryIo().io)).toBe(EXIT_UNSUPPORTED);
  });
});
