// 화면 리플레이의 순수 로직 (기획서 §10 M6). 결과 JSON 읽기·검증, 리플레이 세션 설정 결정,
// 표시 문자열 만들기를 DOM 없이 다룬다. 결과 형식 검증과 지표 비교는 engine/report.ts가 하고,
// 명령 재생은 engine/runner.ts의 createReplayDecider가 한다. DOM은 replayLoader.ts가 맡는다.

import { compareMetrics, parseRunResult, type RunResult } from "../engine/report";
import { createReplayDecider } from "../engine/runner";
import type { Metrics } from "../engine/types";
import type { Supervisor } from "../supervisor/types";
import type { SessionConfig } from "./selection";

/** 리플레이 감독관 이름 앞에 붙이는 말 ("replay:<원래 정책>") */
export const REPLAY_SUPERVISOR_PREFIX = "replay:";

/** 결과 JSON 읽기 결과 */
export type LoadReplayResult = { ok: true; result: RunResult } | { ok: false; error: string };

/** 불러온 리플레이 원본: 파일 이름과 검증한 결과 */
export interface ReplaySource {
  fileName: string;
  result: RunResult;
}

/** 리플레이 세션 설정. 일반 세션 설정과 같은 모양에 원본을 덧붙인다. */
export interface ReplaySessionConfig extends SessionConfig {
  replay: ReplaySource;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 결과 JSON 텍스트 → 검증한 결과. 깨진 JSON이나 형식 오류는 한국어 오류 문자열로 돌려준다. */
export function loadReplay(text: string): LoadReplayResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON을 읽을 수 없습니다: ${errorMessage(e)}` };
  }
  try {
    return { ok: true, result: parseRunResult(data) };
  } catch (e) {
    return { ok: false, error: `결과 형식 오류: ${errorMessage(e)}` };
  }
}

/** 리플레이 감독관 이름 */
export function replaySupervisorName(policy: string): string {
  return `${REPLAY_SUPERVISOR_PREFIX}${policy}`;
}

/**
 * 리플레이 원본 → 세션 설정. 원본의 시나리오 명세에 실제로 쓴 시드를 넣고,
 * 감독관 대신 명령 로그를 재생한다(만들 때마다 처음부터 재생). 수동 입력은 쓰지 않는다.
 * scenarioName·policyName·seed는 원본 그대로 두어 다시 내보낸 결과가 원본과 같은 형태가 되게 한다.
 */
export function replaySessionConfig(source: ReplaySource): ReplaySessionConfig {
  const { result } = source;
  const log = result.commandLog;
  return {
    scenarioName: result.scenario,
    scenario: { ...result.scenarioSpec, seed: result.seed },
    policyName: result.policy,
    seed: result.seed,
    manual: false,
    createPolicy: (): Supervisor => {
      const decider = createReplayDecider(log);
      return { name: replaySupervisorName(result.policy), decide: (view) => decider.decide(view) };
    },
    replay: source,
  };
}

/**
 * 원본이 종료 전(ended=false)에 내보낸 결과면 원본과 같은 step 수에서 멈춰야 비교할 수 있다.
 * 그 step 수를 돌려준다. 종료 조건까지 간 결과면 null (종료 조건에서 멈춘다).
 */
export function replayStopStep(result: RunResult): number | null {
  if (result.ended) return null;
  return Math.round(result.simTime / result.config.dt);
}

/** 리플레이 상태 줄: "리플레이 중: <파일> (시나리오 · 정책 · seed · 명령 수)" */
export function replayStatusText(source: ReplaySource): string {
  const { result } = source;
  const commandCount = result.commandLog.reduce((n, e) => n + e.commands.length, 0);
  return `리플레이 중: ${source.fileName} (${result.scenario} · ${result.policy} · seed ${result.seed} · 명령 ${commandCount}개)`;
}

/** 리플레이 결과 비교 표시 */
export interface ReplayComparison {
  /** 짧은 표시 ("결과 비교: 일치" / "결과 비교: 불일치(N개)") */
  text: string;
  /** 차이 내역 (툴팁 등에 쓴다). 일치하면 빈 배열 */
  details: string[];
  matched: boolean;
}

/** 차이 목록 → 비교 표시 */
export function replayComparisonView(diffs: readonly string[]): ReplayComparison {
  if (diffs.length === 0) return { text: "결과 비교: 일치", details: [], matched: true };
  return { text: `결과 비교: 불일치(${diffs.length}개)`, details: [...diffs], matched: false };
}

/**
 * 파일의 지표와 재계산한 지표를 비교해 표시를 만든다 (차이는 "<항목>: <파일값> ≠ <재계산값>").
 * 비교 자체는 engine/report.ts의 compareMetrics가 한다.
 */
export function compareReplay(recomputed: Metrics, source: ReplaySource): ReplayComparison {
  return replayComparisonView(compareMetrics(source.result.metrics, recomputed));
}
