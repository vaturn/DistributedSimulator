// "모듈 편집" 패널 (DOM). 모듈 추가·삭제·수정, 작업 도착, 종료 조건·설정을 편집하고
// "적용(재시작)"으로 편집한 시나리오를 콜백에 넘긴다. 시나리오 JSON 저장/불러오기도 여기서 한다.
// 초안 조작과 검증은 scenarioDraft.ts의 순수 함수가 하고(검증은 parseScenario), 여기서는 입력을 옮기고 오류를 표시만 한다.
// 입력 칸에 포커스가 있으면 controls의 단축키(Space/→/R)는 동작하지 않는다(loopState.shortcutFor가 INPUT/SELECT/TEXTAREA를 무시).

import { DEFAULT_CONFIG, type EndCondition, type Scenario } from "../engine/types";
import { download, safePart } from "./exportResult";
import {
  addModule,
  draftToScenario,
  effectiveRequiredPool,
  formatInitialJobsText,
  formatResultListText,
  loadScenarioJson,
  parseInitialJobsText,
  parseResultListText,
  pathMatches,
  removeModule,
  sameDraft,
  scenarioJson,
  scenarioToDraft,
  updateArrival,
  updateDraft,
  updateModule,
  type DraftError,
  type DraftResult,
  type EndKind,
  type ModuleDraft,
  type ScenarioDraft,
} from "./scenarioDraft";

export interface ScenarioEditorCallbacks {
  /** "적용(재시작)": 검증된 시나리오로 처음부터 다시 시작한다 */
  onApply(scenario: Scenario): void;
}

export interface ScenarioEditor {
  /**
   * 실행 중인 시나리오를 편집 기준으로 삼는다. 기준이 바뀌었을 때만(다른 객체) 초안을 그 시나리오로 다시 만든다.
   * 그래서 리셋(같은 시나리오)으로는 적용하지 않은 편집이 사라지지 않는다.
   */
  setBase(scenario: Scenario): void;
}

/** 라벨 */
const LABELS = {
  title: "모듈 편집",
  name: "이름",
  seed: "시드",
  modules: "모듈",
  id: "id",
  resultType: "결과",
  processTime: "처리(s)",
  capacity: "용량",
  defaultValue: "기본값",
  remove: "✕",
  add: "+ 모듈 추가",
  initial: "초기 작업 (한 줄에 하나, 결과는 쉼표로)",
  arrival: "작업 도착",
  arrivalEnabled: "포아송 도착 사용",
  rate: "도착률(개/s)",
  minReq: "최소 결과 수",
  maxReq: "최대 결과 수",
  autoPool: "결과 목록을 모듈 결과 종류로 자동 맞춤",
  pool: "결과 목록",
  settings: "종료 조건·설정",
  end: "종료 조건",
  endValue: "값",
  moveTime: "이동 시간(s)",
  occupyWhenDone: "처리 끝난 작업이 모듈 점유",
  cancelOnMove: "처리 중 이동",
  apply: "✔ 적용(재시작)",
  revert: "↶ 되돌리기",
  save: "⬇ 시나리오 JSON 저장",
  load: "⬆ 시나리오 JSON 불러오기",
  dirty: "적용하지 않은 편집이 있습니다",
  clean: "실행 중인 시나리오와 같습니다",
  invalid: "오류를 고쳐야 적용·저장할 수 있습니다",
  applied: "적용했습니다 — 처음부터 다시 시작합니다",
  loaded: "불러왔습니다 — 적용을 누르면 이 시나리오로 다시 시작합니다",
  loadFailed: "불러오기 실패: ",
  readFailed: "파일을 읽을 수 없습니다.",
  saved: "저장했습니다: ",
} as const;
const TITLES = {
  capacity: "동시에 처리하는 작업 수. 비우면 기본값",
  remove: "이 모듈 삭제",
  add: "마지막 모듈을 복사해 새 id로 추가합니다",
  apply: "편집한 시나리오로 처음부터 다시 시작합니다 (선택한 감독관 유지, 시드는 시나리오 시드)",
  revert: "편집을 버리고 실행 중인 시나리오로 되돌립니다",
  save: "편집한 시나리오를 JSON 파일로 저장합니다",
  load: "시나리오 JSON 파일을 편집기로 불러옵니다",
  pool: "쉼표로 구분",
} as const;
/** 종료 조건 선택지 */
const END_OPTIONS: readonly { value: EndKind; label: string }[] = [
  { value: "default", label: "기본값" },
  { value: "time", label: "시간(s)" },
  { value: "completed", label: "완료 수" },
  { value: "allDone", label: "모든 작업 완료" },
];
/** 참/거짓/기본값 선택지 값 */
const TRI_DEFAULT = "";
const TRI_TRUE = "true";
const TRI_FALSE = "false";
/** 받는 파일 형식 */
const ACCEPT = ".json,application/json";
/** 숫자 입력 칸의 step (소수 허용) */
const DECIMAL_STEP = "any";
/** 초기 작업 textarea 줄 수 */
const INITIAL_ROWS = 3;
/** 저장 파일 확장자 */
const FILE_EXT = ".json";

/** 오류를 붙일 수 있는 입력 칸 (path는 parseScenario 오류 경로) */
interface Field {
  path: string;
  label: string;
  control: HTMLElement | null;
  error: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "ctrl-btn", label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

/** 숫자 칸 값: 비었으면 null, 숫자가 아니면 NaN */
function readOptionalNumber(input: HTMLInputElement): number | null {
  const v = input.value.trim();
  return v === "" ? null : Number(v);
}
function readNumber(input: HTMLInputElement): number {
  return readOptionalNumber(input) ?? Number.NaN;
}
function numberText(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "" : String(v);
}

function triValue(v: boolean | null): string {
  return v === null ? TRI_DEFAULT : v ? TRI_TRUE : TRI_FALSE;
}
function readTri(select: HTMLSelectElement): boolean | null {
  return select.value === TRI_DEFAULT ? null : select.value === TRI_TRUE;
}

function yesNo(v: boolean): string {
  return v ? "예" : "아니오";
}

function endText(end: EndCondition): string {
  switch (end.kind) {
    case "time":
      return `시간 ${end.value}s`;
    case "completed":
      return `완료 ${end.value}개`;
    case "allDone":
      return "모든 작업 완료";
  }
}

/** root 끝에 접이식 "모듈 편집" 패널을 붙인다. */
export function createScenarioEditor(root: HTMLElement, initial: Scenario, callbacks: ScenarioEditorCallbacks): ScenarioEditor {
  let base: Scenario = initial;
  let baseDraft: ScenarioDraft = scenarioToDraft(initial);
  let draft: ScenarioDraft = baseDraft;
  let result: DraftResult = draftToScenario(draft);
  let fields: Field[] = [];
  /** 입력 상태와 따로 바뀌는 칸 (자동 결과 목록, 비활성 상태) */
  let refreshDerived: () => void = () => {};

  const details = el("details", "editor");
  const summary = el("summary", "panel-title editor-summary", LABELS.title);
  const form = el("div", "editor-form");
  const errorList = el("ul", "editor-errors");
  errorList.setAttribute("aria-live", "polite");
  const status = el("span", "ctrl-status editor-status");
  status.setAttribute("aria-live", "polite");
  /** 적용·저장·불러오기 결과 메시지 (편집하면 지운다) */
  let message: { text: string; kind: "ok" | "error" } | null = null;

  const applyBtn = button(LABELS.apply, TITLES.apply, () => {
    if (!result.ok) return;
    // onApply가 재시작하면서 setBase를 부르므로 메시지는 그 뒤에 적는다.
    callbacks.onApply(result.scenario);
    message = { text: LABELS.applied, kind: "ok" };
    applyBtn.blur();
    update();
  });
  applyBtn.classList.add("ctrl-primary");
  const revertBtn = button(LABELS.revert, TITLES.revert, () => {
    setDraft(baseDraft, true);
    message = null;
    update();
  });
  const saveBtn = button(LABELS.save, TITLES.save, () => {
    if (!result.ok) return;
    const fileName = `${safePart(result.scenario.name)}${FILE_EXT}`;
    download(fileName, scenarioJson(result.scenario));
    message = { text: `${LABELS.saved}${fileName}`, kind: "ok" };
    update();
  });

  // 파일 입력은 숨기고 버튼 모양의 label로 연다 (replayLoader와 같은 방식).
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = ACCEPT;
  fileInput.hidden = true;
  const loadLabel = el("label", "ctrl-btn editor-load");
  loadLabel.title = TITLES.load;
  loadLabel.tabIndex = 0;
  loadLabel.append(LABELS.load, fileInput);
  loadLabel.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    file.text().then(
      (text) => {
        const loaded = loadScenarioJson(text);
        if (loaded.ok) {
          setDraft(scenarioToDraft(loaded.scenario), true);
          message = { text: LABELS.loaded, kind: "ok" };
        } else {
          message = { text: `${LABELS.loadFailed}${loaded.message}`, kind: "error" };
        }
        update();
      },
      () => {
        message = { text: `${LABELS.loadFailed}${LABELS.readFailed}`, kind: "error" };
        update();
      },
    );
  });

  const actions = el("div", "editor-actions");
  actions.append(applyBtn, revertBtn, saveBtn, loadLabel, status);
  details.append(summary, form, errorList, actions);
  // 편집 패널 안의 키 입력(접기 제목의 Space, 버튼 위의 R 등)은 시뮬레이션 단축키로 넘기지 않는다.
  // 입력 칸은 원래 shortcutFor가 무시하지만, 패널 전체를 막아 편집 중 실수로 재생·리셋되지 않게 한다.
  details.addEventListener("keydown", (e) => e.stopPropagation());
  root.append(details);

  /** 초안을 바꾼다. rebuild면 입력 칸을 다시 만든다(구조가 바뀔 때만: 포커스를 잃지 않게). */
  function setDraft(next: ScenarioDraft, rebuild: boolean): void {
    draft = next;
    result = draftToScenario(draft);
    if (rebuild) buildForm();
  }

  /** 입력 한 번에 따른 변경 (입력 칸은 그대로 두고 오류·상태만 갱신) */
  function edit(next: ScenarioDraft): void {
    setDraft(next, false);
    message = null;
    update();
  }

  function register(path: string, label: string, control: HTMLElement | null): HTMLElement {
    const error = el("span", "editor-field-error");
    fields.push({ path, label, control, error });
    return error;
  }

  /** 라벨 + 입력 칸 + 오류 자리 */
  function labeled(text: string, control: HTMLElement, path: string, fieldLabel = text): HTMLElement {
    const wrap = el("label", "editor-field");
    wrap.append(el("span", "editor-label", text), control, register(path, fieldLabel, control));
    return wrap;
  }

  function textInput(value: string, onInput: (v: string) => void): HTMLInputElement {
    const input = el("input", "editor-input");
    input.type = "text";
    input.value = value;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function numberInput(value: number | null, onInput: (input: HTMLInputElement) => void, step?: string): HTMLInputElement {
    const input = el("input", "editor-input");
    input.type = "number";
    if (step) input.step = step;
    input.value = numberText(value);
    input.addEventListener("input", () => onInput(input));
    return input;
  }

  function triSelect(value: boolean | null, defaultValue: boolean, onChange: (v: boolean | null) => void): HTMLSelectElement {
    const select = el("select", "editor-input");
    for (const [v, label] of [
      [TRI_DEFAULT, `기본값 (${yesNo(defaultValue)})`],
      [TRI_TRUE, "예"],
      [TRI_FALSE, "아니오"],
    ] as const) {
      const opt = el("option", undefined, label);
      opt.value = v;
      select.append(opt);
    }
    select.value = triValue(value);
    select.addEventListener("change", () => onChange(readTri(select)));
    return select;
  }

  function moduleRow(m: ModuleDraft, i: number): HTMLTableRowElement {
    const row = el("tr");
    const path = `modules[${i}]`;
    const name = `모듈 ${i + 1}`;
    const cell = (control: HTMLElement, key: string, label: string): HTMLTableCellElement => {
      const td = el("td");
      control.setAttribute("aria-label", `${name} ${label}`);
      td.append(control, register(`${path}.${key}`, `${name} ${label}`, control));
      return td;
    };
    const capacity = numberInput(m.capacity, (input) => edit(updateModule(draft, i, { capacity: readOptionalNumber(input) })));
    capacity.placeholder = LABELS.defaultValue;
    capacity.title = TITLES.capacity;
    const remove = button(LABELS.remove, TITLES.remove, () => {
      setDraft(removeModule(draft, i), true);
      message = null;
      update();
    });
    remove.classList.add("editor-remove");
    row.append(
      cell(textInput(m.id, (v) => edit(updateModule(draft, i, { id: v }))), "id", LABELS.id),
      cell(textInput(m.resultType, (v) => edit(updateModule(draft, i, { resultType: v }))), "resultType", LABELS.resultType),
      cell(
        numberInput(m.processTime, (input) => edit(updateModule(draft, i, { processTime: readNumber(input) })), DECIMAL_STEP),
        "processTime",
        LABELS.processTime,
      ),
      cell(capacity, "capacity", LABELS.capacity),
      el("td"),
    );
    row.lastElementChild?.append(remove);
    return row;
  }

  function section(title: string, path: string | null): HTMLElement {
    const s = el("fieldset", "editor-section");
    s.append(el("legend", "panel-subtitle", title));
    if (path) s.append(register(path, title, null));
    return s;
  }

  function buildForm(): void {
    fields = [];

    const head = el("div", "editor-grid");
    head.append(
      labeled(LABELS.name, textInput(draft.name, (v) => edit(updateDraft(draft, { name: v }))), "name"),
      labeled(LABELS.seed, numberInput(draft.seed, (input) => edit(updateDraft(draft, { seed: readNumber(input) }))), "seed"),
    );

    // 모듈 표
    const modules = section(LABELS.modules, "modules");
    const table = el("table", "editor-modules");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of [LABELS.id, LABELS.resultType, LABELS.processTime, LABELS.capacity, ""]) hr.append(el("th", undefined, h));
    thead.append(hr);
    const tbody = el("tbody");
    draft.modules.forEach((m, i) => tbody.append(moduleRow(m, i)));
    table.append(thead, tbody);
    const addBtn = button(LABELS.add, TITLES.add, () => {
      setDraft(addModule(draft), true);
      message = null;
      update();
    });
    modules.append(table, addBtn);

    // 초기 작업
    const initial = el("textarea", "editor-input editor-textarea");
    initial.rows = INITIAL_ROWS;
    initial.value = formatInitialJobsText(draft.initial);
    initial.addEventListener("input", () => edit(updateDraft(draft, { initial: parseInitialJobsText(initial.value) })));
    const initialField = labeled(LABELS.initial, initial, "jobs.initial");

    // 작업 도착
    const arrival = section(LABELS.arrival, "jobs.arrival");
    const enabled = el("input");
    enabled.type = "checkbox";
    enabled.checked = draft.arrival.enabled;
    enabled.addEventListener("change", () => edit(updateArrival(draft, { enabled: enabled.checked })));
    const enabledLabel = el("label", "editor-check");
    enabledLabel.append(enabled, LABELS.arrivalEnabled);
    const rate = numberInput(draft.arrival.rate, (input) => edit(updateArrival(draft, { rate: readNumber(input) })), DECIMAL_STEP);
    const minReq = numberInput(draft.arrival.minReq, (input) => edit(updateArrival(draft, { minReq: readNumber(input) })));
    const maxReq = numberInput(draft.arrival.maxReq, (input) => edit(updateArrival(draft, { maxReq: readNumber(input) })));
    const autoPool = el("input");
    autoPool.type = "checkbox";
    autoPool.checked = draft.arrival.autoPool;
    autoPool.addEventListener("change", () => edit(updateArrival(draft, { autoPool: autoPool.checked })));
    const autoLabel = el("label", "editor-check");
    autoLabel.append(autoPool, LABELS.autoPool);
    const pool = textInput(formatResultListText(effectiveRequiredPool(draft)), (v) =>
      edit(updateArrival(draft, { requiredPool: parseResultListText(v) })),
    );
    pool.title = TITLES.pool;
    const arrivalGrid = el("div", "editor-grid");
    arrivalGrid.append(
      labeled(LABELS.rate, rate, "jobs.arrival.rate"),
      labeled(LABELS.minReq, minReq, "jobs.arrival.minReq"),
      labeled(LABELS.maxReq, maxReq, "jobs.arrival.maxReq"),
    );
    arrival.append(enabledLabel, arrivalGrid, autoLabel, labeled(LABELS.pool, pool, "jobs.arrival.requiredPool"));

    // 종료 조건·설정 (기본값 표시는 엔진 DEFAULT_CONFIG를 읽는다)
    const settings = section(LABELS.settings, "config");
    const endKind = el("select", "editor-input");
    for (const o of END_OPTIONS) {
      const opt = el("option", undefined, o.value === "default" ? `${o.label} (${endText(DEFAULT_CONFIG.endCondition)})` : o.label);
      opt.value = o.value;
      endKind.append(opt);
    }
    endKind.value = draft.end.kind;
    const endValue = numberInput(
      draft.end.value,
      (input) => edit(updateDraft(draft, { end: { ...draft.end, value: readNumber(input) } })),
      DECIMAL_STEP,
    );
    endKind.addEventListener("change", () => {
      const kind = END_OPTIONS.find((o) => o.value === endKind.value)?.value ?? "default";
      edit(updateDraft(draft, { end: { ...draft.end, kind } }));
    });
    const moveTime = numberInput(
      draft.moveTime,
      (input) => edit(updateDraft(draft, { moveTime: readOptionalNumber(input) })),
      DECIMAL_STEP,
    );
    moveTime.placeholder = `기본값 ${DEFAULT_CONFIG.moveTime}`;
    const settingsGrid = el("div", "editor-grid");
    settingsGrid.append(
      labeled(LABELS.end, endKind, "config.endCondition.kind"),
      labeled(LABELS.endValue, endValue, "config.endCondition.value", `${LABELS.end} ${LABELS.endValue}`),
      labeled(LABELS.moveTime, moveTime, "config.moveTime"),
    );
    settings.append(
      settingsGrid,
      labeled(
        LABELS.occupyWhenDone,
        triSelect(draft.occupyWhenDone, DEFAULT_CONFIG.occupyWhenDone, (v) => edit(updateDraft(draft, { occupyWhenDone: v }))),
        "config.occupyWhenDone",
      ),
      labeled(
        LABELS.cancelOnMove,
        triSelect(draft.cancelOnMove, DEFAULT_CONFIG.cancelOnMove, (v) => edit(updateDraft(draft, { cancelOnMove: v }))),
        "config.cancelOnMove",
        `${LABELS.cancelOnMove} (예: 처리 취소, 아니오: 이동 금지)`,
      ),
    );

    refreshDerived = () => {
      const on = draft.arrival.enabled;
      rate.disabled = !on;
      minReq.disabled = !on;
      maxReq.disabled = !on;
      autoPool.disabled = !on;
      pool.disabled = !on || draft.arrival.autoPool;
      // 자동 동기화 중이면 결과 목록 칸에 지금 모듈 결과 종류를 보여 준다.
      if (draft.arrival.autoPool) pool.value = formatResultListText(effectiveRequiredPool(draft));
      endValue.disabled = draft.end.kind === "default" || draft.end.kind === "allDone";
    };

    form.replaceChildren(head, modules, initialField, arrival, settings);
  }

  /** 오류를 가장 가까운(경로가 가장 긴) 칸에 붙인다. 맞는 칸이 없으면 요약에만 보인다. */
  function fieldFor(error: DraftError): Field | null {
    if (error.path === null) return null;
    const path = error.path;
    let best: Field | null = null;
    for (const f of fields) {
      if (pathMatches(path, f.path) && (!best || f.path.length > best.path.length)) best = f;
    }
    return best;
  }

  function showErrors(errors: readonly DraftError[]): void {
    for (const f of fields) {
      f.error.textContent = "";
      f.control?.classList.remove("editor-invalid");
      f.control?.removeAttribute("aria-invalid");
    }
    const items = errors.map((e) => {
      const f = fieldFor(e);
      if (f) {
        f.error.textContent = f.error.textContent ? `${f.error.textContent} ${e.message}` : e.message;
        f.control?.classList.add("editor-invalid");
        f.control?.setAttribute("aria-invalid", "true");
      }
      const where = f?.label ?? e.path;
      return el("li", undefined, where ? `${where}: ${e.message}` : e.message);
    });
    errorList.replaceChildren(...items);
  }

  function update(): void {
    refreshDerived();
    showErrors(result.ok ? [] : result.errors);
    applyBtn.disabled = !result.ok;
    saveBtn.disabled = !result.ok;
    const dirty = !sameDraft(draft, baseDraft);
    revertBtn.disabled = !dirty;
    const text = message?.text ?? (!result.ok ? LABELS.invalid : dirty ? LABELS.dirty : LABELS.clean);
    status.textContent = text;
    status.classList.toggle("ctrl-status-ok", message?.kind === "ok");
    status.classList.toggle("ctrl-status-error", message?.kind === "error" || (!message && !result.ok));
  }

  buildForm();
  update();

  return {
    setBase(scenario) {
      if (scenario === base) return;
      base = scenario;
      baseDraft = scenarioToDraft(scenario);
      setDraft(baseDraft, true);
      message = null;
      update();
    },
  };
}
