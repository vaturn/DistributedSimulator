// 화면 리플레이의 순수 로직 테스트 (기획서 §10 M6): 결과 JSON 읽기, 리플레이 세션 설정, 비교 표시.
import { describe, expect, it } from "vitest";
import basic from "../src/scenarios/basic.json";
import { computeMetrics } from "../src/engine/metrics";
import { buildRunResult, serializeRunResult, type RunResult } from "../src/engine/report";
import { recordCommands, runHeadless, type CommandLogEntry } from "../src/engine/runner";
import type { Scenario, WorldState } from "../src/engine/types";
import { createWorld, isEnded, step } from "../src/engine/world";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";
import {
  compareReplay,
  replayComparisonView,
  replaySessionConfig,
  replayStatusText,
  replayStopStep,
  replaySupervisorName,
  type ReplaySource,
} from "../src/ui/replay";
import { loadReplay } from "../src/ui/replayLoader";

const scenario = basic as Scenario;
const SEED = 42;
/** 중간에 멈춘 결과를 만들 step 수 */
const PARTIAL_STEPS = 37;

function makeResult(maxSteps?: number): RunResult {
  const { world, commandLog } = runHeadless(scenario, createGreedySupervisor(), { seed: SEED, maxSteps });
  return buildRunResult(world, {
    scenario: "basic",
    policy: "greedy",
    seed: SEED,
    scenarioSpec: { ...scenario, seed: SEED },
    commandLog,
  });
}

/** main.ts의 화면 루프처럼 리플레이 세션을 끝(또는 stopStep)까지 돌린다. */
function playSession(source: ReplaySource): { world: WorldState; commandLog: CommandLogEntry[] } {
  const config = replaySessionConfig(source);
  if (!config.createPolicy) throw new Error("리플레이 감독관이 없습니다");
  const supervisor = config.createPolicy(config.seed);
  const world = createWorld(config.scenario);
  const stop = replayStopStep(source.result);
  const commandLog: CommandLogEntry[] = [];
  for (let n = 0; !isEnded(world) && (stop === null || n < stop); n++) {
    const commands = supervisor.decide(world);
    recordCommands(commandLog, n, world.simTime, commands);
    step(world, commands);
  }
  return { world, commandLog };
}

describe("loadReplay", () => {
  it("정상 결과 JSON은 검증한 결과를 돌려준다", () => {
    const original = makeResult();
    const loaded = loadReplay(serializeRunResult(original));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.result.scenario).toBe("basic");
    expect(loaded.result.policy).toBe("greedy");
    expect(loaded.result.seed).toBe(SEED);
    expect(loaded.result.commandLog).toEqual(original.commandLog);
  });

  it("깨진 JSON은 한국어 오류를 돌려준다", () => {
    const loaded = loadReplay("{ not json");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toMatch(/^JSON을 읽을 수 없습니다/);
  });

  it("형식이 틀리면(버전, 필드 누락) 한국어 오류를 돌려준다", () => {
    const wrongVersion = loadReplay(JSON.stringify({ ...makeResult(), version: 1 }));
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.error).toMatch(/^결과 형식 오류: .*version/);

    const { scenarioSpec: _omit, ...noSpec } = makeResult();
    const missing = loadReplay(JSON.stringify(noSpec));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/scenarioSpec/);

    const notObject = loadReplay("[1, 2]");
    expect(notObject.ok).toBe(false);
  });
});

describe("replaySessionConfig", () => {
  it("원본의 시나리오 명세·시드·이름을 쓰고 수동 입력은 끈다", () => {
    const result = makeResult();
    const config = replaySessionConfig({ fileName: "a.json", result });
    expect(config.manual).toBe(false);
    expect(config.scenarioName).toBe("basic");
    expect(config.policyName).toBe("greedy");
    expect(config.seed).toBe(SEED);
    expect(config.scenario).toEqual(result.scenarioSpec);
    expect(config.createPolicy?.(SEED).name).toBe(replaySupervisorName("greedy"));
    expect(replaySupervisorName("greedy")).toBe("replay:greedy");
  });

  it("끝까지 재생하면 지표가 일치하고, 다시 내보낸 명령 로그가 원본과 같다", () => {
    const result = makeResult();
    const source = { fileName: "basic-greedy-42.json", result };
    const { world, commandLog } = playSession(source);
    expect(isEnded(world)).toBe(true);
    expect(compareReplay(computeMetrics(world), source)).toEqual({ text: "결과 비교: 일치", details: [], matched: true });
    expect(commandLog).toEqual(result.commandLog);
  });

  it("세션을 다시 만들면(리셋) 처음부터 같은 결과로 재생한다", () => {
    const source = { fileName: "a.json", result: makeResult() };
    expect(computeMetrics(playSession(source).world)).toEqual(computeMetrics(playSession(source).world));
  });

  it("종료 전 결과는 원본과 같은 step 수에서 멈춰 비교한다", () => {
    const result = makeResult(PARTIAL_STEPS);
    expect(result.ended).toBe(false);
    expect(replayStopStep(result)).toBe(PARTIAL_STEPS);
    expect(replayStopStep(makeResult())).toBeNull();
    const source = { fileName: "partial.json", result };
    const { world, commandLog } = playSession(source);
    expect(compareReplay(computeMetrics(world), source).matched).toBe(true);
    expect(commandLog).toEqual(result.commandLog);
  });

  it("명령 로그를 바꾸면 불일치를 보고한다", () => {
    const result = makeResult();
    const source = { fileName: "x.json", result: { ...result, commandLog: [] } };
    const view = compareReplay(computeMetrics(playSession(source).world), source);
    expect(view.matched).toBe(false);
    expect(view.text).toBe(`결과 비교: 불일치(${view.details.length}개)`);
    expect(view.details.length).toBeGreaterThan(0);
  });
});

describe("리플레이 표시 문자열", () => {
  it("비교 결과: 일치 / 불일치(N개)", () => {
    expect(replayComparisonView([]).text).toBe("결과 비교: 일치");
    const view = replayComparisonView(["metrics.simTime: 1 ≠ 2", "metrics.completedCount: 3 ≠ 4"]);
    expect(view).toEqual({
      text: "결과 비교: 불일치(2개)",
      details: ["metrics.simTime: 1 ≠ 2", "metrics.completedCount: 3 ≠ 4"],
      matched: false,
    });
  });

  it("상태 줄에 파일 이름과 원본 정보를 적는다", () => {
    const result = makeResult();
    const commands = result.commandLog.reduce((n, e) => n + e.commands.length, 0);
    expect(replayStatusText({ fileName: "r.json", result })).toBe(
      `리플레이 중: r.json (basic · greedy · seed ${SEED} · 명령 ${commands}개)`,
    );
  });
});
