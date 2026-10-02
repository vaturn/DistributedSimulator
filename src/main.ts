// 진입점: 엔진 + 감독관 + 렌더러 + 화면 루프를 조립한다 (기획서 §6).
// 상태 변경은 step()에 넘기는 Command로만 일어나고, 렌더러는 상태를 읽기만 한다.

import type { Scenario, SimEvent } from "./engine/types";
import { createWorld, isEnded, step } from "./engine/world";
import { render, type RenderInfo } from "./render/canvas";
import { attachDragInput, computeDragView, type DragInput } from "./render/input";
import { computeLayout, type Layout } from "./render/layout";
import { collectResultTypes, createResultColors } from "./render/palette";
import { createToastQueue } from "./render/toasts";
import basicScenario from "./scenarios/basic.json";
import { createManualSupervisor } from "./supervisor/manual";
import { createGreedySupervisor } from "./supervisor/policies/greedy";
import type { Supervisor } from "./supervisor/types";

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

/** 감독관을 고르는 URL 쿼리 이름 (?supervisor=manual|greedy). 선택 UI는 M5에서 만든다. */
const SUPERVISOR_QUERY = "supervisor";
const SUPERVISOR_CHOICES = ["manual", "greedy"] as const;
type SupervisorChoice = (typeof SUPERVISOR_CHOICES)[number];
const DEFAULT_SUPERVISOR: SupervisorChoice = "manual";

function isSupervisorChoice(v: string): v is SupervisorChoice {
  return (SUPERVISOR_CHOICES as readonly string[]).includes(v);
}

/** URL 쿼리에서 감독관을 고른다. 없으면 기본값, 알 수 없는 값이면 기본값 + 콘솔 경고 */
function supervisorChoiceFromUrl(search: string): SupervisorChoice {
  const raw = new URLSearchParams(search).get(SUPERVISOR_QUERY);
  if (raw === null) return DEFAULT_SUPERVISOR;
  if (isSupervisorChoice(raw)) return raw;
  console.warn(
    `알 수 없는 감독관 "${raw}" → ${DEFAULT_SUPERVISOR}로 실행합니다. 가능한 값: ${SUPERVISOR_CHOICES.join(", ")}`,
  );
  return DEFAULT_SUPERVISOR;
}

const scenario = basicScenario as Scenario;
const world = createWorld(scenario);
const choice = supervisorChoiceFromUrl(window.location.search);
const manual = choice === "manual" ? createManualSupervisor() : null;
const supervisor: Supervisor = manual ?? createGreedySupervisor();
const toasts = createToastQueue();
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

/** 수동 감독관일 때만 드래그 입력을 연결한다. 입력은 manual.submit으로 명령만 넘긴다. */
const dragInput: DragInput | null = manual
  ? attachDragInput({ canvas, getWorld: () => world, getLayout: () => layout, supervisor: manual })
  : null;

/** 엔진 이벤트 중 warning을 토스트로 옮긴다. */
function collectWarnings(events: readonly SimEvent[], now: number): void {
  for (const e of events) {
    if (e.type === "warning") toasts.push(e.message, now);
  }
}

/** 현재 상태와 덧그림(드래그, 토스트)을 그린다. */
function draw(now: number): void {
  const current = dragInput?.current() ?? null;
  const drag = current ? computeDragView(world, layout, current.jobId, current.pointer) : null;
  render(ctx, world, layout, info, { drag, toasts: toasts.active(now), now });
}

window.addEventListener("resize", () => {
  layout = resize();
  draw(performance.now());
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
    // world.events에는 마지막 step의 이벤트만 남으므로 step마다 모은다.
    collectWarnings(world.events, now);
    accumulator -= dt;
    steps++;
  }
  // 상한에 걸려 밀린 시간은 버린다 (따라잡으려다 화면이 멈추지 않게).
  if (steps >= MAX_STEPS_PER_FRAME) accumulator = 0;

  draw(now);
  // 종료 후에도 드래그·토스트를 그리기 위해 루프는 계속 돈다 (step만 멈춘다).
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
