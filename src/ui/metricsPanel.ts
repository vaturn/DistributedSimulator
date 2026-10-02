// 지표 패널 (기획서 §8). 지표 계산은 engine/metrics.ts의 computeMetrics만 쓰고,
// 표시 형식은 ui/metricsFormat.ts(순수 함수)를 쓴다. 이 파일은 DOM 갱신만 맡는다.

import type { Metrics } from "../engine/types";
import { metricsView, type ModuleRow, type SummaryRow } from "./metricsFormat";

/** DOM을 다시 쓰는 최소 간격(ms). 매 프레임 계산하지 않도록 제한한다. */
export const METRICS_UPDATE_INTERVAL_MS = 100;

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
