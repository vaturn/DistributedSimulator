// 결과 JSON 내보내기 테스트 (기획서 §8, §10 M5): 파일명과 내보낼 JSON 문자열.
import { describe, expect, it } from "vitest";
import basic from "../src/scenarios/basic.json";
import { runHeadless } from "../src/engine/runner";
import type { Scenario } from "../src/engine/types";
import { createWorld } from "../src/engine/world";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";
import { exportFileName, runResultJson } from "../src/ui/exportResult";

const scenario = basic as Scenario;
const META = { scenario: "basic", policy: "greedy", seed: 42 };

describe("exportFileName", () => {
  it("<scenario>-<policy>-<seed>-t<simTime>.json 형식", () => {
    expect(exportFileName(META, 84.3)).toBe("basic-greedy-42-t84.3.json");
    expect(exportFileName({ ...META, policy: "manual" }, 0)).toBe("basic-manual-42-t0.0.json");
  });

  it("부동소수점 오차는 소수 첫째 자리로 정리한다", () => {
    expect(exportFileName(META, 0.1 + 0.2)).toBe("basic-greedy-42-t0.3.json");
    expect(exportFileName(META, 300.00000000004)).toBe("basic-greedy-42-t300.0.json");
  });

  it("파일명에 쓸 수 없는 문자는 바꾼다", () => {
    expect(exportFileName({ scenario: "a/b c", policy: "x:y", seed: 1 }, 1)).toBe("a_b_c-x_y-1-t1.0.json");
  });
});

describe("runResultJson", () => {
  it("종료까지 돌린 결과는 ended=true이고 JSON 왕복이 된다", () => {
    const { world, commandLog } = runHeadless(scenario, createGreedySupervisor());
    const json = runResultJson(world, META, commandLog);
    const parsed: unknown = JSON.parse(json);
    expect(parsed).toMatchObject({ ...META, ended: true, simTime: world.simTime });
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    expect((parsed as { commandLog: unknown[] }).commandLog).toEqual(JSON.parse(JSON.stringify(commandLog)));
  });

  it("진행 중에도 내보낼 수 있고 ended=false", () => {
    const world = createWorld(scenario);
    const parsed = JSON.parse(runResultJson(world, { ...META, policy: "manual" }, [])) as Record<string, unknown>;
    expect(parsed.ended).toBe(false);
    expect(parsed.policy).toBe("manual");
    expect(parsed.commandLog).toEqual([]);
  });
});
