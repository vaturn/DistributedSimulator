// 지표 패널 (기획서 §8). 지표 계산은 engine/metrics.ts의 computeMetrics만 쓰고,
// 이 파일은 표시 형식(순수 함수)과 DOM 갱신만 맡는다.

import type { Metrics } from "../engine/types";

/** 시간(초) 표시 소수 자릿수 */
export const TIME_DECIMALS = 1;
/** 처리량(개/초) 표시 소수 자릿수 */
export const RATE_DECIMALS = 3;
/** 퍼센트 표시 소수 자릿수 */
export const PERCENT_DECIMALS = 0;
/** 값이 없을 때(null, NaN, 무한대) 표시 */
export const EMPTY_VALUE = "-";
/** DOM을 다시 쓰는 최소 간격(ms). 매 프레임 계산하지 않도록 제한한다. */
export const METRICS_UPDATE_INTERVAL_MS = 100;

const PERCENT = 100;

/** 숫자를 고정 소수 자릿수로. null·NaN·무한대는 "-" */
export function formatNumber(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_VALUE;
  // -0.0 같은 표시를 피한다.
  const fixed = value.toFixed(decimals);
  return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;
}

/** 정수 개수 (예: 완료 수) */
export function formatCount(value: number | null): string {
  return formatNumber(value, 0);
}

/** 시간(초) → "12.3s". null이면 "-" */
export function formatSeconds(value: number | null, decimals: number = TIME_DECIMALS): string {
  const s = formatNumber(value, decimals);
  return s === EMPTY_VALUE ? s : `${s}s`;
}

/** 비율(0~1) → "80%". null이면 "-" */
export function formatPercent(ratio: number | null, decimals: number = PERCENT_DECIMALS): string {
  const s = formatNumber(ratio === null ? null : ratio * PERCENT, decimals);
  return s === EMPTY_VALUE ? s : `${s}%`;
}

/** 처리량(개/초) → "0.140/s" */
export function formatRate(value: number | null, decimals: number = RATE_DECIMALS): string {
  const s = formatNumber(value, decimals);
  return s === EMPTY_VALUE ? s : `${s}/s`;
}

/** 요약 한 줄 */
export interface SummaryRow {
  key: string;
  label: string;
  value: string;
  /** 마우스를 올리면 보이는 설명 */
  hint: string;
}

/** 모듈 표 한 줄 */
export interface ModuleRow {
  id: string;
  utilization: string;
  doneOccupied: string;
  queueLength: string;
}

export interface MetricsView {
  summary: SummaryRow[];
  modules: ModuleRow[];
}

/** Metrics → 표시 문자열. 계산 없이 형식만 바꾼다. */
export function metricsView(m: Readonly<Metrics>): MetricsView {
  return {
    summary: [
      { key: "simTime", label: "시간", value: formatSeconds(m.simTime), hint: "시뮬레이션 시간" },
      { key: "completed", label: "완료", value: formatCount(m.completedCount), hint: "완료된 작업 수" },
      { key: "spawned", label: "생성", value: formatCount(m.spawnedCount), hint: "생성된 작업 수 (초기 + 도착)" },
      { key: "throughput", label: "처리량", value: formatRate(m.throughput), hint: "완료 수 / 시간" },
      {
        key: "avgLeadTime",
        label: "평균 소요",
        value: formatSeconds(m.avgLeadTime),
        hint: "완료 작업의 평균(완료 시각 − 등장 시각)",
      },
      {
        key: "avgWaitTime",
        label: "평균 대기",
        value: formatSeconds(m.avgWaitTime),
        hint: "완료 작업의 평균(대기 구역 체류 + 대기열 체류)",
      },
      {
        key: "wasted",
        label: "헛된 처리",
        value: `${formatCount(m.wastedProcessCount)} (불필요 ${formatCount(m.uselessProcessCount)} · 취소 ${formatCount(m.cancelledProcessCount)})`,
        hint: "필요 없거나 이미 가진 결과를 준 처리 + 도중 취소된 처리",
      },
    ],
    modules: m.modules.map((mm) => ({
      id: mm.id,
      utilization: formatPercent(mm.utilization),
      doneOccupied: formatSeconds(mm.doneOccupiedTime),
      queueLength: formatCount(mm.queueLength),
    })),
  };
}

/** 값이 바뀔 때만 DOM 글자를 쓴다. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export interface MetricsPanel {
  /**
   * 지표를 표시한다. now(ms)가 마지막 갱신에서 METRICS_UPDATE_INTERVAL_MS 이상 지났거나
   * force면 getMetrics를 불러 DOM을 갱신한다(바뀐 칸만 쓴다).
   */
  update(getMetrics: () => Metrics, now: number, force?: boolean): void;
}

const MODULE_HEADERS = ["모듈", "가동률", "점유 낭비", "대기열"] as const;
const MODULE_HEADER_HINTS = [
  "",
  "처리 중 슬롯 시간 / (시간 × 용량)",
  "처리 끝난 작업이 슬롯을 점유한 시간 (감독관이 늦게 옮긴 정도)",
  "지금 대기열 길이",
] as const;

/** root 안에 지표 패널을 만든다. */
export function createMetricsPanel(root: HTMLElement): MetricsPanel {
  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = "지표";

  const summary = document.createElement("dl");
  summary.className = "metrics-summary";
  const summaryCells = new Map<string, HTMLElement>();

  const moduleTitle = document.createElement("h3");
  moduleTitle.className = "panel-subtitle";
  moduleTitle.textContent = "모듈별";

  const table = document.createElement("table");
  table.className = "metrics-modules";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  MODULE_HEADERS.forEach((h, i) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    if (MODULE_HEADER_HINTS[i]) th.title = MODULE_HEADER_HINTS[i];
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);
  /** 모듈 id → [id, 가동률, 점유 낭비, 대기열] 칸 */
  let moduleCells = new Map<string, HTMLTableCellElement[]>();
  let moduleOrder = "";

  root.replaceChildren(title, summary, moduleTitle, table);

  let lastUpdate = Number.NEGATIVE_INFINITY;

  const renderSummary = (rows: readonly SummaryRow[]): void => {
    for (const row of rows) {
      let cell = summaryCells.get(row.key);
      if (!cell) {
        const dt = document.createElement("dt");
        dt.textContent = row.label;
        dt.title = row.hint;
        const dd = document.createElement("dd");
        summary.append(dt, dd);
        summaryCells.set(row.key, dd);
        cell = dd;
      }
      setText(cell, row.value);
    }
  };

  const renderModules = (rows: readonly ModuleRow[]): void => {
    const order = rows.map((r) => r.id).join("\u0000");
    if (order !== moduleOrder) {
      // 모듈 구성이 바뀌면(리셋 등) 표를 다시 만든다.
      moduleOrder = order;
      moduleCells = new Map();
      tbody.replaceChildren(
        ...rows.map((r) => {
          const tr = document.createElement("tr");
          const cells = MODULE_HEADERS.map((_, i) => document.createElement(i === 0 ? "th" : "td"));
          cells[0].setAttribute("scope", "row");
          tr.append(...cells);
          moduleCells.set(r.id, cells);
          return tr;
        }),
      );
    }
    for (const r of rows) {
      const cells = moduleCells.get(r.id);
      if (!cells) continue;
      setText(cells[0], r.id);
      setText(cells[1], r.utilization);
      setText(cells[2], r.doneOccupied);
      setText(cells[3], r.queueLength);
    }
  };

  return {
    update(getMetrics, now, force = false) {
      if (!force && now - lastUpdate < METRICS_UPDATE_INTERVAL_MS) return;
      lastUpdate = now;
      const view = metricsView(getMetrics());
      renderSummary(view.summary);
      renderModules(view.modules);
    },
  };
}
