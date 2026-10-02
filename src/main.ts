// 진입점: 엔진 + 감독관 + 렌더러 + 화면 루프를 조립한다 (기획서 §6).
// 상태 변경은 step()에 넘기는 Command로만 일어나고, 렌더러는 상태를 읽기만 한다.

import type { Scenario } from "./engine/types";
import { createWorld, isEnded, step } from "./engine/world";
import { render, type RenderInfo } from "./render/canvas";
import { computeLayout, type Layout } from "./render/layout";
import { collectResultTypes, createResultColors } from "./render/palette";
import basicScenario from "./scenarios/basic.json";
import { createGreedySupervisor } from "./supervisor/policies/greedy";

/** 캔버스 요소의 id (index.html과 맞춘다) */
const CANVAS_ID = "sim-canvas";
/** 재생 속도 배율 (실제 1초당 시뮬레이션 초). 속도 조절 UI는 M4에서 만든다. */
const SPEED = 1;
/** 한 프레임에 돌릴 step 수 상한 (탭이 오래 멈췄다 돌아와도 한꺼번에 몰아 돌지 않게) */
const MAX_STEPS_PER_FRAME = 100;
/** 한 프레임에 반영할 실제 경과 시간 상한(초) */
const MAX_FRAME_SECONDS = 0.25;
/** 밀리초 → 초 */
const MS_PER_SECOND = 1000;

const scenario = basicScenario as Scenario;
const world = createWorld(scenario);
const supervisor = createGreedySupervisor();
const info: RenderInfo = {
  colors: createResultColors(collectResultTypes(scenario)),
  scenarioName: scenario.name,
  supervisorName: supervisor.name,
};

const canvasEl = document.getElementById(CANVAS_ID);
if (!(canvasEl instanceof HTMLCanvasElement)) {
  throw new Error(`#${CANVAS_ID} 캔버스 요소를 찾을 수 없습니다.`);
}
const canvas: HTMLCanvasElement = canvasEl;
const ctxOrNull = canvas.getContext("2d");
if (!ctxOrNull) {
  throw new Error("Canvas 2D 컨텍스트를 얻을 수 없습니다.");
}
const ctx: CanvasRenderingContext2D = ctxOrNull;

let layout: Layout = resize();

/** 캔버스를 창 크기에 맞추고(devicePixelRatio 반영) 배치를 다시 계산한다. */
function resize(): Layout {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  // 그리기 좌표는 CSS 픽셀로 쓴다.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return computeLayout({ width, height }, [...world.modules.values()]);
}

window.addEventListener("resize", () => {
  layout = resize();
  render(ctx, world, layout, info);
});

let lastTime: number | null = null;
let accumulator = 0;

/** 고정 시간 간격 루프: 경과 시간 × SPEED만큼 step을 돌리고 한 번 그린다. */
function frame(now: number): void {
  const elapsed = lastTime === null ? 0 : Math.min((now - lastTime) / MS_PER_SECOND, MAX_FRAME_SECONDS);
  lastTime = now;
  accumulator += elapsed * SPEED;

  const dt = world.config.dt;
  let steps = 0;
  while (accumulator >= dt && steps < MAX_STEPS_PER_FRAME && !isEnded(world)) {
    step(world, supervisor.decide(world));
    accumulator -= dt;
    steps++;
  }
  // 상한에 걸려 밀린 시간은 버린다 (따라잡으려다 화면이 멈추지 않게).
  if (steps >= MAX_STEPS_PER_FRAME) accumulator = 0;

  render(ctx, world, layout, info);
  if (!isEnded(world)) requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
