// 파라미터 격자 실험(sweep) 실행기. 순수 로직만 둔다(node API 금지). 파일 읽기·쓰기와 명세 import는 run.ts가 한다.
// 각 (케이스, 정책, 시드)를 runHeadless로 실행하고 지표를 모은 뒤, 시드별 평균·표준편차와 정책 간 차이를 계산한다.
// 지표 계산은 engine/metrics.ts의 computeMetrics를 그대로 쓴다(여기서 규칙을 다시 계산하지 않는다).

import { computeMetrics } from "../engine/metrics";
import { runHeadless } from "../engine/runner";
import type { Scenario } from "../engine/types";
import type { PolicyEntry } from "../supervisor/registry";

/** 케이스 파라미터 값 (표와 CSV에 그대로 나온다) */
export type ParamValue = number | string;

/** 실험 케이스 하나: 시나리오 + 분류 정보 */
export interface SweepCase {
  /** 케이스 묶음 (보고서에서 표 하나) */
  group: string;
  /** 묶음 안에서 케이스를 알아보는 이름 (group 안에서 고유) */
  label: string;
  /** 케이스 파라미터 (예: { N: 20, TA: 2 }) */
  params: Record<string, ParamValue>;
  /** 실행할 시나리오 (parseScenario로 검증한 것을 권장) */
  scenario: Scenario;
  /** 지정하면 실험의 seeds 대신 이 시드만 쓴다 (예: 확률 요소가 없는 케이스는 시드 하나) */
  seeds?: number[];
  /** 지정하면 실행하지 않고 이유를 보고서에 남긴다 (예: 엔진이 아직 지원하지 않는 기능) */
  skip?: string;
}

/** 실험 명세 (experiments/*.ts의 default export) */
export interface ExperimentSpec {
  /** 결과 파일 이름 (<out>/<name>.csv, <name>.md). 영문, 숫자, _, - */
  name: string;
  /** 실험 설명 (보고서 머리말) */
  description: string;
  /** 비교할 정책 이름 (registry 이름) */
  policies: string[];
  /** 기본 시드 목록 */
  seeds: number[];
  /** 차이(%)의 기준 정책. 생략하면 policies[0] */
  baseline?: string;
  /** 케이스 목록을 만든다 */
  cases: () => SweepCase[];
  /** 지정하면 보고서(md) 맨 위에 붙일 요약을 만든다 */
  summarize?: (result: SweepResult) => string;
}

/** (케이스, 정책, 시드) 실행 한 번의 지표 */
export interface SweepRow {
  group: string;
  label: string;
  params: Record<string, ParamValue>;
  policy: string;
  seed: number;
  /** 종료 시 simTime. allDone 종료일 때 모든 작업 완료 시각(makespan) */
  makespan: number;
  /** 종료 시점에 만들어진 작업이 모두 완료되었는가 */
  allDone: boolean;
  completed: number;
  spawned: number;
  throughput: number;
  avgLeadTime: number | null;
  avgWaitTime: number | null;
  /** 모듈 id → 가동률 (시나리오 순서) */
  utilization: Record<string, number>;
}

/** 평균과 표준편차 (표본 표준편차, 값이 하나면 0) */
export interface Stat {
  mean: number;
  std: number;
  n: number;
}

/** 집계하는 숫자 지표 이름 */
export const SWEEP_METRICS = [
  "makespan",
  "completed",
  "spawned",
  "throughput",
  "avgLeadTime",
  "avgWaitTime",
] as const;
export type SweepMetric = (typeof SWEEP_METRICS)[number];

/** (케이스, 정책)의 시드별 집계 */
export interface SweepAggregate {
  group: string;
  label: string;
  params: Record<string, ParamValue>;
  policy: string;
  /** 실행 횟수 (시드 수) */
  runs: number;
  /** 모든 실행에서 모든 작업이 완료되었는가 */
  allDone: boolean;
  /** 지표별 통계. 값이 하나도 없으면(예: 완료 작업 없음) null */
  stats: Record<SweepMetric, Stat | null>;
  /** 모듈 id → 가동률 통계 */
  utilization: Record<string, Stat>;
}

/** 실행하지 않은 케이스 */
export interface SkippedCase {
  group: string;
  label: string;
  reason: string;
}

/** sweep 전체 결과 */
export interface SweepResult {
  rows: SweepRow[];
  aggregates: SweepAggregate[];
  skipped: SkippedCase[];
}

/** 진행 알림 (케이스 하나를 모든 정책·시드로 끝낼 때마다) */
export type SweepProgress = (done: number, total: number, c: SweepCase) => void;

/** 케이스·정책·시드 한 번 실행 */
function runOne(c: SweepCase, policy: PolicyEntry, seed: number): SweepRow {
  const { world } = runHeadless(c.scenario, policy.create(seed), { seed });
  const m = computeMetrics(world);
  const utilization: Record<string, number> = {};
  for (const mod of m.modules) utilization[mod.id] = mod.utilization;
  return {
    group: c.group,
    label: c.label,
    params: { ...c.params },
    policy: policy.name,
    seed,
    makespan: m.simTime,
    allDone: m.completedCount === m.spawnedCount,
    completed: m.completedCount,
    spawned: m.spawnedCount,
    throughput: m.throughput,
    avgLeadTime: m.avgLeadTime,
    avgWaitTime: m.avgWaitTime,
    utilization,
  };
}

/** 모든 (케이스, 정책, 시드)를 실행해 행 목록을 돌려준다. skip이 있는 케이스는 실행하지 않는다. */
export function runSweep(
  cases: readonly SweepCase[],
  policies: readonly PolicyEntry[],
  seeds: readonly number[],
  onProgress?: SweepProgress,
): SweepRow[] {
  const rows: SweepRow[] = [];
  cases.forEach((c, i) => {
    if (c.skip === undefined) {
      for (const policy of policies) {
        for (const seed of c.seeds ?? seeds) rows.push(runOne(c, policy, seed));
      }
    }
    onProgress?.(i + 1, cases.length, c);
  });
  return rows;
}

/** 실행하지 않은 케이스 목록 */
export function skippedCases(cases: readonly SweepCase[]): SkippedCase[] {
  return cases
    .filter((c) => c.skip !== undefined)
    .map((c) => ({ group: c.group, label: c.label, reason: c.skip ?? "" }));
}

/** 평균과 표본 표준편차. 빈 배열이면 null */
export function stat(values: readonly number[]): Stat | null {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, std: Math.sqrt(variance), n };
}

function aggregateKey(group: string, label: string, policy: string): string {
  return JSON.stringify([group, label, policy]);
}

/** 행을 (케이스, 정책)별로 묶어 시드 평균·표준편차를 낸다. 순서는 행이 처음 나온 순서 */
export function aggregate(rows: readonly SweepRow[]): SweepAggregate[] {
  const buckets = new Map<string, SweepRow[]>();
  for (const r of rows) {
    const key = aggregateKey(r.group, r.label, r.policy);
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }
  const result: SweepAggregate[] = [];
  for (const list of buckets.values()) {
    const first = list[0];
    const stats = {} as Record<SweepMetric, Stat | null>;
    for (const metric of SWEEP_METRICS) {
      stats[metric] = stat(list.map((r) => r[metric]).filter((v): v is number => v !== null));
    }
    const utilization: Record<string, Stat> = {};
    for (const id of Object.keys(first.utilization)) {
      const s = stat(list.map((r) => r.utilization[id] ?? 0));
      if (s) utilization[id] = s;
    }
    result.push({
      group: first.group,
      label: first.label,
      params: first.params,
      policy: first.policy,
      runs: list.length,
      allDone: list.every((r) => r.allDone),
      stats,
      utilization,
    });
  }
  return result;
}

/** 실행 + 집계를 한 번에 */
export function runExperiment(
  cases: readonly SweepCase[],
  policies: readonly PolicyEntry[],
  seeds: readonly number[],
  onProgress?: SweepProgress,
): SweepResult {
  const rows = runSweep(cases, policies, seeds, onProgress);
  return { rows, aggregates: aggregate(rows), skipped: skippedCases(cases) };
}

/** (other - base) / base × 100. base가 0이거나 값이 없으면 null */
export function relativeDiff(base: number | null | undefined, other: number | null | undefined): number | null {
  if (base === null || base === undefined || other === null || other === undefined || base === 0) return null;
  return ((other - base) / base) * 100;
}

/** 같은 케이스의 정책별 집계를 찾는다 */
export function findAggregate(
  aggs: readonly SweepAggregate[],
  group: string,
  label: string,
  policy: string,
): SweepAggregate | undefined {
  return aggs.find((a) => a.group === group && a.label === label && a.policy === policy);
}

/** 케이스별 기준 정책 대비 다른 정책의 지표 차이(%) */
export interface PolicyDiff {
  group: string;
  label: string;
  params: Record<string, ParamValue>;
  base: string;
  other: string;
  /** 지표별 (other - base) / base × 100 */
  diff: Record<SweepMetric, number | null>;
}

/** 모든 케이스에 대해 base 대비 other 정책의 차이(%)를 계산한다 */
export function policyDiffs(aggs: readonly SweepAggregate[], base: string, other: string): PolicyDiff[] {
  const result: PolicyDiff[] = [];
  for (const b of aggs) {
    if (b.policy !== base) continue;
    const o = findAggregate(aggs, b.group, b.label, other);
    if (!o) continue;
    const diff = {} as Record<SweepMetric, number | null>;
    for (const metric of SWEEP_METRICS) diff[metric] = relativeDiff(b.stats[metric]?.mean, o.stats[metric]?.mean);
    result.push({ group: b.group, label: b.label, params: b.params, base, other, diff });
  }
  return result;
}

// ---------- 형식 ----------

/** 소수 자릿수 */
const DECIMALS = 2;
/** 값 없음 표시 */
const NA = "-";

/** 숫자를 고정 소수 자릿수 문자열로 (-0은 0) */
export function fmt(v: number | null | undefined, digits: number = DECIMALS): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  const s = v.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

/** 평균 ± 표준편차 (시드가 하나거나 표준편차가 0이면 평균만) */
export function fmtStat(s: Stat | null | undefined, digits: number = DECIMALS): string {
  if (!s) return NA;
  if (s.n <= 1 || Number(fmt(s.std, digits)) === 0) return fmt(s.mean, digits);
  return `${fmt(s.mean, digits)} ± ${fmt(s.std, digits)}`;
}

/** 차이(%) 표시: 부호 포함 */
export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  const s = fmt(v, 1);
  return Number(s) > 0 ? `+${s}%` : `${s}%`;
}

/** markdown 표 한 개 */
export function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const esc = (cell: string): string => cell.replace(/\|/g, "\\|");
  const line = (cells: readonly string[]): string => `| ${cells.map(esc).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

/** 묶음 순서를 유지하며 그룹 이름 목록 */
function groupsOf(aggs: readonly SweepAggregate[]): string[] {
  return [...new Set(aggs.map((a) => a.group))];
}

/** 정책 목록 (집계에 나온 순서) */
function policiesOf(aggs: readonly SweepAggregate[]): string[] {
  return [...new Set(aggs.map((a) => a.policy))];
}

/** 파라미터 열 이름 (그룹 안에 나온 순서) */
function paramKeys(aggs: readonly SweepAggregate[]): string[] {
  const keys: string[] = [];
  for (const a of aggs) for (const k of Object.keys(a.params)) if (!keys.includes(k)) keys.push(k);
  return keys;
}

/**
 * 결과를 markdown 보고서로. 그룹마다 표 하나:
 * 케이스 파라미터 | 정책별 makespan(allDone 그룹)·평균 소요 시간·처리량 | 기준 정책 대비 차이(%).
 * baseline을 생략하면 첫 정책이 기준이다.
 */
export function formatSweepMarkdown(
  result: SweepResult,
  info: { name: string; description: string; baseline?: string },
): string {
  const out: string[] = [`# 실험 결과: ${info.name}`, "", info.description, ""];
  const policies = policiesOf(result.aggregates);
  const base = info.baseline ?? policies[0];
  const others = policies.filter((p) => p !== base);
  for (const group of groupsOf(result.aggregates)) {
    const aggs = result.aggregates.filter((a) => a.group === group);
    const keys = paramKeys(aggs);
    const allDone = aggs.every((a) => a.allDone);
    const metrics: { key: SweepMetric; title: string }[] = [
      ...(allDone ? [{ key: "makespan" as const, title: "makespan" }] : []),
      { key: "avgLeadTime", title: "평균 소요" },
      { key: "throughput", title: "처리량" },
    ];
    const header = [
      ...keys,
      ...policies.flatMap((p) => metrics.map((m) => `${p} ${m.title}`)),
      ...others.flatMap((o) => metrics.map((m) => `${m.title} 차이(${o} vs ${base})`)),
      "시드 수",
    ];
    const rows: string[][] = [];
    for (const a of aggs.filter((x) => x.policy === base)) {
      const byPolicy = policies.map((p) => findAggregate(aggs, group, a.label, p));
      rows.push([
        ...keys.map((k) => String(a.params[k] ?? NA)),
        ...byPolicy.flatMap((pa) => metrics.map((m) => fmtStat(pa?.stats[m.key]))),
        ...others.flatMap((o) => {
          const oa = findAggregate(aggs, group, a.label, o);
          return metrics.map((m) => fmtPct(relativeDiff(a.stats[m.key]?.mean, oa?.stats[m.key]?.mean)));
        }),
        String(a.runs),
      ]);
    }
    out.push(`## ${group}`, "", allDone ? "모든 실행이 allDone으로 끝남 (makespan = 모든 작업 완료 시각)." : "시간 종료 (평균 소요는 완료된 작업 기준).", "");
    out.push(markdownTable(header, rows), "");
  }
  if (result.skipped.length > 0) {
    out.push("## 실행하지 않은 케이스", "");
    out.push(markdownTable(["그룹", "케이스", "이유"], result.skipped.map((s) => [s.group, s.label, s.reason])), "");
  }
  return out.join("\n");
}

/** CSV 셀 인용 */
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 집계 결과를 CSV로: (케이스, 정책)당 한 줄. 파라미터 열, 지표별 mean/std, 모듈별 가동률 mean/std */
export function formatSweepCsv(aggs: readonly SweepAggregate[]): string {
  const keys = paramKeys(aggs);
  const moduleIds: string[] = [];
  for (const a of aggs) for (const id of Object.keys(a.utilization)) if (!moduleIds.includes(id)) moduleIds.push(id);
  const header = [
    "group",
    "label",
    ...keys,
    "policy",
    "runs",
    "allDone",
    ...SWEEP_METRICS.flatMap((m) => [`${m}_mean`, `${m}_std`]),
    ...moduleIds.flatMap((id) => [`util_${id}_mean`, `util_${id}_std`]),
  ];
  const num = (v: number | undefined): string => (v === undefined ? "" : String(Number(v.toFixed(6))));
  const lines = [header.map(csvCell).join(",")];
  for (const a of aggs) {
    const cells = [
      a.group,
      a.label,
      ...keys.map((k) => (a.params[k] === undefined ? "" : String(a.params[k]))),
      a.policy,
      String(a.runs),
      String(a.allDone),
      ...SWEEP_METRICS.flatMap((m) => [num(a.stats[m]?.mean), num(a.stats[m]?.std)]),
      ...moduleIds.flatMap((id) => [num(a.utilization[id]?.mean), num(a.utilization[id]?.std)]),
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** 실험 명세 이름 형식 (파일 이름에 쓴다) */
const SPEC_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** dynamic import 결과(default export)를 검사해 ExperimentSpec으로. 틀리면 한국어 메시지로 Error */
export function parseExperimentSpec(v: unknown): ExperimentSpec {
  if (typeof v !== "object" || v === null) throw new Error("실험 명세는 default export 객체여야 합니다.");
  const s = v as Record<string, unknown>;
  if (typeof s.name !== "string" || !SPEC_NAME_PATTERN.test(s.name)) {
    throw new Error("name은 영문, 숫자, _, -로 된 문자열이어야 합니다.");
  }
  if (typeof s.description !== "string") throw new Error("description은 문자열이어야 합니다.");
  if (!Array.isArray(s.policies) || s.policies.length === 0 || !s.policies.every((p) => typeof p === "string")) {
    throw new Error("policies는 정책 이름 문자열 배열이어야 합니다.");
  }
  if (!Array.isArray(s.seeds) || s.seeds.length === 0 || !s.seeds.every((x) => Number.isSafeInteger(x))) {
    throw new Error("seeds는 정수 배열이어야 합니다.");
  }
  if (typeof s.cases !== "function") throw new Error("cases는 SweepCase[]를 돌려주는 함수여야 합니다.");
  if (s.baseline !== undefined && (typeof s.baseline !== "string" || !s.policies.includes(s.baseline))) {
    throw new Error("baseline은 policies 중 하나여야 합니다.");
  }
  if (s.summarize !== undefined && typeof s.summarize !== "function") throw new Error("summarize는 함수여야 합니다.");
  return v as ExperimentSpec;
}
