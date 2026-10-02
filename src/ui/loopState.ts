// 화면 루프 상태(재생/일시정지, 속도, 누적 시간)를 다루는 순수 모듈 (기획서 §6).
// DOM, 엔진에 의존하지 않는다. 실제 경과 시간을 받아 이번 프레임에 돌릴 step 수만 계산한다.
// step 자체는 호출자(main.ts)가 엔진의 step()으로 돌린다.

/** 고를 수 있는 속도 배율 (실제 1초당 시뮬레이션 초). 작은 것부터. 기획서 §7: 0.5x/1x/2x/5x/10x */
export const SPEED_STEPS: readonly number[] = [0.5, 1, 2, 5, 10];
/** 처음 속도 배율 (SPEED_STEPS 안의 값) */
export const DEFAULT_SPEED = 1;
/** 한 프레임에 돌릴 step 수 상한 (따라잡으려다 화면이 멈추지 않게) */
export const MAX_STEPS_PER_FRAME = 100;
/** 한 프레임에 반영할 실제 경과 시간 상한(초). 탭이 오래 멈췄다 돌아와도 몰아 돌지 않게 */
export const MAX_FRAME_SECONDS = 0.25;
/** 누적 시간 / dt 를 셀 때 부동소수점 오차 허용치 (dt 비율) */
const STEP_EPSILON = 1e-9;

export interface LoopState {
  /** 일시정지 중인가 */
  readonly paused: boolean;
  /** 종료 조건에 도달했는가. 도달하면 리셋 전까지 재생할 수 없다. */
  readonly ended: boolean;
  /** SPEED_STEPS의 인덱스 */
  readonly speedIndex: number;
  /** 아직 step으로 소화하지 못한 시뮬레이션 시간(초) */
  readonly accumulator: number;
}

export interface FrameLimits {
  maxStepsPerFrame: number;
  maxFrameSeconds: number;
}

export const DEFAULT_LIMITS: Readonly<FrameLimits> = Object.freeze({
  maxStepsPerFrame: MAX_STEPS_PER_FRAME,
  maxFrameSeconds: MAX_FRAME_SECONDS,
});

export interface FramePlan {
  /** 이번 프레임에 돌릴 step 수 */
  steps: number;
  /** 다음 프레임에 넘길 상태 */
  state: LoopState;
}

/** 배율에 가장 가까운 SPEED_STEPS 인덱스 */
export function speedIndexOf(speed: number): number {
  let best = 0;
  for (let i = 1; i < SPEED_STEPS.length; i++) {
    if (Math.abs(SPEED_STEPS[i] - speed) < Math.abs(SPEED_STEPS[best] - speed)) best = i;
  }
  return best;
}

export function createLoopState(options: { paused?: boolean; speed?: number } = {}): LoopState {
  return {
    paused: options.paused ?? false,
    ended: false,
    speedIndex: speedIndexOf(options.speed ?? DEFAULT_SPEED),
    accumulator: 0,
  };
}

/** 현재 속도 배율 */
export function currentSpeed(state: LoopState): number {
  return SPEED_STEPS[state.speedIndex];
}

/** 재생 가능한가 (종료 후에는 리셋으로만 재시작) */
export function canPlay(state: LoopState): boolean {
  return !state.ended;
}

/** 재생/일시정지 전환. 종료 후에는 바꾸지 않는다. 일시정지할 때 누적 시간은 버린다. */
export function togglePaused(state: LoopState): LoopState {
  if (state.ended) return state;
  return { ...state, paused: !state.paused, accumulator: 0 };
}

/** 속도 인덱스를 정한다 (범위 밖이면 양 끝으로 자른다). */
export function setSpeedIndex(state: LoopState, index: number): LoopState {
  const clamped = Math.max(0, Math.min(SPEED_STEPS.length - 1, Math.trunc(index)));
  return { ...state, speedIndex: clamped };
}

/** 종료 조건 도달: 자동 일시정지 */
export function markEnded(state: LoopState): LoopState {
  return { ...state, ended: true, paused: true, accumulator: 0 };
}

/** 리셋: 속도와 재생/일시정지 여부는 유지하고 종료 표시와 누적 시간을 지운다. */
export function resetLoopState(state: LoopState): LoopState {
  return { ...state, ended: false, accumulator: 0 };
}

/**
 * 한 단계: 일시정지 중이고 종료 전이면 정확히 1 step, 아니면 0.
 * 재생 중에는 프레임 루프가 step을 돌리므로 한 단계는 무시한다.
 */
export function singleStepCount(state: LoopState): number {
  return state.paused && !state.ended ? 1 : 0;
}

/**
 * 실제 경과 시간(초) → 이번 프레임 step 수.
 * - 일시정지·종료면 0 step, 누적 시간은 0.
 * - 경과 시간은 maxFrameSeconds로 자르고 × 속도 배율만큼 누적한다.
 * - floor(누적 / dt)만큼 돌리고 남은 시간은 다음 프레임으로 넘긴다.
 * - 상한(maxStepsPerFrame)에 걸리면 밀린 시간은 버린다.
 */
export function planFrame(
  state: LoopState,
  elapsedSeconds: number,
  dt: number,
  limits: Readonly<FrameLimits> = DEFAULT_LIMITS,
): FramePlan {
  if (state.paused || state.ended || !(dt > 0)) {
    return { steps: 0, state: state.accumulator === 0 ? state : { ...state, accumulator: 0 } };
  }
  const elapsed = Math.max(0, Math.min(elapsedSeconds, limits.maxFrameSeconds));
  const acc = state.accumulator + elapsed * currentSpeed(state);
  const wanted = Math.floor(acc / dt + STEP_EPSILON);
  if (wanted >= limits.maxStepsPerFrame) {
    return { steps: limits.maxStepsPerFrame, state: { ...state, accumulator: 0 } };
  }
  return { steps: wanted, state: { ...state, accumulator: Math.max(0, acc - wanted * dt) } };
}

/** 키보드 단축키로 할 수 있는 동작 */
export type ShortcutAction = "togglePlay" | "step" | "reset";

/** 입력 중이라 단축키를 무시해야 하는 요소 태그 */
const EDITABLE_TAGS: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];

export interface KeyInput {
  key: string;
  /** 이벤트 대상 요소의 태그 이름 (대문자) */
  targetTag: string | null;
  /** contentEditable 요소인가 */
  targetEditable: boolean;
  /** Ctrl/Meta/Alt가 눌렸는가 (브라우저 단축키와 겹치지 않게 무시) */
  modifier: boolean;
}

/** 키 입력 → 단축키 동작. Space 재생/정지, → 한 단계, R 리셋. 입력 요소에 포커스가 있으면 무시 */
export function shortcutFor(input: KeyInput): ShortcutAction | null {
  if (input.modifier || input.targetEditable) return null;
  if (input.targetTag !== null && EDITABLE_TAGS.includes(input.targetTag)) return null;
  switch (input.key) {
    case " ":
    case "Spacebar":
      // 버튼에 포커스가 있으면 Space는 브라우저가 그 버튼을 누르므로 겹쳐 처리하지 않는다.
      return input.targetTag === "BUTTON" ? null : "togglePlay";
    case "ArrowRight":
      return "step";
    case "r":
    case "R":
      return "reset";
    default:
      return null;
  }
}
