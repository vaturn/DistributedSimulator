// "결과 JSON 불러오기" 파일 입력과 리플레이 상태 줄 (기획서 §10 M6).
// 파일을 텍스트로 읽어 replay.ts의 loadReplay(순수 함수)에 넘기고, 결과를 콜백으로 넘기기만 한다.

import { loadReplay, replayStatusText, type ReplayComparison, type ReplaySource } from "./replay";

export { loadReplay } from "./replay";

export interface ReplayLoaderCallbacks {
  /** 결과 JSON을 읽고 검증했다 */
  onLoad(source: ReplaySource): void;
  /** 읽기·검증 실패 (현재 세션은 그대로 둔다) */
  onError(message: string): void;
  /** "리플레이 종료"를 눌렀다 */
  onExit(): void;
}

export interface ReplayLoader {
  /** 리플레이 중이면 원본을, 일반 모드면 null을 넘긴다. */
  setReplay(source: ReplaySource | null): void;
  /** 리플레이 결과 비교를 표시한다 (null이면 지운다). */
  setComparison(comparison: ReplayComparison | null): void;
  /** 오류를 상태 줄에 표시한다. */
  showError(message: string): void;
}

/** 라벨과 설명 */
const LABELS = {
  load: "⬆ 결과 JSON 불러오기",
  exit: "■ 리플레이 종료",
} as const;
const TITLES = {
  load: "내보낸 결과 JSON을 불러와 같은 시나리오·시드·명령 로그로 화면에서 재생합니다",
  exit: "리플레이를 끝내고 선택한 감독관·시나리오로 돌아갑니다",
} as const;
/** 받는 파일 형식 */
const ACCEPT = ".json,application/json";
/** 오류 표시 앞말 */
const ERROR_PREFIX = "불러오기 실패: ";

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** root 끝에 불러오기 버튼, 리플레이 종료 버튼, 상태 줄을 붙인다. */
export function createReplayLoader(root: HTMLElement, callbacks: ReplayLoaderCallbacks): ReplayLoader {
  // 파일 입력은 숨기고 버튼 모양의 label로 연다.
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPT;
  input.hidden = true;
  const loadLabel = document.createElement("label");
  loadLabel.className = "ctrl-btn ctrl-replay-load";
  loadLabel.title = TITLES.load;
  loadLabel.tabIndex = 0;
  loadLabel.append(LABELS.load, input);
  loadLabel.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.click();
    }
  });

  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.className = "ctrl-btn";
  exitBtn.textContent = LABELS.exit;
  exitBtn.title = TITLES.exit;
  exitBtn.hidden = true;
  exitBtn.addEventListener("click", () => {
    callbacks.onExit();
    exitBtn.blur();
  });

  const status = document.createElement("span");
  status.className = "ctrl-status ctrl-replay-status";
  status.setAttribute("aria-live", "polite");
  const comparison = document.createElement("span");
  comparison.className = "ctrl-status ctrl-replay-compare";
  comparison.setAttribute("aria-live", "polite");

  const error = document.createElement("span");
  error.className = "ctrl-status ctrl-status-error";
  error.setAttribute("role", "alert");

  const showError = (message: string): void => setText(error, `${ERROR_PREFIX}${message}`);
  const setComparison = (c: ReplayComparison | null): void => {
    setText(comparison, c ? c.text : "");
    comparison.title = c ? c.details.join("\n") : "";
    comparison.classList.toggle("ctrl-status-ok", c?.matched === true);
    comparison.classList.toggle("ctrl-status-ended", c?.matched === false);
  };

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    // 같은 파일을 다시 골라도 change가 나도록 비운다.
    input.value = "";
    loadLabel.blur();
    if (!file) return;
    file.text().then(
      (text) => {
        const loaded = loadReplay(text);
        if (loaded.ok) callbacks.onLoad({ fileName: file.name, result: loaded.result });
        else callbacks.onError(loaded.error);
      },
      (e: unknown) => callbacks.onError(`파일을 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`),
    );
  });

  root.append(loadLabel, exitBtn, status, comparison, error);

  return {
    setReplay(source) {
      setText(status, source ? replayStatusText(source) : "");
      setText(error, "");
      exitBtn.hidden = source === null;
      setComparison(null);
    },
    setComparison,
    showError,
  };
}
