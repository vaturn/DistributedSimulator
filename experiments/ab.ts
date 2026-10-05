// 실험: A·B 두 모듈(용량 1), 모든 작업이 A와 B를 둘 다 필요로 할 때 순차(sequential) vs 즉시(immediate).
// 실행: make sweep SPEC=experiments/ab.ts OUT=docs/experiments
// 형식 설명: experiments/README.md
//
// 케이스 그룹
// - G1  일괄 작업 수 N (T_A = T_B = 2, 도착 없음, allDone)
// - G2  연속 도착 부하 ρ = λ·max(T) (포아송, 1000초)
// - G3a/G3b 처리 시간이 다를 때: T_B = 2, T_A 변화 × required 순서 [A,B]/[B,A] × (일괄 / 연속 도착)
// - G4a/G4b 처리 시간 무작위성 (엔진의 modules[i].processTimeDist 필요)
// - G5  몰려서 도착 (엔진의 arrival.kind = "batch" 필요)
// G4·G5는 parseScenario가 새 필드를 받아들일 때만 실행하고, 아니면 skip 이유를 남긴다.

import type { ExperimentSpec, SweepAggregate, SweepCase, SweepResult } from "../src/cli/sweep";
import { findAggregate, fmt, fmtPct, markdownTable, relativeDiff } from "../src/cli/sweep";
import { parseScenario } from "../src/engine/scenario";
import type { Scenario } from "../src/engine/types";

/** 비교할 정책. 첫 정책(immediate)이 차이(%)의 기준이다 */
const POLICIES = ["immediate", "sequential"];
const BASE = "immediate";
const OTHER = "sequential";
/** 확률 요소가 있는 케이스의 시드 (20개) */
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
/** 확률 요소가 없는 케이스는 시드 하나로 충분하다 */
const DETERMINISTIC_SEEDS = [1];

/** 기본 처리 시간(초) */
const T = 2;
/** 연속 도착 실험의 종료 시각(초). 정상 상태를 보려고 길게 잡는다 */
const STREAM_END = 1000;

const G1_N = [1, 2, 3, 5, 10, 20, 50];
const G2_RHO = [0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 1.0, 1.1, 1.2];
const G3_TA = [0.5, 1, 2, 3, 4, 8];
const G3_TB = 2;
const G3_N = [2, 5, 20];
const G3_RHO = [0.5, 0.8, 0.95];
const G4_N = 20;
const G4_RHO = [0.5, 0.8, 0.95];
const G4_TIMES: readonly [number, number][] = [
  [2, 2],
  [1, 2],
];
const G5_B = [1, 2, 4, 8];
const G5_RHO = [0.5, 0.8];

type Order = "AB" | "BA";
type First = "MA" | "MB";
const FIRSTS: readonly First[] = ["MA", "MB"];
type Dist = { kind: "fixed" } | { kind: "exponential" } | { kind: "normal"; cv: number };
const DISTS: readonly { name: string; dist: Dist }[] = [
  { name: "fixed", dist: { kind: "fixed" } },
  { name: "exp", dist: { kind: "exponential" } },
  { name: "normal-0.25", dist: { kind: "normal", cv: 0.25 } },
  { name: "normal-0.5", dist: { kind: "normal", cv: 0.5 } },
];

const GROUP = {
  g1: "G1 일괄 작업 수",
  g2: "G2 연속 도착 부하",
  g3a: "G3a 처리 시간 차이 · 일괄",
  g3b: "G3b 처리 시간 차이 · 연속 도착",
  g4a: "G4a 처리 시간 무작위성 · 일괄",
  g4b: "G4b 처리 시간 무작위성 · 연속 도착",
  g5: "G5 몰려서 도착",
} as const;

type Raw = Record<string, unknown>;

function required(order: Order): string[] {
  return order === "AB" ? ["A", "B"] : ["B", "A"];
}

/** 시나리오 원본(JSON 모양). 새 엔진 필드(dist, batch arrival)도 넣을 수 있게 Raw로 만든다 */
function raw(opts: {
  name: string;
  ta: number;
  tb: number;
  order: Order;
  n: number;
  arrival?: Raw;
  dist?: Dist;
  /** 시나리오 모듈 순서에서 앞에 둘 모듈 (immediate가 두 모듈이 다 비었을 때 고르는 쪽). 기본 MA */
  first?: First;
}): Raw {
  const mod = (id: string, resultType: string, processTime: number): Raw => ({
    id,
    resultType,
    processTime,
    capacity: 1,
    ...(opts.dist && opts.dist.kind !== "fixed" ? { processTimeDist: opts.dist } : {}),
  });
  return {
    name: opts.name,
    seed: 1,
    modules:
      opts.first === "MB"
        ? [mod("MB", "B", opts.tb), mod("MA", "A", opts.ta)]
        : [mod("MA", "A", opts.ta), mod("MB", "B", opts.tb)],
    jobs: {
      initial: Array.from({ length: opts.n }, () => ({ required: required(opts.order) })),
      arrival: opts.arrival ?? { kind: "none" },
    },
    config: {
      moveTime: 0,
      occupyWhenDone: false,
      cancelOnMove: true,
      endCondition: opts.arrival ? { kind: "time", value: STREAM_END } : { kind: "allDone" },
    },
  };
}

function poisson(rate: number, order: Order): Raw {
  return { kind: "poisson", rate, requiredPool: required(order), minReq: 2, maxReq: 2 };
}

/** 병목 기준 부하 ρ = λ·max(T)가 되도록 하는 작업 도착률 λ */
function rateFor(rho: number, ta: number, tb: number): number {
  return rho / Math.max(ta, tb);
}

// ---------- 엔진 기능 확인 ----------

function asRecord(v: unknown): Raw {
  return typeof v === "object" && v !== null ? (v as Raw) : {};
}

/** parseScenario가 처리 시간 분포 필드를 받아들이고 유지하는가 */
function supportsDist(): boolean {
  try {
    const s = parseScenario(raw({ name: "probe", ta: T, tb: T, order: "AB", n: 1, dist: { kind: "normal", cv: 0.25 } }));
    const dist = asRecord(asRecord(s.modules[0]).processTimeDist);
    return dist.kind === "normal";
  } catch {
    return false;
  }
}

/** parseScenario가 묶음 도착(batch)을 받아들이는가 */
function supportsBatch(): boolean {
  try {
    const s = parseScenario(raw({ name: "probe", ta: T, tb: T, order: "AB", n: 0, arrival: batch(0.1, 2, "AB") }));
    return asRecord(s.jobs.arrival).kind === "batch";
  } catch {
    return false;
  }
}

function batch(rate: number, b: number, order: Order): Raw {
  return { kind: "batch", rate, batchMin: b, batchMax: b, requiredPool: required(order), minReq: 2, maxReq: 2 };
}

/** 케이스 하나. skip이면 시나리오는 새 필드를 뺀 대체본(실행하지 않음) */
function makeCase(
  group: string,
  label: string,
  params: SweepCase["params"],
  data: Raw,
  opts: { deterministic: boolean; skip?: string; fallback?: Raw },
): SweepCase {
  const scenario: Scenario = parseScenario(opts.skip !== undefined && opts.fallback ? opts.fallback : data);
  return {
    group,
    label,
    params,
    scenario,
    ...(opts.deterministic ? { seeds: DETERMINISTIC_SEEDS } : {}),
    ...(opts.skip !== undefined ? { skip: opts.skip } : {}),
  };
}

// ---------- 케이스 ----------

function g1(): SweepCase[] {
  return G1_N.map((n) =>
    makeCase(GROUP.g1, `N=${n}`, { N: n, TA: T, TB: T }, raw({ name: `g1-n${n}`, ta: T, tb: T, order: "AB", n }), {
      deterministic: true,
    }),
  );
}

function g2(): SweepCase[] {
  return G2_RHO.map((rho) =>
    makeCase(
      GROUP.g2,
      `rho=${rho}`,
      { rho, lambda: rateFor(rho, T, T), TA: T, TB: T },
      raw({ name: `g2-rho${rho}`, ta: T, tb: T, order: "AB", n: 0, arrival: poisson(rateFor(rho, T, T), "AB") }),
      { deterministic: false },
    ),
  );
}

function g3aLabel(ta: number, order: Order, n: number, first: First): string {
  return `TA=${ta} ${order} N=${n} first=${first}`;
}

function g3(): SweepCase[] {
  const cases: SweepCase[] = [];
  for (const ta of G3_TA) {
    for (const order of ["AB", "BA"] as const) {
      for (const n of G3_N) {
        for (const first of FIRSTS) {
          cases.push(
            makeCase(
              GROUP.g3a,
              g3aLabel(ta, order, n, first),
              { TA: ta, TB: G3_TB, order, N: n, first },
              raw({ name: `g3a-ta${ta}-${order}-n${n}-${first}`, ta, tb: G3_TB, order, n, first }),
              { deterministic: true },
            ),
          );
        }
      }
    }
  }
  for (const ta of G3_TA) {
    for (const order of ["AB", "BA"] as const) {
      for (const rho of G3_RHO) {
        const rate = rateFor(rho, ta, G3_TB);
        cases.push(
          makeCase(
            GROUP.g3b,
            `TA=${ta} ${order} rho=${rho}`,
            { TA: ta, TB: G3_TB, order, rho, lambda: rate, first: "MA" },
            raw({ name: `g3b-ta${ta}-${order}-rho${rho}`, ta, tb: G3_TB, order, n: 0, arrival: poisson(rate, order) }),
            { deterministic: false },
          ),
        );
        // 모듈 순서 영향 확인: 즉시 룰이 두 모듈이 다 비었을 때 MB를 먼저 고르게 한 변형 (순서 AB만)
        if (order === "AB") {
          cases.push(
            makeCase(
              GROUP.g3b,
              `TA=${ta} ${order} rho=${rho} first=MB`,
              { TA: ta, TB: G3_TB, order, rho, lambda: rate, first: "MB" },
              raw({ name: `g3b-ta${ta}-${order}-rho${rho}-MB`, ta, tb: G3_TB, order, n: 0, arrival: poisson(rate, order), first: "MB" }),
              { deterministic: false },
            ),
          );
        }
      }
    }
  }
  return cases;
}

function g4(): SweepCase[] {
  const skip = supportsDist() ? undefined : "엔진이 modules[i].processTimeDist를 아직 지원하지 않음";
  const cases: SweepCase[] = [];
  for (const [ta, tb] of G4_TIMES) {
    for (const { name, dist } of DISTS) {
      const base = { name: `g4a-${name}-ta${ta}-tb${tb}`, ta, tb, order: "AB" as const, n: G4_N };
      const deterministic = dist.kind === "fixed";
      cases.push(
        makeCase(GROUP.g4a, `${name} TA=${ta} TB=${tb}`, { dist: name, TA: ta, TB: tb, N: G4_N }, raw({ ...base, dist }), {
          deterministic,
          skip: deterministic ? undefined : skip,
          fallback: raw(base),
        }),
      );
    }
  }
  for (const [ta, tb] of G4_TIMES) {
    for (const { name, dist } of DISTS) {
      for (const rho of G4_RHO) {
        const rate = rateFor(rho, ta, tb);
        const base = { name: `g4b-${name}-ta${ta}-tb${tb}-rho${rho}`, ta, tb, order: "AB" as const, n: 0, arrival: poisson(rate, "AB") };
        cases.push(
          makeCase(
            GROUP.g4b,
            `${name} TA=${ta} TB=${tb} rho=${rho}`,
            { dist: name, TA: ta, TB: tb, rho },
            raw({ ...base, dist }),
            { deterministic: false, skip: dist.kind === "fixed" ? undefined : skip, fallback: raw(base) },
          ),
        );
      }
    }
  }
  return cases;
}

function g5(): SweepCase[] {
  const skip = supportsBatch() ? undefined : "엔진이 arrival.kind = \"batch\"를 아직 지원하지 않음";
  const cases: SweepCase[] = [];
  for (const rho of G5_RHO) {
    for (const b of G5_B) {
      const rate = rho / (Math.max(T, T) * b);
      const base = { name: `g5-rho${rho}-b${b}`, ta: T, tb: T, order: "AB" as const, n: 0 };
      cases.push(
        makeCase(
          GROUP.g5,
          `rho=${rho} b=${b}`,
          { rho, b, batchRate: rate, TA: T, TB: T },
          raw({ ...base, arrival: batch(rate, b, "AB") }),
          { deterministic: false, skip, fallback: raw({ ...base, arrival: poisson(rate * b, "AB") }) },
        ),
      );
    }
  }
  return cases;
}

// ---------- 요약 ----------

function agg(result: SweepResult, group: string, label: string, policy: string): SweepAggregate | undefined {
  return findAggregate(result.aggregates, group, label, policy);
}

function mean(a: SweepAggregate | undefined, key: "makespan" | "avgLeadTime" | "throughput"): number | null {
  return a?.stats[key]?.mean ?? null;
}

/** 두 정책의 지표와 차이(%)를 한 줄로 */
function pair(result: SweepResult, group: string, label: string, key: "makespan" | "avgLeadTime" | "throughput"): string[] {
  const b = mean(agg(result, group, label, BASE), key);
  const o = mean(agg(result, group, label, OTHER), key);
  return [fmt(o), fmt(b), fmtPct(relativeDiff(b, o))];
}

function utilPair(result: SweepResult, group: string, label: string): string {
  const u = (p: string): string => {
    const a = agg(result, group, label, p);
    return a ? `${fmt(a.utilization.MA?.mean)}/${fmt(a.utilization.MB?.mean)}` : "-";
  };
  return `${u(OTHER)} vs ${u(BASE)}`;
}

function ran(result: SweepResult, group: string): boolean {
  return result.aggregates.some((a) => a.group === group);
}

function summarize(result: SweepResult): string {
  const out: string[] = [];
  out.push("# A·B 순차 vs 즉시: 언제 같고 언제 크게 다른가");
  out.push("");
  out.push(
    "모듈 MA(결과 A), MB(결과 B) 두 개(용량 1), 모든 작업이 A와 B를 둘 다 필요로 한다. " +
      "`sequential`은 작업의 required 순서대로만 받고, `immediate`는 남은 결과를 주는 빈 모듈에 바로 넣는다. " +
      "둘 다 빈 모듈(빈 슬롯, 대기열 없음)에만 배치하고, 경합하면 먼저 생긴 작업이 우선이다. " +
      "차이(%)는 `(sequential − immediate) / immediate`. makespan·평균 소요는 +가 순차가 나쁨, 처리량은 −가 순차가 나쁨.",
  );
  out.push("");
  out.push("이 요약의 표는 아래 상세 표와 같은 실행 결과에서 계산한다. 결론 문장은 실행 결과를 보고 쓴 것이다.");
  out.push("");

  // G1
  out.push(`## ${GROUP.g1} (T_A = T_B = ${T})`);
  out.push("");
  out.push("이론: 순차는 흐름 공정(flow shop)이라 첫 작업이 A를 받는 동안 MB가 놀아 (N+1)·T. 즉시는 짝수 N이면 두 작업이 짝을 지어 A·B를 맞바꾸며 두 모듈이 쉬지 않아 N·T. 홀수 N이면 마지막 한 작업이 혼자 남아 A, B를 차례로 받아야 해서 (N+1)·T(오래된 작업 우선 + 빈 모듈 즉시 배치의 한계. 최적 일정의 하한은 max(N,2)·T).");
  out.push("");
  out.push(
    markdownTable(
      ["N", "순차 makespan", "이론 (N+1)T", "즉시 makespan", "이론 (짝수 N·T, 홀수 (N+1)T)", "하한 max(N,2)·T", "차이"],
      G1_N.map((n) => {
        const label = `N=${n}`;
        const [o, b, d] = pair(result, GROUP.g1, label, "makespan");
        return [String(n), o, fmt((n + 1) * T), b, fmt((n % 2 === 0 ? n : n + 1) * T), fmt(Math.max(n, 2) * T), d];
      }),
    ),
  );
  out.push("");

  // G2
  out.push(`## ${GROUP.g2} (T_A = T_B = ${T}, 포아송, ${STREAM_END}초, 시드 ${SEEDS.length}개)`);
  out.push("");
  out.push(
    markdownTable(
      ["ρ", "순차 평균 소요", "즉시 평균 소요", "차이", "순차 처리량", "즉시 처리량", "차이", "가동률 MA/MB (순차 vs 즉시)"],
      G2_RHO.map((rho) => {
        const label = `rho=${rho}`;
        return [String(rho), ...pair(result, GROUP.g2, label, "avgLeadTime"), ...pair(result, GROUP.g2, label, "throughput"), utilPair(result, GROUP.g2, label)];
      }),
    ),
  );
  out.push("");

  // G3a
  out.push(`## ${GROUP.g3a} (T_B = ${G3_TB})`);
  out.push("");
  out.push(
    "이론: 순차(모든 작업이 같은 순서 → 2기계 순열 흐름 공정, 같은 작업만 있으므로 Johnson 규칙과 무관) makespan = " +
      "T_first + (N−1)·max(T_A,T_B) + T_second = N·max + min. 순서([A,B]/[B,A])와 무관하다. " +
      "즉시(open shop)의 하한은 max(N·max(T_A,T_B), T_A+T_B).",
  );
  out.push("");
  out.push(
    "`first`는 시나리오 모듈 순서에서 앞에 둔 모듈이다. 즉시 룰은 두 모듈이 다 비면 앞 모듈을 먼저 고른다. " +
      "순차는 다음 결과를 주는 모듈이 하나뿐이라 모듈 순서의 영향을 받지 않는다(두 값이 같은지 아래 표의 순차 열로 확인).",
  );
  out.push("");
  const g3aRows: string[][] = [];
  for (const ta of G3_TA) {
    for (const order of ["AB", "BA"] as const) {
      for (const n of G3_N) {
        const la = g3aLabel(ta, order, n, "MA");
        const lb = g3aLabel(ta, order, n, "MB");
        const seqA = mean(agg(result, GROUP.g3a, la, OTHER), "makespan");
        const seqB = mean(agg(result, GROUP.g3a, lb, OTHER), "makespan");
        const immA = mean(agg(result, GROUP.g3a, la, BASE), "makespan");
        const immB = mean(agg(result, GROUP.g3a, lb, BASE), "makespan");
        const mx = Math.max(ta, G3_TB);
        const mn = Math.min(ta, G3_TB);
        g3aRows.push([
          String(ta),
          order,
          String(n),
          seqA === seqB ? fmt(seqA) : `${fmt(seqA)} / ${fmt(seqB)}`,
          fmt(n * mx + mn),
          fmt(immA),
          fmt(immB),
          fmt(Math.max(n * mx, ta + G3_TB)),
          fmtPct(relativeDiff(immA, seqA)),
          fmtPct(relativeDiff(immB, seqB)),
        ]);
      }
    }
  }
  out.push(
    markdownTable(
      ["T_A", "순서", "N", "순차", "이론 N·max+min", "즉시 (MA 먼저)", "즉시 (MB 먼저)", "하한", "차이 (MA 먼저)", "차이 (MB 먼저)"],
      g3aRows,
    ),
  );
  out.push("");

  // G3b
  out.push(`## ${GROUP.g3b} (T_B = ${G3_TB}, ρ = λ·max(T_A,T_B), 시드 ${SEEDS.length}개)`);
  out.push("");
  const g3bRows: string[][] = [];
  for (const ta of G3_TA) {
    for (const order of ["AB", "BA"] as const) {
      for (const rho of G3_RHO) {
        const label = `TA=${ta} ${order} rho=${rho}`;
        const mbFirst = order === "AB" ? mean(agg(result, GROUP.g3b, `${label} first=MB`, BASE), "avgLeadTime") : null;
        g3bRows.push([
          String(ta),
          order,
          String(rho),
          ...pair(result, GROUP.g3b, label, "avgLeadTime"),
          order === "AB" ? fmt(mbFirst) : "-",
          utilPair(result, GROUP.g3b, label),
        ]);
      }
    }
  }
  out.push(
    "즉시 열은 MA를 앞에 둔 시나리오(기본). \"즉시 (MB 먼저)\"는 같은 도착열에서 모듈 순서만 바꾼 변형이다(순서 AB만 실행).",
  );
  out.push("");
  out.push(
    markdownTable(
      ["T_A", "순서", "ρ", "순차 평균 소요", "즉시 평균 소요", "차이", "즉시 (MB 먼저)", "가동률 MA/MB (순차 vs 즉시)"],
      g3bRows,
    ),
  );
  out.push("");

  // G4
  out.push(`## G4 처리 시간 무작위성`);
  out.push("");
  if (ran(result, GROUP.g4a) && result.skipped.every((s) => s.group !== GROUP.g4a)) {
    const rows: string[][] = [];
    for (const [ta, tb] of G4_TIMES) {
      for (const { name } of DISTS) {
        const label = `${name} TA=${ta} TB=${tb}`;
        rows.push([name, `${ta}/${tb}`, ...pair(result, GROUP.g4a, label, "makespan")]);
      }
    }
    out.push(`일괄 N=${G4_N}:`, "", markdownTable(["분포", "T_A/T_B", "순차 makespan", "즉시 makespan", "차이"], rows), "");
    const rowsB: string[][] = [];
    for (const [ta, tb] of G4_TIMES) {
      for (const { name } of DISTS) {
        for (const rho of G4_RHO) {
          const label = `${name} TA=${ta} TB=${tb} rho=${rho}`;
          rowsB.push([name, `${ta}/${tb}`, String(rho), ...pair(result, GROUP.g4b, label, "avgLeadTime")]);
        }
      }
    }
    out.push("연속 도착:", "", markdownTable(["분포", "T_A/T_B", "ρ", "순차 평균 소요", "즉시 평균 소요", "차이"], rowsB), "");
  } else {
    out.push("미실행: 엔진이 처리 시간 분포(processTimeDist)를 아직 지원하지 않는다 (fixed 케이스만 실행).", "");
  }

  // G5
  out.push(`## ${GROUP.g5}`);
  out.push("");
  if (ran(result, GROUP.g5)) {
    const rows: string[][] = [];
    for (const rho of G5_RHO) {
      for (const b of G5_B) {
        const label = `rho=${rho} b=${b}`;
        rows.push([String(rho), String(b), ...pair(result, GROUP.g5, label, "avgLeadTime")]);
      }
    }
    out.push(markdownTable(["ρ", "묶음 크기 b", "순차 평균 소요", "즉시 평균 소요", "차이"], rows), "");
  } else {
    out.push("미실행: 엔진이 묶음 도착(arrival.kind = \"batch\")을 아직 지원하지 않는다.", "");
  }

  out.push(...CONCLUSIONS);
  out.push(moduleOrderNote(result));
  out.push("");
  return out.join("\n");
}

/** 즉시 룰의 모듈 순서(두 모듈이 다 비었을 때 어느 쪽을 먼저 고르는가) 영향을 실행 결과에서 계산해 문장으로 */
function moduleOrderNote(result: SweepResult): string {
  let batchMax = 0;
  for (const ta of G3_TA) {
    for (const order of ["AB", "BA"] as const) {
      for (const n of G3_N) {
        const a = mean(agg(result, GROUP.g3a, g3aLabel(ta, order, n, "MA"), BASE), "makespan");
        const b = mean(agg(result, GROUP.g3a, g3aLabel(ta, order, n, "MB"), BASE), "makespan");
        batchMax = Math.max(batchMax, Math.abs(relativeDiff(a, b) ?? 0));
      }
    }
  }
  // 연속 도착: 느린 모듈을 먼저 고른 즉시 vs 빠른 모듈을 먼저 고른 즉시 (T_A ≠ T_B, 순서 AB)
  let slowFirstGain = 0;
  let gainAt = "";
  let fastVsSeq = 0;
  for (const ta of G3_TA) {
    if (ta === G3_TB) continue;
    for (const rho of G3_RHO) {
      const label = `TA=${ta} AB rho=${rho}`;
      const maFirst = mean(agg(result, GROUP.g3b, label, BASE), "avgLeadTime");
      const mbFirst = mean(agg(result, GROUP.g3b, `${label} first=MB`, BASE), "avgLeadTime");
      const seq = mean(agg(result, GROUP.g3b, label, OTHER), "avgLeadTime");
      const [slow, fast] = ta > G3_TB ? [maFirst, mbFirst] : [mbFirst, maFirst];
      const gain = relativeDiff(slow, fast) ?? 0;
      if (gain > slowFirstGain) {
        slowFirstGain = gain;
        gainAt = `T_A=${ta}, ρ=${rho}`;
      }
      fastVsSeq = Math.max(fastVsSeq, Math.abs(relativeDiff(fast, seq) ?? 0));
    }
  }
  return (
    "- **즉시 룰의 모듈 순서 영향** (두 모듈이 다 비었을 때 시나리오 순서상 앞 모듈을 먼저 고른다): " +
    `일괄(G3a)에서는 영향이 없다(MA 먼저/MB 먼저 makespan 차이 최대 ${fmt(batchMax, 1)}%). 처음 두 작업이 두 모듈을 하나씩 차지하므로 대칭이다. ` +
    "**연속 도착에서 T_A ≠ T_B면 영향이 있다**(같은 도착열로 비교): 시스템이 비어 있을 때 온 작업을 **느린 모듈에 먼저** 보내면 " +
    `빠른 모듈에 먼저 보낼 때보다 평균 소요가 최대 ${fmt(slowFirstGain, 1)}% 짧다(${gainAt}). ` +
    `빠른 모듈을 먼저 고르는 즉시는 순차와 차이가 ${fmt(fastVsSeq, 1)}% 이내로 줄어든다. ` +
    "즉, 처리 시간이 다를 때 즉시의 이점은 대부분 '느린(병목) 모듈을 먼저 쓰고 빠른 모듈은 나중에'에서 나온다. " +
    "순차는 다음 결과를 주는 모듈이 하나뿐이라 모듈 순서의 영향을 받지 않는다. T_A = T_B면 두 순서의 결과가 같다."
  );
}

/** 결론 (실행 결과를 보고 쓴 문장. 수치는 위 표와 상세 표 참고) */
const CONCLUSIONS: readonly string[] = [
  "## 결론",
  "",
  "### 성능이 같아지는(차이 ≈ 0) 조건",
  "",
  "- **작업이 1개일 때**: 한 작업은 A, B를 차례로 받을 수밖에 없어 둘 다 T_A + T_B.",
  "- **T_A = T_B이고 일괄 작업 수 N이 홀수일 때**: 즉시도 마지막 한 작업이 혼자 A→B를 거쳐 (N+1)·T가 되어 순차와 같다(G1 N=3, 5). " +
    "즉시 룰(오래된 작업 우선, 빈 모듈 즉시 배치)은 최적 일정(하한 N·T)에 못 미친다. T_A ≠ T_B면 두 작업의 박자가 어긋나 즉시가 하한 N·max(T)에 닿는다(G3a N=5).",
  "- **처리 시간이 고정이고 같으며(T_A = T_B) 작업이 하나씩 연속으로 도착할 때**: ρ = 0.2~1.2 전 구간에서 평균 소요 차이 ±2% 이내, 처리량은 같다(G2). " +
    "오히려 순차가 0.5~1.8% 약간 낫다. 고정 처리 시간의 직렬 공정에서는 A를 마친 작업이 T 간격 이상으로 나오므로 MB에서 기다릴 일이 없다. " +
    "과부하(ρ ≥ 1)에서는 두 정책 모두 병목 용량(0.5개/초)으로 처리량이 묶여 차이가 없다.",
  "- **일괄 작업 수 N이 클 때**: 순차의 손해는 시작 시 한 모듈이 노는 시간 min(T_A, T_B) 한 번뿐이라(순차 N·max + min vs 즉시 N·max) 상대 차이가 min/(N·max)로 줄어든다(N=50에서 2%).",
  "- **required 순서([A,B] vs [B,A])는 결과에 영향이 없다**: 일괄 순차 makespan은 N·max + min으로 대칭이고, 연속 도착 고정 처리 시간에서는 직렬 대기열의 순서 교환 불변성(Weber의 interchangeability)으로 소요 시간 분포가 같다. G3a·G3b에서 AB와 BA 값이 모두 일치한다. 즉시는 순서를 보지 않는다.",
  "- **처리 시간 비가 극단적일 때(연속 도착)**: 빠른 모듈이 거의 비어 있어 순서 제약이 거의 비용이 없다. T_A = 0.5(비 0.25)에서 차이 1% 미만.",
  "",
  "### 크게 차이 나는 조건 (모두 즉시가 유리)",
  "",
  "- **일괄 소량, 짝수 N**: N=2에서 순차 3T vs 즉시 2T로 +50%(T_A = T_B). T_A ≠ T_B면 N=2에서 +12.5~33%(비 1.5일 때 최대).",
  "- **처리 시간이 무작위일 때(연속 도착, T_A = T_B)**: 지수 분포 ρ ≥ 0.8에서 +32~33%, 정규 cv 0.5에서 +18~19%, cv 0.25에서 +10~12%. " +
    "순차는 MA의 처리 시간 변동이 MB 도착 간격으로 그대로 전해져 두 대기열에서 모두 기다리지만, 즉시는 먼저 비는 모듈을 바로 쓰므로 변동을 흡수한다. 변동이 클수록, 부하가 높을수록 차이가 커진다. " +
    "일괄 N=20에서도 지수 분포 +12%, cv 0.5 +10%(고정 +5%). " +
    "무작위 처리 시간은 도착 RNG와 분리된 공통 난수(작업·모듈·처리 차수별 표본)라 두 정책이 같은 도착열과 같은 작업별 처리 시간으로 짝지어 비교된다.",
  "- **처리 시간이 다를 때(T_A ≠ T_B, 연속 도착)**: 비가 1.5~2(T_A = 3, 4)일 때 +6~9%로 가장 크다. 비가 1이면 고정 처리 시간 효과(위)로 차이가 없고, 비가 아주 크면 빠른 모듈이 거의 비어 있어 차이가 줄어든다(T_A = 8에서 +4~6%). " +
    "단, 이 이점은 즉시 룰이 빈 시스템에서 느린 모듈을 먼저 고를 때 크다. T_A < T_B인 기본 시나리오(MA 먼저)에서는 즉시가 빠른 모듈을 먼저 골라 차이가 1~3%에 그친다(아래 모듈 순서 항목).",
  "- **몰려서 도착할 때(묶음 크기 b ≥ 2)**: b=1(포아송)에서는 차이 없음(−2%), b=2부터 즉시가 유리(ρ=0.5에서 +17%, ρ=0.8에서 +9%). " +
    "절대 차이는 b에 상관없이 약 1초 = T/2로 일정하다: 빈 시스템에 b개(짝수)가 한꺼번에 오면 순차는 작업이 T, 2T, ...로 하나씩 빠져 평균 T(b+3)/2, 즉시는 두 개씩 짝지어 2T마다 둘씩 빠져 평균 T(b+2)/2. " +
    "그래서 상대 차이는 묶음이 커질수록 줄어든다(b=8에서 +3~6%).",
  "- **처리 시간 무작위성과 T_A ≠ T_B가 겹치면** 차이가 작아진다(T_A/T_B = 1/2에서 연속 도착 +2~8%, 일괄 N=20 +3~5%). 병목 모듈(MB)이 성능을 정하고 빠른 모듈의 변동은 잘 흡수되기 때문이다. " +
    "같은 도착열·같은 처리 시간 표본으로 짝지은 비교에서 모든 조합이 즉시 쪽으로 기운다.",
  "",
  "### 요약",
  "",
  "- 처리 시간이 **고정이고 같으며** 작업이 **하나씩** 오면 두 감독관은 사실상 같다. 순서 제약의 비용은 ‘시작할 때 한 번 한 모듈이 노는 시간’뿐이다.",
  "- 즉시가 크게 이기는 것은 **변동이 있을 때**다: 처리 시간이 무작위이거나(최대 +33%), 작업이 몰려 오거나(+17%), 일괄 작업이 적을 때(+50%), 처리 시간 비가 1.5~2일 때(+9%).",
  "",
];

export default {
  name: "ab",
  description:
    "A·B 두 모듈(용량 1), 모든 작업이 A와 B를 둘 다 필요로 할 때 순차(sequential) vs 즉시(immediate) 감독관 비교. " +
    "기준 정책은 immediate, 차이(%) = (sequential − immediate) / immediate.",
  policies: POLICIES,
  baseline: BASE,
  seeds: SEEDS,
  cases: (): SweepCase[] => [...g1(), ...g2(), ...g3(), ...g4(), ...g5()],
  summarize,
} satisfies ExperimentSpec;
