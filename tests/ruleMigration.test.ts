// greedy·random을 rules/의 Rule 클래스로 옮긴 전후 동작이 같은지 검증한다.
// SNAPSHOT은 옮기기 전 구현(src/supervisor/policies/{greedy,random}.ts 원본)으로 만든 값이다.
// 값: "명령 로그 해시:최종 지표 해시:명령 수:완료 수" (해시는 JSON 문자열의 FNV-1a 32비트)
// 옮긴 뒤 구현은 같은 시나리오·seed에서 명령 로그와 최종 지표가 비트 단위로 같아야 한다.
import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/engine/metrics";
import { runHeadless } from "../src/engine/runner";
import type { Scenario } from "../src/engine/types";
import { SCENARIOS } from "../src/scenarios";
import { createGreedySupervisor } from "../src/supervisor/policies/greedy";
import { createRandomSupervisor } from "../src/supervisor/policies/random";
import { findPolicy } from "../src/supervisor/registry";

const SEEDS = [1, 7, 42] as const;
const OCCUPY_MODES = [
  ["release", false],
  ["occupy", true],
] as const;

/** greedy의 회수(unassign) 경로를 타는 시나리오: C를 주는 모듈이 없어 갈 곳 없는 처리 끝난 작업이 생긴다. */
const UNASSIGN_SCENARIO: Scenario = {
  name: "unassign",
  seed: 3,
  modules: [
    { id: "M1", resultType: "A", processTime: 1 },
    { id: "M2", resultType: "B", processTime: 2, capacity: 2 },
  ],
  jobs: {
    initial: [{ required: ["A", "C"] }, { required: ["A", "B"] }, { required: ["B", "C"] }],
    arrival: { kind: "poisson", rate: 0.5, requiredPool: ["A", "B", "C"], minReq: 1, maxReq: 2 },
  },
  config: { occupyWhenDone: true, endCondition: { kind: "time", value: 100 } },
};

const SNAPSHOT: Record<string, string> = {
  "basic|release|1|greedy": "add9b17f:c2eb8819:165:84",
  "basic|release|1|random": "e09e8541:0dfc1087:273:45",
  "basic|release|7|greedy": "a76390da:cc9e94c4:183:86",
  "basic|release|7|random": "1121460a:3391a132:285:50",
  "basic|release|42|greedy": "505eb30b:e89d6d8f:199:92",
  "basic|release|42|random": "6e44e9ab:ba9b151d:352:51",
  "basic|occupy|1|greedy": "add9b17f:c2eb8819:165:84",
  "basic|occupy|1|random": "268e35fe:8acf8e0d:267:45",
  "basic|occupy|7|greedy": "a76390da:cc9e94c4:183:86",
  "basic|occupy|7|random": "cc44a0d9:ec84491d:300:41",
  "basic|occupy|42|greedy": "505eb30b:e89d6d8f:199:92",
  "basic|occupy|42|random": "50434939:b45f9f5e:337:51",
  "parallel|release|1|greedy": "d101a821:d1fb7a87:282:140",
  "parallel|release|1|random": "a4f3f95b:ec98dc59:522:89",
  "parallel|release|7|greedy": "1b076d7f:759008b2:278:140",
  "parallel|release|7|random": "07d1b9df:8843921a:527:92",
  "parallel|release|42|greedy": "540afb1a:6f4585b8:324:159",
  "parallel|release|42|random": "874cbb7e:ee86b209:567:96",
  "parallel|occupy|1|greedy": "d101a821:d1fb7a87:282:140",
  "parallel|occupy|1|random": "81dbaa98:7d5087a2:526:78",
  "parallel|occupy|7|greedy": "1b076d7f:759008b2:278:140",
  "parallel|occupy|7|random": "a316b23e:0bcb5121:500:81",
  "parallel|occupy|42|greedy": "540afb1a:6f4585b8:324:159",
  "parallel|occupy|42|random": "c6c1748a:d15f197b:518:97",
  "wide|release|1|greedy": "eea3e17c:8d25e66d:435:171",
  "wide|release|1|random": "8db44650:af1ccbf3:898:66",
  "wide|release|7|greedy": "d6c9801f:419b6477:427:171",
  "wide|release|7|random": "c315c26d:0ffbb7b6:942:78",
  "wide|release|42|greedy": "7b91a6dd:0827c8cf:491:191",
  "wide|release|42|random": "02e941f5:ae636622:912:70",
  "wide|occupy|1|greedy": "eea3e17c:8d25e66d:435:171",
  "wide|occupy|1|random": "839dfe8f:5e552826:833:66",
  "wide|occupy|7|greedy": "d6c9801f:419b6477:427:171",
  "wide|occupy|7|random": "4306a86e:9388e8fa:881:68",
  "wide|occupy|42|greedy": "7b91a6dd:0827c8cf:491:191",
  "wide|occupy|42|random": "58dfb5ba:d61322e9:878:55",
  "unassign|release|1|greedy": "3daa57c2:b740737d:62:32",
  "unassign|release|1|random": "2be70d7a:813474d9:227:24",
  "unassign|release|7|greedy": "df5f2fb2:0bbde7e6:59:29",
  "unassign|release|7|random": "e2146ca1:39836c20:216:26",
  "unassign|release|42|greedy": "f718d01f:39f028f8:53:22",
  "unassign|release|42|random": "c1b22996:5046badd:228:16",
  "unassign|occupy|1|greedy": "c50bff9e:b740737d:79:32",
  "unassign|occupy|1|random": "eae77cd0:92e09541:194:20",
  "unassign|occupy|7|greedy": "46266bd8:0bbde7e6:78:29",
  "unassign|occupy|7|random": "145c67e2:732f5115:173:20",
  "unassign|occupy|42|greedy": "9e682376:39f028f8:80:22",
  "unassign|occupy|42|random": "8f474764:7d9f3aa7:191:9"
};

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const CASES: { name: string; scenario: Scenario }[] = [
  ...SCENARIOS.map((e) => ({ name: e.name, scenario: e.scenario })),
  { name: UNASSIGN_SCENARIO.name, scenario: UNASSIGN_SCENARIO },
];

describe("greedy·random 룰 이전 전후 동일성", () => {
  for (const { name, scenario } of CASES) {
    for (const [mode, occupy] of OCCUPY_MODES) {
      for (const seed of SEEDS) {
        for (const policy of ["greedy", "random"] as const) {
          const key = `${name}|${mode}|${seed}|${policy}`;
          it(key, () => {
            const sc: Scenario = { ...scenario, config: { ...scenario.config, occupyWhenDone: occupy } };
            const sup = policy === "greedy" ? createGreedySupervisor() : createRandomSupervisor(seed);
            const { world, commandLog } = runHeadless(sc, sup, { seed });
            const count = commandLog.reduce((a, c) => a + c.commands.length, 0);
            const got = `${fnv1a(JSON.stringify(commandLog))}:${fnv1a(JSON.stringify(computeMetrics(world)))}:${count}:${world.completedCount}`;
            expect(got).toBe(SNAPSHOT[key]);
          });
        }
      }
    }
  }

  it("스냅샷의 모든 항목을 검사한다", () => {
    expect(Object.keys(SNAPSHOT).length).toBe(CASES.length * OCCUPY_MODES.length * SEEDS.length * 2);
  });

  it("registry의 greedy·random도 같은 룰 구현이다", () => {
    for (const { scenario } of CASES) {
      const seed = 42;
      for (const [name, make] of [
        ["greedy", () => createGreedySupervisor()],
        ["random", () => createRandomSupervisor(seed)],
      ] as const) {
        const entry = findPolicy(name);
        if (!entry) throw new Error(name);
        expect(runHeadless(scenario, entry.create(seed), { seed }).commandLog).toEqual(
          runHeadless(scenario, make(), { seed }).commandLog,
        );
      }
    }
  });
});
