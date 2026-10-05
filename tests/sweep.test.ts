// 실험 실행기(sweep) 테스트: 집계, 차이 계산, 표·CSV 형식, 작은 sweep의 결정성, --sweep CLI 경로.
import { describe, expect, it } from "vitest";
import ImmediateRule from "../rules/immediate";
import SequentialRule from "../rules/sequential";
import { parseArgs, isArgsError } from "../src/cli/args";
import { type CliIo, EXIT_ERROR, EXIT_OK, EXIT_UNSUPPORTED, cliPolicies, runCli, sweepFilePath } from "../src/cli/runCli";
import {
  type ExperimentSpec,
  type SweepCase,
  type SweepRow,
  aggregate,
  fmtPct,
  fmtStat,
  formatSweepCsv,
  formatSweepMarkdown,
  parseExperimentSpec,
  policyDiffs,
  relativeDiff,
  runExperiment,
  runSweep,
  stat,
} from "../src/cli/sweep";
import { parseScenario } from "../src/engine/scenario";
import { createRegistry } from "../src/supervisor/registry";
import { ruleEntry } from "../src/supervisor/ruleLoader";

const REGISTRY = createRegistry([
  ruleEntry(SequentialRule, "rules/sequential.ts"),
  ruleEntry(ImmediateRule, "rules/immediate.ts"),
]);

function policy(name: string) {
  const p = REGISTRY.find(name);
  if (!p) throw new Error(name);
  return p;
}

/** A·B 일괄 시나리오 (T_A = T_B = 2, 작업 n개) */
function batchCase(n: number): SweepCase {
  return {
    group: "일괄",
    label: `N=${n}`,
    params: { N: n },
    scenario: parseScenario({
      name: `ab-${n}`,
      seed: 1,
      modules: [
        { id: "MA", resultType: "A", processTime: 2, capacity: 1 },
        { id: "MB", resultType: "B", processTime: 2, capacity: 1 },
      ],
      jobs: { initial: Array.from({ length: n }, () => ({ required: ["A", "B"] })), arrival: { kind: "none" } },
      config: { endCondition: { kind: "allDone" } },
    }),
    seeds: [1],
  };
}

/** 포아송 도착 시나리오 (확률 요소 있음) */
function streamCase(): SweepCase {
  return {
    group: "연속",
    label: "rho=0.8",
    params: { rho: 0.8 },
    scenario: parseScenario({
      name: "ab-stream-small",
      seed: 1,
      modules: [
        { id: "MA", resultType: "A", processTime: 2 },
        { id: "MB", resultType: "B", processTime: 2 },
      ],
      jobs: { initial: [], arrival: { kind: "poisson", rate: 0.4, requiredPool: ["A", "B"], minReq: 2, maxReq: 2 } },
      config: { endCondition: { kind: "time", value: 60 } },
    }),
  };
}

function row(over: Partial<SweepRow>): SweepRow {
  return {
    group: "g",
    label: "c",
    params: {},
    policy: "p",
    seed: 1,
    makespan: 10,
    allDone: true,
    completed: 5,
    spawned: 5,
    throughput: 0.5,
    avgLeadTime: 4,
    avgWaitTime: 1,
    utilization: { M: 0.5 },
    ...over,
  };
}

describe("집계", () => {
  it("stat: 평균과 표본 표준편차, 빈 배열은 null", () => {
    expect(stat([])).toBeNull();
    expect(stat([3])).toEqual({ mean: 3, std: 0, n: 1 });
    const s = stat([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s?.mean).toBe(5);
    expect(s?.std).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it("aggregate: (케이스, 정책)별로 묶고 null 지표는 빼고 평균한다", () => {
    const aggs = aggregate([
      row({ seed: 1, makespan: 10, avgLeadTime: null, utilization: { M: 0.2 } }),
      row({ seed: 2, makespan: 14, avgLeadTime: 6, utilization: { M: 0.4 }, allDone: false }),
      row({ policy: "q", makespan: 1 }),
    ]);
    expect(aggs).toHaveLength(2);
    const p = aggs[0];
    expect(p.policy).toBe("p");
    expect(p.runs).toBe(2);
    expect(p.allDone).toBe(false);
    expect(p.stats.makespan?.mean).toBe(12);
    expect(p.stats.avgLeadTime).toEqual({ mean: 6, std: 0, n: 1 });
    expect(p.utilization.M?.mean).toBeCloseTo(0.3, 12);
    expect(aggs[1].stats.makespan?.mean).toBe(1);
  });

  it("relativeDiff와 policyDiffs: (other − base) / base × 100", () => {
    expect(relativeDiff(40, 42)).toBeCloseTo(5, 12);
    expect(relativeDiff(0, 1)).toBeNull();
    expect(relativeDiff(null, 1)).toBeNull();
    const aggs = aggregate([row({ policy: "base", makespan: 40 }), row({ policy: "other", makespan: 42 })]);
    const [d] = policyDiffs(aggs, "base", "other");
    expect(d.diff.makespan).toBeCloseTo(5, 12);
    expect(d.diff.completed).toBe(0);
  });
});

describe("형식", () => {
  it("fmtStat, fmtPct", () => {
    expect(fmtStat(null)).toBe("-");
    expect(fmtStat({ mean: 2, std: 0, n: 3 })).toBe("2.00");
    expect(fmtStat({ mean: 2, std: 0.5, n: 3 })).toBe("2.00 ± 0.50");
    expect(fmtPct(5)).toBe("+5.0%");
    expect(fmtPct(-2.34)).toBe("-2.3%");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(null)).toBe("-");
  });

  it("markdown: 그룹별 표, 기준 대비 차이, 건너뛴 케이스", () => {
    const aggs = aggregate([
      row({ group: "G1", label: "N=2", params: { N: 2 }, policy: "immediate", makespan: 40 }),
      row({ group: "G1", label: "N=2", params: { N: 2 }, policy: "sequential", makespan: 42 }),
    ]);
    const md = formatSweepMarkdown(
      { rows: [], aggregates: aggs, skipped: [{ group: "G5", label: "b=2", reason: "미지원" }] },
      { name: "t", description: "설명" },
    );
    expect(md).toContain("# 실험 결과: t");
    expect(md).toContain("## G1");
    expect(md).toContain("| N | immediate makespan |");
    expect(md).toContain("makespan 차이(sequential vs immediate)");
    expect(md).toContain("| 2 | 40.00 | 4.00 | 0.50 | 42.00 | 4.00 | 0.50 | +5.0% | 0.0% | 0.0% | 1 |");
    expect(md).toContain("| G5 | b=2 | 미지원 |");
  });

  it("CSV: 머리글, 파라미터 열, 지표 mean/std, 인용", () => {
    const csv = formatSweepCsv(aggregate([row({ label: "a,b", params: { N: 3 }, policy: "p" })]));
    const [header, line] = csv.trimEnd().split("\n");
    expect(header.startsWith("group,label,N,policy,runs,allDone,makespan_mean,makespan_std")).toBe(true);
    expect(header.endsWith("util_M_mean,util_M_std")).toBe(true);
    expect(line.startsWith('g,"a,b",3,p,1,true,10,0,')).toBe(true);
  });
});

describe("runSweep", () => {
  it("이론값: 일괄 N=2 순차 (N+1)T = 6, 즉시 N·T = 4", () => {
    const rows = runSweep([batchCase(2)], [policy("sequential"), policy("immediate")], [1, 2, 3]);
    // 케이스의 seeds([1])가 실험 seeds를 덮어쓴다
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.allDone && r.completed === 2)).toBe(true);
    expect(rows[0].makespan).toBeCloseTo(6, 6);
    expect(rows[1].makespan).toBeCloseTo(4, 6);
  });

  it("같은 입력이면 같은 결과 (결정성), 시드마다 한 행", () => {
    const cases = [batchCase(3), streamCase()];
    const policies = [policy("sequential"), policy("immediate")];
    const a = runExperiment(cases, policies, [1, 2]);
    const b = runExperiment(cases, policies, [1, 2]);
    expect(a).toEqual(b);
    expect(a.rows).toHaveLength(2 * 1 + 2 * 2);
    expect(a.aggregates.find((x) => x.label === "rho=0.8")?.runs).toBe(2);
  });

  it("skip이 있는 케이스는 실행하지 않고 skipped에 남는다", () => {
    const r = runExperiment([{ ...batchCase(2), skip: "미지원" }], [policy("immediate")], [1]);
    expect(r.rows).toEqual([]);
    expect(r.skipped).toEqual([{ group: "일괄", label: "N=2", reason: "미지원" }]);
  });
});

describe("실험 명세와 --sweep", () => {
  const spec: ExperimentSpec = {
    name: "tiny",
    description: "작은 실험",
    policies: ["sequential", "immediate"],
    seeds: [1],
    cases: () => [batchCase(2)],
    summarize: () => "요약 머리말",
  };

  function memoryIo() {
    const files = new Map<string, string>();
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      readFile: () => {
        throw new Error("ENOENT");
      },
      writeFile: (p, c) => {
        files.set(p, c);
      },
      mkdir: () => {},
      stdout: (t) => {
        out.push(t);
      },
      stderr: (t) => {
        err.push(t);
      },
    };
    return { io, files, out, err };
  }

  const policies = cliPolicies({
    entries: [ruleEntry(SequentialRule, "rules/sequential.ts"), ruleEntry(ImmediateRule, "rules/immediate.ts")],
    errors: [],
  });

  it("parseArgs가 --sweep을 받는다", () => {
    const o = parseArgs(["--sweep", "experiments/ab.ts", "--out", "x"]);
    expect(isArgsError(o)).toBe(false);
    if (!isArgsError(o)) expect(o.sweep).toBe("experiments/ab.ts");
  });

  it("parseExperimentSpec: 형식 오류를 알린다", () => {
    expect(parseExperimentSpec(spec)).toBe(spec);
    expect(() => parseExperimentSpec({ ...spec, name: "a b" })).toThrow();
    expect(() => parseExperimentSpec({ ...spec, seeds: [] })).toThrow();
    expect(() => parseExperimentSpec({ ...spec, baseline: "none" })).toThrow();
    expect(() => parseExperimentSpec(null)).toThrow();
  });

  it("--out이면 <out>/<name>.csv, <name>.md를 쓰고 요약을 맨 위에 둔다", () => {
    const m = memoryIo();
    const code = runCli({ help: false, sweep: "tiny.ts", out: "res/" }, m.io, policies, spec);
    expect(code).toBe(EXIT_OK);
    expect([...m.files.keys()]).toEqual([sweepFilePath("res/", "tiny", "csv"), "res/tiny.md"]);
    const md = m.files.get("res/tiny.md") ?? "";
    expect(md.startsWith("요약 머리말")).toBe(true);
    expect(md).toContain("# 실험 결과: tiny");
  });

  it("없는 정책, 잘못된 명세, 함께 쓸 수 없는 옵션은 오류", () => {
    expect(runCli({ help: false, sweep: "x.ts" }, memoryIo().io, policies, { ...spec, policies: ["nope"] })).toBe(EXIT_ERROR);
    expect(runCli({ help: false, sweep: "x.ts" }, memoryIo().io, policies, undefined)).toBe(EXIT_ERROR);
    expect(runCli({ help: false, sweep: "x.ts", scenario: "basic" }, memoryIo().io, policies, spec)).toBe(EXIT_UNSUPPORTED);
  });
});
