// 처리 시간 분포·묶음/고정 간격 도착의 시나리오 검증, 편집기 초안 왕복, 모듈 제목 표기, 룰 API 노출.
import { describe, expect, it } from "vitest";
import { parseScenario } from "../src/engine/scenario";
import type { Scenario } from "../src/engine/types";
import { createWorld } from "../src/engine/world";
import { processTimeLabel } from "../src/render/jobLabel";
import { collectResultTypes } from "../src/render/palette";
import { createStepContext } from "../src/supervisor/rule/context";
import { addModule, draftToRaw, draftToScenario, scenarioToDraft, updateArrival, updateModule } from "../src/ui/scenarioDraft";

function base(): Record<string, unknown> {
  return {
    name: "t",
    seed: 1,
    modules: [
      { id: "M1", resultType: "A", processTime: 2, processTimeDist: { kind: "exponential" } },
      { id: "M2", resultType: "B", processTime: 1, processTimeDist: { kind: "normal", cv: 0.3 } },
      { id: "M3", resultType: "C", processTime: 1, processTimeDist: { kind: "fixed" } },
    ],
    jobs: {
      initial: [{ required: ["A", "B"] }],
      arrival: { kind: "batch", rate: 0.2, batchMin: 2, batchMax: 4, requiredPool: ["A", "B", "C"], minReq: 1, maxReq: 2 },
    },
  };
}

function withEdit(edit: (s: Record<string, any>) => void): () => unknown {
  const s = base() as Record<string, any>;
  edit(s);
  return () => parseScenario(s);
}

describe("parseScenario: 처리 시간 분포", () => {
  it("올바른 분포를 그대로 읽고, 생략은 생략으로 남긴다", () => {
    const s = parseScenario(base());
    expect(s.modules.map((m) => m.processTimeDist)).toEqual([
      { kind: "exponential" },
      { kind: "normal", cv: 0.3 },
      { kind: "fixed" },
    ]);
    const omitted = parseScenario({ ...base(), modules: [{ id: "M1", resultType: "A", processTime: 1 }], jobs: { initial: [] } });
    expect("processTimeDist" in omitted.modules[0]!).toBe(false);
  });

  it.each([
    ["kind 이상", (s: Record<string, any>) => (s.modules[0].processTimeDist = { kind: "gamma" }), /modules\[0\]\.processTimeDist\.kind/],
    ["객체 아님", (s: Record<string, any>) => (s.modules[0].processTimeDist = "exponential"), /processTimeDist/],
    ["normal cv 없음", (s: Record<string, any>) => (s.modules[1].processTimeDist = { kind: "normal" }), /modules\[1\]\.processTimeDist\.cv/],
    ["normal cv 0", (s: Record<string, any>) => (s.modules[1].processTimeDist.cv = 0), /cv/],
    ["normal cv 음수", (s: Record<string, any>) => (s.modules[1].processTimeDist.cv = -0.1), /cv/],
  ])("오류: %s", (_label, edit, pattern) => {
    expect(withEdit(edit)).toThrow(pattern);
  });
});

describe("parseScenario: batch·interval 도착", () => {
  it("batch와 interval을 읽는다", () => {
    expect(parseScenario(base()).jobs.arrival).toEqual(base().jobs && (base().jobs as Record<string, unknown>).arrival);
    const interval = { kind: "interval", every: 5, count: 2, requiredPool: ["A"], minReq: 1, maxReq: 1 };
    expect(parseScenario({ ...base(), jobs: { initial: [], arrival: interval } }).jobs.arrival).toEqual(interval);
  });

  it.each([
    ["batchMin 0", (s: Record<string, any>) => (s.jobs.arrival.batchMin = 0), /batchMin/],
    ["batchMin 소수", (s: Record<string, any>) => (s.jobs.arrival.batchMin = 1.5), /batchMin/],
    ["batchMax 없음", (s: Record<string, any>) => delete s.jobs.arrival.batchMax, /batchMax/],
    ["batchMin > batchMax", (s: Record<string, any>) => (s.jobs.arrival.batchMin = 5), /batchMin은 batchMax/],
    ["batch rate 음수", (s: Record<string, any>) => (s.jobs.arrival.rate = -1), /rate/],
    ["batch requiredPool에 주는 모듈 없는 결과", (s: Record<string, any>) => (s.jobs.arrival.requiredPool = ["A", "Q"]), /Q/],
    ["batch minReq > maxReq", (s: Record<string, any>) => (s.jobs.arrival.minReq = 3), /minReq/],
    [
      "interval every 0",
      (s: Record<string, any>) => (s.jobs.arrival = { kind: "interval", every: 0, count: 1, requiredPool: ["A"], minReq: 1, maxReq: 1 }),
      /every/,
    ],
    [
      "interval count 0",
      (s: Record<string, any>) => (s.jobs.arrival = { kind: "interval", every: 1, count: 0, requiredPool: ["A"], minReq: 1, maxReq: 1 }),
      /count/,
    ],
    ["알 수 없는 kind", (s: Record<string, any>) => (s.jobs.arrival.kind = "burst"), /arrival\.kind/],
  ])("오류: %s", (_label, edit, pattern) => {
    expect(withEdit(edit)).toThrow(pattern);
  });

  it("batch requiredPool도 결과 색 목록에 들어간다", () => {
    const s = parseScenario({
      ...base(),
      modules: [{ id: "M1", resultType: "A", processTime: 1 }, { id: "M2", resultType: "Z", processTime: 1 }],
      jobs: { initial: [], arrival: { kind: "batch", rate: 1, batchMin: 1, batchMax: 1, requiredPool: ["Z"], minReq: 1, maxReq: 1 } },
    });
    expect(collectResultTypes(s)).toEqual(["A", "Z"]);
  });
});

describe("편집기 초안 왕복", () => {
  const scenario = (): Scenario => parseScenario(base());

  it("분포와 batch 도착을 잃지 않는다", () => {
    const back = draftToScenario(scenarioToDraft(scenario()));
    expect(back.ok && back.scenario).toEqual(scenario());
  });

  it("interval 도착을 잃지 않는다", () => {
    const s = parseScenario({
      ...base(),
      jobs: { initial: [], arrival: { kind: "interval", every: 3, count: 2, requiredPool: ["B", "A"], minReq: 1, maxReq: 2 } },
    });
    const back = draftToScenario(scenarioToDraft(s));
    expect(back.ok && back.scenario).toEqual(s);
  });

  it("분포 종류·cv를 바꾸고, 기본값으로 돌리면 생략한다", () => {
    let d = scenarioToDraft(scenario());
    d = updateModule(d, 2, { distKind: "normal", cv: 0.5 });
    d = updateModule(d, 0, { distKind: "default" });
    const r = draftToScenario(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.modules[2]!.processTimeDist).toEqual({ kind: "normal", cv: 0.5 });
    expect("processTimeDist" in r.scenario.modules[0]!).toBe(false);
  });

  it("잘못된 cv는 모듈 칸 오류로 알린다", () => {
    const r = draftToScenario(updateModule(scenarioToDraft(scenario()), 1, { cv: 0 }));
    expect(r.ok ? [] : r.errors.map((e) => e.path)).toEqual(["modules[1].processTimeDist.cv"]);
  });

  it("도착 방식을 바꾸면 그 방식의 필드로 저장한다", () => {
    const d = scenarioToDraft(scenario());
    const poisson = draftToRaw(updateArrival(d, { kind: "poisson", rate: 0.7 }));
    expect((poisson.jobs as Record<string, unknown>).arrival).toEqual({
      kind: "poisson",
      rate: 0.7,
      requiredPool: ["A", "B", "C"],
      minReq: 1,
      maxReq: 2,
    });
    const interval = draftToScenario(updateArrival(d, { kind: "interval", every: 4, count: 3 }));
    expect(interval.ok && interval.scenario.jobs.arrival).toMatchObject({ kind: "interval", every: 4, count: 3 });
    const badBatch = draftToScenario(updateArrival(d, { batchMin: 5, batchMax: 2 }));
    expect(badBatch.ok ? [] : badBatch.errors.map((e) => e.path)).toEqual(["jobs.arrival"]);
  });

  it("모듈을 추가하면 마지막 모듈의 분포를 따른다", () => {
    const d = addModule(scenarioToDraft(scenario()));
    expect(d.modules[3]).toMatchObject({ distKind: "fixed" });
  });
});

describe("표시와 룰 API", () => {
  it("모듈 제목 처리 시간 표기", () => {
    expect(processTimeLabel({ processTime: 2, processTimeDist: { kind: "fixed" } })).toBe("2s");
    expect(processTimeLabel({ processTime: 2, processTimeDist: { kind: "exponential" } })).toBe("~2s(지수)");
    expect(processTimeLabel({ processTime: 1.5, processTimeDist: { kind: "normal", cv: 0.3 } })).toBe("~1.5s(정규 cv0.3)");
  });

  it("ModuleRef는 기대 처리 시간과 분포(복사본)를 보여 준다", () => {
    const world = createWorld(parseScenario(base()));
    const { ctx } = createStepContext({ view: world, random: () => 0, log: () => {} });
    const m1 = ctx.module("M1");
    const job = ctx.jobs()[0];
    if (!m1 || !job) throw new Error("모듈·작업 없음");
    expect(m1.processTime).toBe(2);
    expect(m1.processTimeFor(job)).toBe(2);
    const dist = m1.processTimeDist;
    expect(dist).toEqual({ kind: "exponential" });
    (dist as { kind: string }).kind = "fixed";
    expect(world.modules.get("M1")!.processTimeDist).toEqual({ kind: "exponential" });
    expect(ctx.module("M2")?.processTimeDist).toEqual({ kind: "normal", cv: 0.3 });
  });
});
