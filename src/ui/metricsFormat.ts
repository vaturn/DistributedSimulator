// 지표 표시 형식 (순수 함수, DOM 없음). 지표 계산은 engine/metrics.ts의 computeMetrics가 하고,
// 이 파일은 값을 표시 문자열로 바꾸기만 한다. 지표 패널(ui/metricsPanel.ts)과 CLI(cli/format.ts)가 함께 쓴다.

import type { Metrics } from "../engine/types";

/** 시간(초) 표시 소수 자릿수 */
export const TIME_DECIMALS = 1;
/** 처리량(개/초) 표시 소수 자릿수 */
export const RATE_DECIMALS = 3;
/** 퍼센트 표시 소수 자릿수 */
export const PERCENT_DECIMALS = 0;
/** 값이 없을 때(null, NaN, 무한대) 표시 */
export const EMPTY_VALUE = "-";

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
