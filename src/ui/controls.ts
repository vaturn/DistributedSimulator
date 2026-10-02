// 컨트롤 바(재생/일시정지, 한 단계, 속도, 리셋)와 키보드 단축키 (기획서 §7 컨트롤).
// DOM 요소를 만들고 사용자 입력을 콜백으로 넘기기만 한다. 루프 상태 계산은 loopState.ts가 한다.

import { SPEED_STEPS, canPlay, currentSpeed, shortcutFor, type LoopState, type ShortcutAction } from "./loopState";

export interface ControlsCallbacks {
  onTogglePlay(): void;
  onStep(): void;
  onReset(): void;
  onSpeedChange(index: number): void;
}

export interface Controls {
  /** 루프 상태에 맞춰 버튼 표시·활성 상태를 갱신한다 (바뀐 것만 DOM에 쓴다). */
  update(state: LoopState): void;
  /** 이벤트 연결을 끊는다. */
  detach(): void;
}

/** 버튼 라벨 */
const LABELS = {
  play: "▶ 재생",
  pause: "⏸ 일시정지",
  step: "⏭ 한 단계",
  reset: "↺ 리셋",
  speed: "속도",
  ended: "종료 — 리셋으로 다시 시작",
  running: "재생 중",
  paused: "일시정지",
} as const;

/** 버튼 설명(툴팁)에 단축키를 함께 적는다 */
const TITLES = {
  play: "재생/일시정지 (Space)",
  step: "일시정지 상태에서 한 step(dt) 진행 (→)",
  reset: "같은 시나리오·시드로 처음부터 (R)",
  speed: "실제 1초당 시뮬레이션 초",
} as const;

/** 속도 배율 표시 (예: 0.5×, 2×) */
export function formatSpeed(speed: number): string {
  return `${speed}×`;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ctrl-btn";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

/** 값이 바뀔 때만 DOM 속성을 쓴다. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
function setDisabled(el: HTMLButtonElement | HTMLSelectElement, disabled: boolean): void {
  if (el.disabled !== disabled) el.disabled = disabled;
}

/** root 안에 컨트롤 바를 만들고 window에 단축키를 연결한다. */
export function createControls(root: HTMLElement, callbacks: ControlsCallbacks): Controls {
  const playBtn = button(LABELS.play, TITLES.play, () => callbacks.onTogglePlay());
  playBtn.classList.add("ctrl-primary");
  const stepBtn = button(LABELS.step, TITLES.step, () => callbacks.onStep());
  const resetBtn = button(LABELS.reset, TITLES.reset, () => callbacks.onReset());

  const speedLabel = document.createElement("label");
  speedLabel.className = "ctrl-speed";
  speedLabel.title = TITLES.speed;
  const speedText = document.createElement("span");
  speedText.textContent = LABELS.speed;
  const speedSelect = document.createElement("select");
  SPEED_STEPS.forEach((s, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = formatSpeed(s);
    speedSelect.append(opt);
  });
  speedSelect.addEventListener("change", () => {
    callbacks.onSpeedChange(Number(speedSelect.value));
    // 선택 후 포커스를 풀어 단축키가 바로 동작하게 한다.
    speedSelect.blur();
  });
  speedLabel.append(speedText, speedSelect);

  const status = document.createElement("span");
  status.className = "ctrl-status";
  status.setAttribute("aria-live", "polite");

  root.replaceChildren(playBtn, stepBtn, resetBtn, speedLabel, status);

  const actions: Record<ShortcutAction, () => void> = {
    togglePlay: () => callbacks.onTogglePlay(),
    step: () => callbacks.onStep(),
    reset: () => callbacks.onReset(),
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat && e.key !== "ArrowRight") return; // 길게 눌러 반복되는 것은 한 단계만 허용
    const target = e.target instanceof HTMLElement ? e.target : null;
    const action = shortcutFor({
      key: e.key,
      targetTag: target ? target.tagName : null,
      targetEditable: target ? target.isContentEditable : false,
      modifier: e.ctrlKey || e.metaKey || e.altKey,
    });
    if (!action) return;
    e.preventDefault();
    actions[action]();
  };
  window.addEventListener("keydown", onKeyDown);

  return {
    update(state) {
      const playable = canPlay(state);
      setText(playBtn, state.paused ? LABELS.play : LABELS.pause);
      setDisabled(playBtn, !playable);
      setDisabled(stepBtn, !(state.paused && playable));
      const speedValue = String(state.speedIndex);
      if (speedSelect.value !== speedValue) speedSelect.value = speedValue;
      setText(
        status,
        state.ended ? LABELS.ended : `${state.paused ? LABELS.paused : LABELS.running} · ${formatSpeed(currentSpeed(state))}`,
      );
      status.classList.toggle("ctrl-status-ended", state.ended);
    },
    detach() {
      window.removeEventListener("keydown", onKeyDown);
    },
  };
}
