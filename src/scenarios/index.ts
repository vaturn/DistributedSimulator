// 내장 시나리오 목록. 화면의 시나리오 선택과 CLI의 --scenario가 같은 목록을 쓴다.
// 모든 JSON은 parseScenario로 검증한 뒤 등록한다(형식이 틀리면 불러올 때 바로 오류).
import { parseScenario } from "../engine/scenario";
import type { Scenario } from "../engine/types";
import abBatch from "./ab-batch.json";
import abStream from "./ab-stream.json";
import basic from "./basic.json";
import parallel from "./parallel.json";
import wide from "./wide.json";

export interface ScenarioEntry {
  /** CLI와 결과 파일에 쓰는 이름 (시나리오 JSON의 name) */
  name: string;
  /** 화면에 보이는 이름 */
  label: string;
  scenario: Scenario;
}

function entry(data: unknown, label: string): ScenarioEntry {
  const scenario = parseScenario(data);
  return { name: scenario.name, label, scenario };
}

export const SCENARIOS: readonly ScenarioEntry[] = Object.freeze([
  entry(basic, "기본 (모듈 3개)"),
  entry(parallel, "병렬 (용량 4 모듈과 빠른 단일 모듈)"),
  entry(wide, "대규모 (모듈 8개, 이동 시간 있음)"),
  entry(abBatch, "A·B 일괄 20개"),
  // ab-stream 도착률 0.4개/초: 작업마다 A 모듈과 B 모듈을 한 번씩(각 2초) 거쳐야 하므로
  // 모듈 하나가 처리할 수 있는 작업은 1/2 = 0.5개/초가 상한이다. 그 80%가 0.4개/초.
  entry(abStream, "A·B 연속 도착"),
]);

export function findScenario(name: string): ScenarioEntry | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
