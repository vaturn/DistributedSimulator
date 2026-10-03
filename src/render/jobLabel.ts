// 작업·결과 표시용 글자를 만드는 순수 함수 (파이 조각 라벨, 남은 결과 라벨, hover 툴팁, 범례).
// 남은 결과·유용한 모듈·진행률 같은 규칙 값은 직접 계산하지 않고 engine/rules.ts의 조회 함수만 쓴다.
// DOM·Canvas를 쓰지 않는다.

import { processProgressRatio, remainingResults, usefulResults } from "../engine/rules";
import type { Job, JobId, ModuleId, ResultType, WorldState } from "../engine/types";
import type { TooltipLine } from "./input";
import type { ResultColors } from "./palette";
import { ACQUIRED_MARK, PERCENT, RESULT_LABEL_MAX_CHARS, RESULT_LABEL_SEPARATOR, TIME_DECIMALS } from "./theme";

/** 결과 종류의 짧은 라벨 (앞 RESULT_LABEL_MAX_CHARS 글자). 특정 이름을 가정하지 않는다. */
export function resultLabel(r: ResultType): string {
  return Array.from(r).slice(0, RESULT_LABEL_MAX_CHARS).join("");
}

/** 결과 종류를 결정적인 순서(시나리오 결과 순서, 같으면 이름순)로 정렬한다. 파이 조각 순서와 같다. */
export function orderResults(results: Iterable<ResultType>, colors: Pick<ResultColors, "indexOf">): ResultType[] {
  return [...results].sort((a, b) => colors.indexOf(a) - colors.indexOf(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** 라벨 목록을 구분자로 잇는다. 비어 있으면 "없음" */
function joinLabels(results: readonly ResultType[]): string {
  return results.length === 0 ? "없음" : results.map(resultLabel).join(` ${RESULT_LABEL_SEPARATOR} `);
}

/** 파이 조각 하나 */
export interface JobSlice {
  result: ResultType;
  /** 조각 안에 쓰는 글자 (얻었으면 체크 표시를 붙인다) */
  label: string;
  acquired: boolean;
}

/** 작업 원의 파이 조각: 필요한 결과마다 하나. 남은 결과는 rules.remainingResults로 판정한다. */
export function jobSlices(world: Readonly<WorldState>, jobId: JobId, colors: Pick<ResultColors, "indexOf">): JobSlice[] {
  const job = world.jobs.get(jobId);
  if (!job) return [];
  const remaining = new Set(remainingResults(world, jobId));
  return orderResults(job.required, colors).map((result) => {
    const acquired = !remaining.has(result);
    return { result, acquired, label: acquired ? `${resultLabel(result)}${ACQUIRED_MARK}` : resultLabel(result) };
  });
}

/** 작은 원 아래에 붙이는 남은 결과 라벨 (예: "B·C"). 남은 결과가 없으면 체크 표시 */
export function remainingCaption(world: Readonly<WorldState>, jobId: JobId, colors: Pick<ResultColors, "indexOf">): string {
  const remaining = orderResults(remainingResults(world, jobId), colors);
  return remaining.length === 0 ? ACQUIRED_MARK : remaining.map(resultLabel).join(RESULT_LABEL_SEPARATOR);
}

function moduleOf(job: Readonly<Job>): ModuleId | null {
  return job.location.kind === "module" ? job.location.moduleId : null;
}

/** 작업 상태를 한국어로 (위치·진행률 포함) */
export function jobStateText(world: Readonly<WorldState>, job: Readonly<Job>): string {
  const moduleId = moduleOf(job) ?? "?";
  switch (job.state) {
    case "POOL":
      return "대기 구역에서 배치를 기다림";
    case "MOVING":
      return `이동 중 → ${moduleId}`;
    case "QUEUED": {
      const index = world.modules.get(moduleId)?.queue.indexOf(job.id) ?? -1;
      return index >= 0 ? `${moduleId} 대기열 ${index + 1}번째` : `${moduleId} 대기열`;
    }
    case "PROCESSING":
      return `${moduleId}에서 처리 중 ${Math.floor(processProgressRatio(world, job.id) * PERCENT)}%`;
    case "DONE_AT_MODULE":
      return `${moduleId} 처리 끝 (다음 모듈로 옮기세요)`;
    case "COMPLETED":
      return "완료";
  }
}

/** 남은 결과를 주는 모듈 (모듈 순서). 판정은 rules.usefulResults */
export function usefulModuleText(world: Readonly<WorldState>, jobId: JobId, colors: Pick<ResultColors, "indexOf">): string {
  const parts: string[] = [];
  for (const moduleId of world.modules.keys()) {
    const useful = usefulResults(world, jobId, moduleId);
    if (useful.length > 0) parts.push(`${moduleId}(${orderResults(useful, colors).map(resultLabel).join(RESULT_LABEL_SEPARATOR)})`);
  }
  return parts.length === 0 ? "없음" : parts.join(", ");
}

/** hover 툴팁: 작업 id, 필요·얻음·남음, 상태, 경과 시간, 남은 결과를 주는 모듈 */
export function jobTooltipLines(world: Readonly<WorldState>, jobId: JobId, colors: Pick<ResultColors, "indexOf">): TooltipLine[] {
  const job = world.jobs.get(jobId);
  if (!job) return [];
  const required = orderResults(job.required, colors);
  const remaining = orderResults(remainingResults(world, jobId), colors);
  const remainingSet = new Set(remaining);
  const acquired = required.filter((r) => !remainingSet.has(r));
  const elapsed = Math.max(0, world.simTime - job.createdAt);
  const lines: TooltipLine[] = [
    { text: `작업 ${job.id}`, tone: "info" },
    { text: `필요한 결과: ${joinLabels(required)}`, tone: "info" },
    { text: `얻은 결과: ${acquired.length === 0 ? "없음" : `${joinLabels(acquired)} ${ACQUIRED_MARK}`}`, tone: "info" },
    { text: `남은 결과: ${joinLabels(remaining)}`, tone: remaining.length > 0 ? "accent" : "info" },
    { text: `상태: ${jobStateText(world, job)}`, tone: "info" },
    { text: `생성 후 ${elapsed.toFixed(TIME_DECIMALS)}s`, tone: "info" },
  ];
  if (remaining.length > 0) {
    const useful = usefulModuleText(world, jobId, colors);
    lines.push({ text: `남은 결과를 주는 모듈: ${useful}`, tone: useful === "없음" ? "warn" : "accent" });
  }
  return lines;
}

/** 범례 항목: 결과 종류 → 라벨·색 */
export interface LegendItem {
  result: ResultType;
  label: string;
  color: string;
}

export function legendItems(colors: ResultColors): LegendItem[] {
  return colors.order.map((result) => ({ result, label: resultLabel(result), color: colors.colorOf(result) }));
}

/** 범례 설명 문구 */
export const LEGEND_NOTE = `작업 칸: 채움${ACQUIRED_MARK} = 얻음 · 옅은 칸 = 남음 · 모듈 배지 = 주는 결과`;
