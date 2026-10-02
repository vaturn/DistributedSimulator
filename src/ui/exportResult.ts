// 결과 JSON 내보내기 (기획서 §8, §10 M5). 결과 생성·직렬화는 engine/report.ts가 하고,
// 여기서는 파일명을 정하고(순수 함수) 브라우저 다운로드를 일으키기만 한다.

import { buildRunResult, serializeRunResult } from "../engine/report";
import type { CommandLogEntry } from "../engine/runner";
import type { Scenario, WorldState } from "../engine/types";

/** 파일명에 쓰는 simTime 소수 자릿수 */
export const FILE_TIME_DECIMALS = 1;
/** 내보내는 파일의 MIME 형식 */
const JSON_MIME = "application/json";
/** 버튼 라벨과 설명 */
const LABEL = "⬇ 결과 JSON 내보내기";
const TITLE = "지금까지의 실행 결과(지표, 명령 로그)를 JSON 파일로 저장합니다. 진행 중이면 ended=false";
/** 파일명에 쓸 수 없는 문자를 바꿀 문자 */
const UNSAFE_REPLACEMENT = "_";
const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]+/g;

/** 내보낼 실행의 메타 정보 */
export interface ExportMeta {
  scenario: string;
  policy: string;
  seed: number;
  /** 실행에 쓴 시나리오 전체 (리플레이용, seed는 결과에서 meta.seed로 덮어쓴다) */
  scenarioSpec: Scenario;
}

function safePart(s: string): string {
  return s.replace(UNSAFE_FILENAME_CHARS, UNSAFE_REPLACEMENT);
}

/** 내보내기 파일명: `<scenario>-<policy>-<seed>-t<simTime>.json` */
export function exportFileName(meta: Pick<ExportMeta, "scenario" | "policy" | "seed">, simTime: number): string {
  const t = simTime.toFixed(FILE_TIME_DECIMALS);
  return `${safePart(meta.scenario)}-${safePart(meta.policy)}-${meta.seed}-t${t}.json`;
}

/** 현재 월드와 명령 로그로 내보낼 JSON 문자열을 만든다. */
export function runResultJson(world: WorldState, meta: ExportMeta, commandLog: readonly CommandLogEntry[]): string {
  return serializeRunResult(buildRunResult(world, { ...meta, commandLog: [...commandLog] }));
}

/** 문자열을 파일로 내려받게 한다. */
function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: JSON_MIME }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 내보내기에 필요한 현재 상태를 읽는 함수 (누를 때마다 최신 세션을 읽는다) */
export interface ExportSource {
  world(): WorldState;
  meta(): ExportMeta;
  commandLog(): readonly CommandLogEntry[];
}

/** root 끝에 내보내기 버튼을 붙인다. */
export function createExportButton(root: HTMLElement, source: ExportSource): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ctrl-btn ctrl-export";
  b.textContent = LABEL;
  b.title = TITLE;
  b.addEventListener("click", () => {
    const world = source.world();
    const meta = source.meta();
    download(exportFileName(meta, world.simTime), runResultJson(world, meta, source.commandLog()));
    b.blur();
  });
  root.append(b);
  return b;
}
