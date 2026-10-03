// 진입점: 엔진 + 감독관 + 렌더러 + 컨트롤·지표 패널 + 화면 루프를 조립한다 (기획서 §6, §7).
// 상태 변경은 step()에 넘기는 Command로만 일어나고, 렌더러와 패널은 상태를 읽기만 한다.
// 루프 상태(재생/일시정지, 속도, 누적 시간) 계산은 ui/loopState.ts의 순수 함수가 한다.

import { computeMetrics } from "./engine/metrics";
import { recordCommands, type CommandLogEntry } from "./engine/runner";
import type { Scenario, SimEvent, WorldState } from "./engine/types";
import { createWorld, isEnded, step } from "./engine/world";
import { render, type RenderInfo } from "./render/canvas";
import { attachDragInput, computeDragView, type DragInput } from "./render/input";
import { computeLayout, type Layout } from "./render/layout";
import { collectResultTypes, createResultColors } from "./render/palette";
import { createToastQueue, type ToastQueue } from "./render/toasts";
import { SCENARIOS } from "./scenarios/index";
import { createManualSupervisor, type ManualSupervisor } from "./supervisor/manual";
import { createRegistry } from "./supervisor/registry";
import type { RuleSupervisor } from "./supervisor/rule";
import { BROWSER_RULES } from "./supervisor/rules.browser";
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
import { createExportButton } from "./ui/exportResult";
import { createMetricsPanel } from "./ui/metricsPanel";
import {
  CUSTOM_SCENARIO,
  parseSelectionQuery,
  replaySelectLabels,
  resolveSessionConfig,
  scenarioOptions,
  selectionToQuery,
  scenariosWithCustom,
  supervisorOptions,
  withCustomScenarioName,
  type Selection,
  type SelectionChoices,
  type SessionConfig,
} from "./ui/selection";
import { createSelectors } from "./ui/selectors";
import { compareReplay, replaySessionConfig, replayStopStep, type ReplaySource } from "./ui/replay";
import { createReplayLoader } from "./ui/replayLoader";
import { loadCustomScenario, saveCustomScenario, type StorageLike } from "./ui/scenarioDraft";
import { createScenarioEditor } from "./ui/scenarioEditor";

/** 요소 id (index.html과 맞춘다) */
const CANVAS_ID = "sim-canvas";
const STAGE_ID = "stage";
const CONTROLS_ID = "controls";
const SESSION_CONTROLS_ID = "session-controls";
const METRICS_ID = "metrics";
const EDITOR_ID = "scenario-editor";
/** 밀리초 → 초 */
const MS_PER_SECOND = 1000;
/** 한 번에 콘솔로 내보낼 룰 로그 최대 줄 수 (넘으면 생략 줄 수만 알린다) */
const RULE_LOG_FLUSH_LIMIT = 20;

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} 요소를 찾을 수 없습니다.`);
  return el;
}

/** 편집 시나리오 저장소. 막혀 있으면(사생활 보호 모드 등) null이고, 저장 없이 동작한다. */
function getStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
const storage = getStorage();

/** "모듈 편집"에서 적용한 시나리오 (없으면 null). 새로고침해도 localStorage에서 복원한다. */
let customScenario: Scenario | null = loadCustomScenario(storage);

/** 내장 시나리오 + 사용자 편집 시나리오(있으면) */
const scenarioEntries = () => scenariosWithCustom(SCENARIOS, customScenario);

/** 정책 감독관 목록: 내장 정책 + rules/ 폴더 룰 (빌드 때 묶임) */
const registry = createRegistry(BROWSER_RULES.entries);
/** 룰 로드·등록 오류. 시작 후 콘솔 경고와 토스트로 알린다. */
const ruleLoadErrors: readonly string[] = [...BROWSER_RULES.errors, ...registry.errors];
for (const message of ruleLoadErrors) console.warn(`[rules] ${message}`);

/** 선택 가능한 감독관(수동 + 정책 registry)과 시나리오 */
let choices: SelectionChoices = {
  supervisors: supervisorOptions(registry.policies),
  scenarios: scenarioOptions(scenarioEntries()),
};

/** 시작 시 URL 쿼리에서 선택을 읽는다. 알 수 없는 값은 기본값으로 바꾸고 콘솔에 경고한다. */
function initialSelection(): Selection {
  const parsed = parseSelectionQuery(window.location.search, choices);
  for (const w of parsed.warnings) console.warn(w);
  return parsed.selection;
}

let selection: Selection = initialSelection();
/** 리플레이 중이면 불러온 원본. null이면 일반 모드(선택한 감독관·시나리오) */
let replaySource: ReplaySource | null = null;

const canvas = requireElement(CANVAS_ID, HTMLCanvasElement);
const stage = requireElement(STAGE_ID, HTMLElement);
const ctxOrNull = canvas.getContext("2d");
if (!ctxOrNull) {
  throw new Error("Canvas 2D 컨텍스트를 얻을 수 없습니다.");
}
const ctx: CanvasRenderingContext2D = ctxOrNull;

/** 한 번의 실행(리셋하면 통째로 새로 만든다) */
interface Session {
  config: SessionConfig;
  world: WorldState;
  supervisor: Supervisor;
  manual: ManualSupervisor | null;
  toasts: ToastQueue;
  info: RenderInfo;
  /** 감독관이 step마다 낸 명령 로그 (결과 JSON에 넣는다) */
  commandLog: CommandLogEntry[];
  /** 지금까지 돌린 step 수 (명령 로그의 step 번호) */
  stepCount: number;
  /** 리플레이를 멈출 step 수 (원본이 종료 전 결과일 때). null이면 종료 조건에서 멈춘다 */
  stopStep: number | null;
}

/**
 * 현재 선택(감독관·시나리오)으로 월드와 감독관을 새로 만든다. 쌓인 수동 명령·토스트·명령 로그는 버려진다.
 * 리플레이 중이면 원본의 시나리오 명세·시드로 만들고, 감독관 대신 명령 로그를 처음부터 재생한다.
 */
function createSession(): Session {
  const config = replaySource
    ? replaySessionConfig(replaySource)
    : withCustomScenarioName(resolveSessionConfig(selection, registry.policies, scenarioEntries()));
  const world = createWorld(config.scenario);
  const manual = config.manual ? createManualSupervisor() : null;
  const supervisor: Supervisor = manual ?? createPolicySupervisor(config);
  return {
    config,
    world,
    supervisor,
    manual,
    toasts: createToastQueue(),
    info: {
      // 시나리오가 바뀌면 결과 종류 색도 그 시나리오로 다시 정한다.
      colors: createResultColors(collectResultTypes(config.scenario)),
      scenarioName: config.scenario.name,
      supervisorName: supervisor.name,
    },
    commandLog: [],
    stepCount: 0,
    stopStep: replaySource ? replayStopStep(replaySource.result) : null,
  };
}

/** 룰 기반 감독관인가 (drainLogs가 있으면 룰 로그를 꺼낼 수 있다) */
function isRuleSupervisor(s: Supervisor): s is RuleSupervisor {
  return typeof (s as Partial<RuleSupervisor>).drainLogs === "function";
}

/** 룰 감독관이 남긴 로그(ctx.log)를 콘솔 디버그로 내보낸다. 한 번에 최대 RULE_LOG_FLUSH_LIMIT줄. */
function flushRuleLogs(s: Session): void {
  if (!isRuleSupervisor(s.supervisor)) return;
  const logs = s.supervisor.drainLogs();
  if (logs.length === 0) return;
  const name = s.supervisor.name;
  for (const entry of logs.slice(-RULE_LOG_FLUSH_LIMIT)) {
    console.debug(`[rule:${name}] t=${entry.t.toFixed(2)} ${entry.message}`);
  }
  const skipped = logs.length - RULE_LOG_FLUSH_LIMIT;
  if (skipped > 0) console.debug(`[rule:${name}] 이전 로그 ${skipped}줄 생략`);
}

function createPolicySupervisor(config: SessionConfig): Supervisor {
  if (!config.createPolicy) throw new Error(`정책 감독관을 만들 수 없습니다: ${config.policyName}`);
  return config.createPolicy(config.seed);
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

/**
 * 포인터 입력을 연결한다. hover(작업 정보 툴팁)는 모든 모드에서 쓰고,
 * 드래그 배치는 수동 감독관일 때만 한다(입력은 manual.submit으로 명령만 넘긴다).
 */
function attachInput(s: Session): DragInput {
  return attachDragInput({
    canvas,
    getWorld: () => session.world,
    getLayout: () => layout,
    supervisor: s.manual ?? undefined,
  });
}
let dragInput: DragInput = attachInput(session);

const metricsPanel = createMetricsPanel(requireElement(METRICS_ID, HTMLElement));
const getMetrics = () => computeMetrics(session.world);

/** 엔진 이벤트 중 warning을 토스트로 옮긴다. */
function collectWarnings(events: readonly SimEvent[], now: number): void {
  for (const e of events) {
    if (e.type === "warning") session.toasts.push(e.message, now);
  }
}

/** 더 돌릴 수 없는가: 종료 조건 도달, 또는 리플레이가 원본과 같은 step 수까지 감 */
function sessionFinished(s: Session): boolean {
  return isEnded(s.world) || (s.stopStep !== null && s.stepCount >= s.stopStep);
}

/** 실행이 끝났을 때 한 번: 자동 일시정지, 지표 갱신, 리플레이면 원본 지표와 비교 */
function finishSession(now: number): void {
  loop = markEnded(loop);
  metricsPanel.update(getMetrics, now, true);
  if (replaySource) replayLoader.setComparison(compareReplay(getMetrics(), replaySource));
}

/** step을 count번 돌린다. 종료 조건에 도달하면 멈추고 자동 일시정지한다. */
function runSteps(count: number, now: number): void {
  const s = session;
  const { world, supervisor } = s;
  for (let i = 0; i < count && !sessionFinished(s); i++) {
    const commands = supervisor.decide(world);
    // 수동·정책 공통으로 이번 step에 넘긴 명령을 기록한다 (빈 명령 처리는 recordCommands가 정한다).
    recordCommands(s.commandLog, s.stepCount, world.simTime, commands);
    step(world, commands);
    s.stepCount += 1;
    // world.events에는 마지막 step의 이벤트만 남으므로 step마다 모은다.
    collectWarnings(world.events, now);
  }
  flushRuleLogs(s);
  if (sessionFinished(s) && !loop.ended) finishSession(now);
}

/** 현재 상태와 덧그림(드래그, 토스트)을 그린다. */
function draw(now: number): void {
  const { world } = session;
  const current = dragInput.current();
  const drag = current ? computeDragView(world, layout, current.jobId, current.pointer) : null;
  render(ctx, world, layout, session.info, { drag, toasts: session.toasts.active(now), now });
}

/** 컨트롤·지표·캔버스를 즉시 다시 그린다 (버튼 조작 직후). */
function refresh(now: number): void {
  controls.update(loop);
  metricsPanel.update(getMetrics, now, true);
  draw(now);
}

/**
 * 현재 선택으로 처음부터 다시 시작한다 (리셋과 선택 변경이 같은 경로를 쓴다).
 * 드래그 상태·쌓인 명령·명령 로그를 버리고, 시나리오가 바뀌었으면 배치·색도 다시 계산한다.
 */
function restart(): void {
  dragInput.detach();
  session = createSession();
  dragInput = attachInput(session);
  loop = resetLoopState(loop);
  layout = resize();
  replayLoader.setReplay(replaySource);
  // 리플레이 중에는 select에 "리플레이" 표시 옵션을 보이고, 끝나면 선택을 복원한다.
  selectors.set(selection);
  selectors.showReplay(replaySource ? replaySelectLabels(replaySource.result.policy, replaySource.result.scenario) : null);
  // 실행 중인 시나리오가 바뀌었으면 편집기도 그 시나리오로 다시 채운다 (리셋만 했으면 편집은 그대로).
  scenarioEditor.setBase(session.config.scenario);
  refresh(performance.now());
}

/** 리플레이를 시작한다 (불러온 원본의 처음부터). URL 쿼리는 건드리지 않는다. */
function startReplay(source: ReplaySource): void {
  replaySource = source;
  restart();
}

/** 리플레이를 끝내고 선택한 감독관·시나리오로 돌아간다. */
function exitReplay(): void {
  replaySource = null;
  restart();
}

/** 선택을 URL 쿼리에 반영한다 (새로고침해도 같은 설정). */
function syncQuery(): void {
  const query = selectionToQuery(window.location.search, selection);
  window.history.replaceState(null, "", `${window.location.pathname}${query}${window.location.hash}`);
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
    restart();
  },
  onSpeedChange(index) {
    loop = setSpeedIndex(loop, index);
    controls.update(loop);
  },
});

const sessionControls = requireElement(SESSION_CONTROLS_ID, HTMLElement);
const selectors = createSelectors(sessionControls, choices, selection, {
  onChange(next) {
    // 리플레이 중에 선택을 바꾸면 일반 모드로 돌아간다.
    replaySource = null;
    selection = next;
    syncQuery();
    restart();
  },
});
createExportButton(sessionControls, {
  world: () => session.world,
  meta: () => ({
    scenario: session.config.scenarioName,
    policy: session.config.policyName,
    seed: session.config.seed,
    scenarioSpec: session.config.scenario,
  }),
  commandLog: () => session.commandLog,
});
const replayLoader = createReplayLoader(sessionControls, {
  onLoad: startReplay,
  onError(message) {
    // 현재 세션은 그대로 두고 오류만 알린다.
    replayLoader.showError(message);
    session.toasts.push(message, performance.now());
  },
  onExit: exitReplay,
});
const scenarioEditor = createScenarioEditor(requireElement(EDITOR_ID, HTMLElement), session.config.scenario, {
  onApply(scenario) {
    // 편집 시나리오로 처음부터 다시 시작한다 (감독관 유지, 시드는 시나리오 seed). 리플레이 중이면 일반 모드로.
    customScenario = scenario;
    saveCustomScenario(storage, scenario);
    choices = { ...choices, scenarios: scenarioOptions(scenarioEntries()) };
    selectors.setScenarioOptions(choices.scenarios);
    replaySource = null;
    selection = { ...selection, scenario: CUSTOM_SCENARIO };
    syncQuery();
    restart();
  },
});
syncQuery();
// 룰 로드 오류는 첫 화면에서 토스트로도 알린다 (콘솔에는 위에서 경고함).
for (const message of ruleLoadErrors) session.toasts.push(`룰 로드 오류: ${message}`, performance.now());

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
  if (!loop.ended && sessionFinished(session)) finishSession(now);

  draw(now);
  controls.update(loop);
  metricsPanel.update(getMetrics, now);
  // 일시정지·종료 후에도 드래그·토스트를 그리기 위해 루프는 계속 돈다 (step만 멈춘다).
  requestAnimationFrame(frame);
}

refresh(performance.now());
requestAnimationFrame(frame);
