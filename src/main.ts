// 진입점: 엔진 + 감독관 + 렌더러 + 컨트롤·지표 패널 + 화면 루프를 조립한다 (기획서 §6, §7).
// 상태 변경은 step()에 넘기는 Command로만 일어나고, 렌더러와 패널은 상태를 읽기만 한다.
// 루프 상태(재생/일시정지, 속도, 누적 시간) 계산은 ui/loopState.ts의 순수 함수가 한다.

import { computeMetrics } from "./engine/metrics";
import type { Scenario, SimEvent, WorldState } from "./engine/types";
import { createWorld, isEnded, step } from "./engine/world";
import { render, type RenderInfo } from "./render/canvas";
import { attachDragInput, computeDragView, type DragInput } from "./render/input";
import { computeLayout, type Layout } from "./render/layout";
import { collectResultTypes, createResultColors } from "./render/palette";
import { createToastQueue, type ToastQueue } from "./render/toasts";
import basicScenario from "./scenarios/basic.json";
import { createManualSupervisor, type ManualSupervisor } from "./supervisor/manual";
import { createGreedySupervisor } from "./supervisor/policies/greedy";
import type { Supervisor } from "./supervisor/types";
import { createControls } from "./ui/controls";
import {
  createLoopState,
  markEnded,
  planFrame,
  resetLoopState,
  setSpeedIndex,
  singleStepCount,
  togglePaused,
  type LoopState,
} from "./ui/loopState";
import { createMetricsPanel } from "./ui/metricsPanel";

/** 요소 id (index.html과 맞춘다) */
const CANVAS_ID = "sim-canvas";
const STAGE_ID = "stage";
const CONTROLS_ID = "controls";
const METRICS_ID = "metrics";
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

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} 요소를 찾을 수 없습니다.`);
  return el;
}

const scenario = basicScenario as Scenario;
const choice = supervisorChoiceFromUrl(window.location.search);

const canvas = requireElement(CANVAS_ID, HTMLCanvasElement);
const stage = requireElement(STAGE_ID, HTMLElement);
const ctxOrNull = canvas.getContext("2d");
if (!ctxOrNull) {
  throw new Error("Canvas 2D 컨텍스트를 얻을 수 없습니다.");
}
const ctx: CanvasRenderingContext2D = ctxOrNull;

/** 한 번의 실행(리셋하면 통째로 새로 만든다) */
interface Session {
  world: WorldState;
  supervisor: Supervisor;
  manual: ManualSupervisor | null;
  toasts: ToastQueue;
  info: RenderInfo;
}

/** 같은 시나리오·시드로 월드와 감독관을 새로 만든다. 쌓인 수동 명령·토스트는 버려진다. */
function createSession(): Session {
  const world = createWorld(scenario);
  const manual = choice === "manual" ? createManualSupervisor() : null;
  const supervisor: Supervisor = manual ?? createGreedySupervisor();
  return {
    world,
    supervisor,
    manual,
    toasts: createToastQueue(),
    info: {
      colors: createResultColors(collectResultTypes(scenario)),
      scenarioName: scenario.name,
      supervisorName: supervisor.name,
    },
  };
}

let session: Session = createSession();
let loop: LoopState = createLoopState();
let layout: Layout = resize();

/** 캔버스를 무대(#stage) 크기에 맞추고(devicePixelRatio 반영) 배치를 다시 계산한다. */
function resize(): Layout {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  // 그리기 좌표는 CSS 픽셀로 쓴다.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return computeLayout({ width, height }, [...session.world.modules.values()]);
}

/** 수동 감독관일 때만 드래그 입력을 연결한다. 입력은 manual.submit으로 명령만 넘긴다. */
function attachInput(s: Session): DragInput | null {
  return s.manual
    ? attachDragInput({ canvas, getWorld: () => session.world, getLayout: () => layout, supervisor: s.manual })
    : null;
}
let dragInput: DragInput | null = attachInput(session);

const metricsPanel = createMetricsPanel(requireElement(METRICS_ID, HTMLElement));
const getMetrics = () => computeMetrics(session.world);

/** 엔진 이벤트 중 warning을 토스트로 옮긴다. */
function collectWarnings(events: readonly SimEvent[], now: number): void {
  for (const e of events) {
    if (e.type === "warning") session.toasts.push(e.message, now);
  }
}

/** step을 count번 돌린다. 종료 조건에 도달하면 멈추고 자동 일시정지한다. */
function runSteps(count: number, now: number): void {
  const { world, supervisor } = session;
  for (let i = 0; i < count && !isEnded(world); i++) {
    step(world, supervisor.decide(world));
    // world.events에는 마지막 step의 이벤트만 남으므로 step마다 모은다.
    collectWarnings(world.events, now);
  }
  if (isEnded(world) && !loop.ended) {
    loop = markEnded(loop);
    metricsPanel.update(getMetrics, now, true);
  }
}

/** 현재 상태와 덧그림(드래그, 토스트)을 그린다. */
function draw(now: number): void {
  const { world } = session;
  const current = dragInput?.current() ?? null;
  const drag = current ? computeDragView(world, layout, current.jobId, current.pointer) : null;
  render(ctx, world, layout, session.info, { drag, toasts: session.toasts.active(now), now });
}

/** 컨트롤·지표·캔버스를 즉시 다시 그린다 (버튼 조작 직후). */
function refresh(now: number): void {
  controls.update(loop);
  metricsPanel.update(getMetrics, now, true);
  draw(now);
}

const controls = createControls(requireElement(CONTROLS_ID, HTMLElement), {
  onTogglePlay() {
    loop = togglePaused(loop);
    refresh(performance.now());
  },
  onStep() {
    const now = performance.now();
    // 일시정지 중일 때만 정확히 1 step. 쌓인 수동 명령은 이 step에서 적용된다.
    runSteps(singleStepCount(loop), now);
    refresh(now);
  },
  onReset() {
    // 드래그 상태를 버리고 같은 시나리오·시드로 처음부터 (감독관도 새로 만들어 쌓인 명령 폐기).
    dragInput?.detach();
    session = createSession();
    dragInput = attachInput(session);
    loop = resetLoopState(loop);
    layout = resize();
    refresh(performance.now());
  },
  onSpeedChange(index) {
    loop = setSpeedIndex(loop, index);
    controls.update(loop);
  },
});

new ResizeObserver(() => {
  layout = resize();
  draw(performance.now());
}).observe(stage);

let lastTime: number | null = null;

/** 고정 시간 간격 루프: 경과 시간 × 속도만큼 step을 돌리고 한 번 그린다. */
function frame(now: number): void {
  const elapsed = lastTime === null ? 0 : (now - lastTime) / MS_PER_SECOND;
  lastTime = now;
  const plan = planFrame(loop, elapsed, session.world.config.dt);
  loop = plan.state;
  runSteps(plan.steps, now);
  // 시작부터 종료 조건이 참인 시나리오도 재생 버튼을 막는다.
  if (!loop.ended && isEnded(session.world)) loop = markEnded(loop);

  draw(now);
  controls.update(loop);
  metricsPanel.update(getMetrics, now);
  // 일시정지·종료 후에도 드래그·토스트를 그리기 위해 루프는 계속 돈다 (step만 멈춘다).
  requestAnimationFrame(frame);
}

refresh(performance.now());
requestAnimationFrame(frame);
