// 화면 없는 실행 (CLI, 테스트, 정책 비교 공용).
// 엔진은 supervisor 계층을 import하지 않으므로, 감독관은 구조적 타입 Decider로 받는다.

import { createWorld, isEnded, step } from "./world";
import type { Command, Scenario, WorldState } from "./types";

/** 매 step 명령을 정하는 쪽 (Supervisor와 같은 모양) */
export interface Decider {
  decide(view: Readonly<WorldState>): Command[];
}

/** 명령 로그 한 줄: step 번호(0부터, 그 step 시작 전까지 진행한 step 수), 그 step의 시작 시각, 명령 */
export interface CommandLogEntry {
  step: number;
  t: number;
  commands: Command[];
}

export interface RunHeadlessOptions {
  /** 지정하면 시나리오의 seed를 덮어쓴다 */
  seed?: number;
  /** 최대 step 수. 종료 조건에 닿지 않아도 여기서 멈춘다 */
  maxSteps?: number;
}

export interface RunHeadlessResult {
  world: WorldState;
  commandLog: CommandLogEntry[];
}

/** 기본 최대 step 수 (dt 0.1 기준 시뮬레이션 10000초) */
export const DEFAULT_MAX_STEPS = 100_000;

/** 명령 로그에 한 step의 명령을 기록한다. 빈 명령은 기록하지 않는다. 명령은 복사해서 넣는다. */
export function recordCommands(log: CommandLogEntry[], step: number, t: number, commands: Command[]): void {
  if (commands.length === 0) return;
  log.push({ step, t, commands: commands.map((c) => ({ ...c })) });
}

/** 시나리오에 seed 덮어쓰기를 반영한다. */
function withSeed(scenario: Scenario, seed: number | undefined): Scenario {
  return seed === undefined ? scenario : { ...scenario, seed };
}

/** 종료 조건(또는 maxSteps)까지 화면 없이 실행한다. */
export function runHeadless(
  scenario: Scenario,
  decider: Decider,
  options: RunHeadlessOptions = {},
): RunHeadlessResult {
  const world = createWorld(withSeed(scenario, options.seed));
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const commandLog: CommandLogEntry[] = [];
  for (let n = 0; n < maxSteps && !isEnded(world); n++) {
    const commands = decider.decide(world);
    recordCommands(commandLog, n, world.simTime, commands);
    step(world, commands);
  }
  return { world, commandLog };
}

/**
 * 명령 로그를 재생하는 Decider (리플레이). decide가 불릴 때마다 step 번호를 하나씩 세고,
 * 로그에 그 step의 명령이 있으면 돌려준다. runHeadless처럼 step마다 한 번 불러야 한다.
 */
export function createReplayDecider(log: readonly CommandLogEntry[]): Decider {
  const byStep = new Map<number, Command[]>();
  for (const entry of log) byStep.set(entry.step, [...(byStep.get(entry.step) ?? []), ...entry.commands]);
  let n = 0;
  return {
    decide(): Command[] {
      const commands = byStep.get(n) ?? [];
      n++;
      return commands.map((c) => ({ ...c }));
    },
  };
}
