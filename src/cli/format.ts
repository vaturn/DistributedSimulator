// CLI 출력 형식 (순수 함수). 지표 계산은 engine/metrics.ts의 computeMetrics가 하고,
// 값의 표시 형식은 지표 패널과 같은 ui/metricsFormat.ts의 metricsView를 그대로 쓴다.

import type { Metrics } from "../engine/types";
import { metricsView } from "../ui/metricsFormat";

/** 실행 정보 (표 머리말) */
export interface RunInfo {
  scenario: string;
  policy: string;
  seed: number;
}

/** 열 사이 간격 */
const COLUMN_GAP = "  ";
/** 모듈 표 머리글 */
const MODULE_HEADERS = ["모듈", "가동률", "점유 낭비", "대기열"] as const;

/** 터미널 표시 폭. 한글·전각 문자는 2칸으로 센다. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

/** 행 목록을 열 맞춤한 줄들로. 첫 열은 왼쪽, 나머지는 오른쪽 정렬 */
function alignRows(rows: readonly (readonly string[])[]): string[] {
  const columns = Math.max(0, ...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < columns; c++) {
    widths.push(Math.max(0, ...rows.map((r) => displayWidth(r[c] ?? ""))));
  }
  return rows.map((r) =>
    r
      .map((cell, c) => (c === 0 ? padEnd(cell, widths[c] ?? 0) : padStart(cell, widths[c] ?? 0)))
      .join(COLUMN_GAP)
      .trimEnd(),
  );
}

/** 지표를 사람이 읽을 표 문자열로 바꾼다 (요약 + 모듈별 가동률). */
export function formatMetricsTable(metrics: Readonly<Metrics>, info?: Readonly<RunInfo>): string {
  const view = metricsView(metrics);
  const lines: string[] = [];
  if (info) {
    lines.push(`시나리오: ${info.scenario}  정책: ${info.policy}  시드: ${info.seed}`);
    lines.push("");
  }
  lines.push("[요약]");
  const summaryRows = view.summary.map((row) => [row.label, row.value]);
  const summaryWidth = Math.max(0, ...summaryRows.map((r) => displayWidth(r[0] ?? "")));
  for (const [label, value] of summaryRows) {
    lines.push(`  ${padEnd(label ?? "", summaryWidth)}${COLUMN_GAP}${value ?? ""}`);
  }
  lines.push("");
  lines.push("[모듈]");
  const moduleRows = [
    [...MODULE_HEADERS],
    ...view.modules.map((m) => [m.id, m.utilization, m.doneOccupied, m.queueLength]),
  ];
  for (const line of alignRows(moduleRows)) lines.push(`  ${line}`);
  return lines.join("\n");
}
