// 결과 종류 → 색 배정. 특정 결과 이름("A" 등)을 가정하지 않고,
// 시나리오에 나온 결과 종류의 순서(처음 나온 순)로 팔레트 인덱스를 정한다.

import type { ResultType, Scenario } from "../engine/types";
import { RESULT_PALETTE, UNKNOWN_RESULT_COLOR } from "./theme";

export interface ResultColors {
  /** 결과 종류 순서 (파이 조각 순서에도 쓴다) */
  order: readonly ResultType[];
  colorOf(r: ResultType): string;
  /** 정렬 기준 인덱스. 목록에 없으면 목록 뒤로 보낸다. */
  indexOf(r: ResultType): number;
}

/** 시나리오에 나오는 결과 종류를 처음 나온 순서로 모은다 (모듈 → 초기 작업 → 도착 풀). */
export function collectResultTypes(scenario: Scenario): ResultType[] {
  const seen = new Set<ResultType>();
  for (const m of scenario.modules) seen.add(m.resultType);
  for (const j of scenario.jobs.initial) for (const r of j.required) seen.add(r);
  const arrival = scenario.jobs.arrival;
  if (arrival && arrival.kind === "poisson") for (const r of arrival.requiredPool) seen.add(r);
  return [...seen];
}

/** 결과 종류 목록으로 색 배정표를 만든다. 팔레트보다 종류가 많으면 순환한다. */
export function createResultColors(order: readonly ResultType[]): ResultColors {
  const index = new Map<ResultType, number>();
  order.forEach((r, i) => index.set(r, i));
  return {
    order,
    colorOf(r) {
      const i = index.get(r);
      return i === undefined ? UNKNOWN_RESULT_COLOR : RESULT_PALETTE[i % RESULT_PALETTE.length];
    },
    indexOf(r) {
      return index.get(r) ?? order.length;
    },
  };
}
