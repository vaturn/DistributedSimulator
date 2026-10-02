// 화면 루프 상태(재생/일시정지, 속도, 누적 시간, 단축키) 테스트. DOM 없이 순수 함수만 검증한다.
import { describe, expect, it } from "vitest";
import {
  SPEED_STEPS,
  canPlay,
  createLoopState,
  currentSpeed,
  markEnded,
  planFrame,
  resetLoopState,
  setSpeedIndex,
  shortcutFor,
  singleStepCount,
  speedIndexOf,
  togglePaused,
  type KeyInput,
} from "../src/ui/loopState";

const DT = 0.1;
const LIMITS = { maxStepsPerFrame: 100, maxFrameSeconds: 0.25 };

describe("속도 단계 (기획서 §7)", () => {
  it("속도 단계는 0.5/1/2/5/10×이고 기본은 1×", () => {
    expect(SPEED_STEPS).toEqual([0.5, 1, 2, 5, 10]);
    expect(currentSpeed(createLoopState())).toBe(1);
  });
});

describe("planFrame", () => {
  it("일시정지면 step 0이고 누적 시간을 버린다", () => {
    const s = createLoopState({ paused: true });
    const plan = planFrame(s, 0.2, DT, LIMITS);
    expect(plan.steps).toBe(0);
    expect(plan.state.accumulator).toBe(0);
  });

  it("1×에서 0.2초 경과 → 2 step", () => {
    const plan = planFrame(createLoopState({ speed: 1 }), 0.2, DT, LIMITS);
    expect(plan.steps).toBe(2);
    expect(plan.state.accumulator).toBeCloseTo(0, 9);
  });

  it.each(SPEED_STEPS.map((speed) => [speed]))("속도 %s×: 0.2초 경과 step 수 = floor(0.2 × 배율 / dt)", (speed) => {
    const s = createLoopState({ speed });
    expect(currentSpeed(s)).toBe(speed);
    const plan = planFrame(s, 0.2, DT, LIMITS);
    expect(plan.steps).toBe(Math.floor((0.2 * speed) / DT + 1e-9));
  });

  it("dt보다 짧은 시간은 누적되었다가 다음 프레임에 step이 된다", () => {
    let s = createLoopState({ speed: 1 });
    let total = 0;
    for (let i = 0; i < 6; i++) {
      const plan = planFrame(s, 0.05, DT, LIMITS);
      total += plan.steps;
      s = plan.state;
    }
    // 0.05 × 6 = 0.3초 → 3 step, 남은 시간 0
    expect(total).toBe(3);
    expect(s.accumulator).toBeCloseTo(0, 9);
  });

  it("남은 시간은 다음 프레임으로 넘어간다", () => {
    const plan = planFrame(createLoopState({ speed: 1 }), 0.15, DT, LIMITS);
    expect(plan.steps).toBe(1);
    expect(plan.state.accumulator).toBeCloseTo(0.05, 9);
  });

  it("경과 시간은 maxFrameSeconds로 자른다", () => {
    const plan = planFrame(createLoopState({ speed: 1 }), 10, DT, LIMITS);
    expect(plan.steps).toBe(2); // 0.25초 → 2 step
    expect(plan.state.accumulator).toBeCloseTo(0.05, 9);
  });

  it("step 수 상한에 걸리면 상한만큼만 돌고 밀린 시간은 버린다", () => {
    const s = createLoopState({ speed: SPEED_STEPS[SPEED_STEPS.length - 1] });
    const plan = planFrame(s, 0.25, DT, { maxStepsPerFrame: 10, maxFrameSeconds: 0.25 });
    expect(plan.steps).toBe(10);
    expect(plan.state.accumulator).toBe(0);
  });

  it("음수 경과 시간은 0으로 본다", () => {
    const plan = planFrame(createLoopState(), -1, DT, LIMITS);
    expect(plan.steps).toBe(0);
    expect(plan.state.accumulator).toBe(0);
  });

  it("종료 후에는 step 0이고 재생할 수 없다", () => {
    const s = markEnded(createLoopState());
    expect(s.paused).toBe(true);
    expect(canPlay(s)).toBe(false);
    expect(planFrame(s, 0.2, DT, LIMITS).steps).toBe(0);
    expect(togglePaused(s)).toBe(s);
    expect(singleStepCount(s)).toBe(0);
  });
});

describe("한 단계", () => {
  it("일시정지 중이면 정확히 1 step", () => {
    expect(singleStepCount(createLoopState({ paused: true }))).toBe(1);
  });
  it("재생 중이면 0 (프레임 루프가 돌린다)", () => {
    expect(singleStepCount(createLoopState({ paused: false }))).toBe(0);
  });
});

describe("상태 전환", () => {
  it("재생/일시정지 전환은 누적 시간을 버린다", () => {
    const s = planFrame(createLoopState(), 0.15, DT, LIMITS).state;
    expect(s.accumulator).toBeGreaterThan(0);
    const paused = togglePaused(s);
    expect(paused.paused).toBe(true);
    expect(paused.accumulator).toBe(0);
    expect(togglePaused(paused).paused).toBe(false);
  });

  it("속도 인덱스는 범위 밖이면 양 끝으로 자른다", () => {
    const s = createLoopState();
    expect(setSpeedIndex(s, -5).speedIndex).toBe(0);
    expect(setSpeedIndex(s, 999).speedIndex).toBe(SPEED_STEPS.length - 1);
  });

  it("speedIndexOf는 가장 가까운 배율을 고른다", () => {
    expect(SPEED_STEPS[speedIndexOf(1)]).toBe(1);
    expect(SPEED_STEPS[speedIndexOf(100)]).toBe(SPEED_STEPS[SPEED_STEPS.length - 1]);
  });

  it("리셋은 종료 표시를 지우고 속도를 유지한다", () => {
    const ended = markEnded(setSpeedIndex(createLoopState(), 4));
    const r = resetLoopState(ended);
    expect(r.ended).toBe(false);
    expect(r.speedIndex).toBe(4);
    expect(r.accumulator).toBe(0);
    expect(canPlay(r)).toBe(true);
  });
});

describe("shortcutFor", () => {
  const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
    key: k,
    targetTag: "BODY",
    targetEditable: false,
    modifier: false,
    ...extra,
  });

  it("Space 재생/정지, → 한 단계, R 리셋", () => {
    expect(shortcutFor(key(" "))).toBe("togglePlay");
    expect(shortcutFor(key("ArrowRight"))).toBe("step");
    expect(shortcutFor(key("r"))).toBe("reset");
    expect(shortcutFor(key("R"))).toBe("reset");
    expect(shortcutFor(key("x"))).toBeNull();
  });

  it("입력 요소에 포커스가 있으면 무시한다", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(shortcutFor(key("r", { targetTag: tag }))).toBeNull();
      expect(shortcutFor(key(" ", { targetTag: tag }))).toBeNull();
    }
    expect(shortcutFor(key("r", { targetEditable: true }))).toBeNull();
  });

  it("버튼 포커스에서 Space는 브라우저 버튼 동작에 맡긴다", () => {
    expect(shortcutFor(key(" ", { targetTag: "BUTTON" }))).toBeNull();
    expect(shortcutFor(key("r", { targetTag: "BUTTON" }))).toBe("reset");
  });

  it("수정 키와 함께 누르면 무시한다 (Ctrl+R 새로고침 등)", () => {
    expect(shortcutFor(key("r", { modifier: true }))).toBeNull();
  });
});
