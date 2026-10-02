// 실행 결과 내보내기 (기획서 §8: 종료 후 결과 JSON, 정책 비교용).
// 화면과 CLI가 같은 형식으로 내보내도록 이곳에서만 만든다.

import { computeMetrics } from "./metrics";
import type { CommandLogEntry } from "./runner";
import type { Metrics, SimConfig, WorldState } from "./types";

/** 결과 파일 형식 버전 */
export const RUN_RESULT_VERSION = 1;
/** JSON 들여쓰기 칸 수 */
const JSON_INDENT = 2;

export interface RunResult {
  version: 1;
  /** 시나리오 이름 */
  scenario: string;
  /** 감독관(정책) 이름 */
  policy: string;
  /** 실제로 쓴 시드 (seed 덮어쓰기 반영) */
  seed: number;
  simTime: number;
  /** 종료 조건에 도달했는가 (false면 maxSteps 등으로 중간에 멈춘 결과) */
  ended: boolean;
  metrics: Metrics;
  config: SimConfig;
  /** 명령 로그 (리플레이용) */
  commandLog: CommandLogEntry[];
}

export interface RunResultMeta {
  scenario: string;
  policy: string;
  seed: number;
  commandLog: CommandLogEntry[];
}

/**
 * 월드의 현재 상태로 결과를 만든다. world에는 시드 원본이 남지 않으므로(RNG 상태만 있다)
 * seed는 meta.seed를 그대로 쓴다. 호출하는 쪽이 실제로 쓴 시드를 넘겨야 한다.
 * 모든 값은 복사하므로 이후 world가 바뀌어도 결과는 바뀌지 않는다.
 */
export function buildRunResult(world: Readonly<WorldState>, meta: RunResultMeta): RunResult {
  const metrics = computeMetrics(world);
  return {
    version: RUN_RESULT_VERSION,
    scenario: meta.scenario,
    policy: meta.policy,
    seed: meta.seed,
    simTime: world.simTime,
    ended: world.rules.isEnded(world),
    metrics: { ...metrics, modules: metrics.modules.map((m) => ({ ...m })) },
    config: { ...world.config, endCondition: { ...world.config.endCondition } },
    commandLog: meta.commandLog.map((e) => ({ ...e, commands: e.commands.map((c) => ({ ...c })) })),
  };
}

/** Map/Set은 JSON으로 그대로 직렬화되지 않으므로(빈 객체가 된다) 발견하면 오류로 알린다. */
function rejectCollections(key: string, value: unknown): unknown {
  if (value instanceof Map || value instanceof Set) {
    throw new Error(`결과 직렬화 오류: "${key}"에 Map/Set이 있습니다.`);
  }
  return value;
}

/** 결과를 JSON 문자열로 만든다 (들여쓰기 2). */
export function serializeRunResult(r: RunResult): string {
  return JSON.stringify(r, rejectCollections, JSON_INDENT);
}
