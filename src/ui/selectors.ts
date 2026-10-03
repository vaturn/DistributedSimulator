// 감독관·시나리오 선택 select (기획서 §7 컨트롤). DOM 요소를 만들고 선택 변경을 콜백으로 넘기기만 한다.
// 쿼리 파싱·기본값·세션 설정 결정은 selection.ts의 순수 함수가 한다.

import {
  REPLAY_OPTION_VALUE,
  selectionFromSelectValues,
  type ReplaySelectLabels,
  type Selection,
  type SelectionChoices,
  type SelectOption,
} from "./selection";

export interface SelectorsCallbacks {
  /** 사용자가 선택을 바꿨다 (바뀐 뒤의 전체 선택) */
  onChange(selection: Selection): void;
}

export interface Selectors {
  /** 표시 값을 선택에 맞춘다. 리플레이 표시 중이면 표시 옵션을 걷어 낸다. */
  set(selection: Selection): void;
  /**
   * 리플레이 표시 옵션을 골라 둔다 (null이면 아무것도 안 함, set으로 복원).
   * 그래서 리플레이 중에도 이전과 같은 감독관·시나리오를 다시 고를 수 있다.
   */
  showReplay(labels: ReplaySelectLabels | null): void;
  /** 시나리오 옵션 목록을 바꾼다 (사용자 편집 시나리오가 생겼을 때). 표시 값은 다음 set에서 맞춘다. */
  setScenarioOptions(options: readonly SelectOption[]): void;
}

/** 라벨과 설명 */
const LABELS = {
  supervisor: "감독관",
  scenario: "시나리오",
} as const;
const TITLES = {
  supervisor: "감독관을 바꾸면 그 감독관으로 처음부터 다시 시작합니다",
  scenario: "시나리오를 바꾸면 그 시나리오(시나리오 seed)로 처음부터 다시 시작합니다",
} as const;

function fillOptions(select: HTMLSelectElement, options: readonly SelectOption[]): void {
  select.replaceChildren(
    ...options.map((o) => {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      return opt;
    }),
  );
}

function labeledSelect(text: string, title: string, options: readonly SelectOption[]): {
  label: HTMLLabelElement;
  select: HTMLSelectElement;
} {
  const label = document.createElement("label");
  label.className = "ctrl-select";
  label.title = title;
  const span = document.createElement("span");
  span.textContent = text;
  const select = document.createElement("select");
  fillOptions(select, options);
  label.append(span, select);
  return { label, select };
}

/** root 끝에 감독관·시나리오 select를 붙인다. */
export function createSelectors(
  root: HTMLElement,
  choices: SelectionChoices,
  initial: Selection,
  callbacks: SelectorsCallbacks,
): Selectors {
  const sup = labeledSelect(LABELS.supervisor, TITLES.supervisor, choices.supervisors);
  const scn = labeledSelect(LABELS.scenario, TITLES.scenario, choices.scenarios);

  /** 마지막으로 반영한 선택 (리플레이 표시 옵션이 남은 쪽은 이 값을 쓴다) */
  let last: Selection = initial;
  const current = (): Selection =>
    selectionFromSelectValues({ supervisor: sup.select.value, scenario: scn.select.value }, last);
  for (const select of [sup.select, scn.select]) {
    select.addEventListener("change", () => {
      callbacks.onChange(current());
      // 선택 후 포커스를 풀어 단축키가 바로 동작하게 한다.
      select.blur();
    });
  }
  root.append(sup.label, scn.label);

  const removeReplayOption = (select: HTMLSelectElement): void => {
    for (const opt of [...select.options]) {
      if (opt.value === REPLAY_OPTION_VALUE) opt.remove();
    }
  };
  const addReplayOption = (select: HTMLSelectElement, label: string): void => {
    removeReplayOption(select);
    const opt = document.createElement("option");
    opt.value = REPLAY_OPTION_VALUE;
    opt.textContent = label;
    // 목록에서 다시 고를 수는 없고 표시만 한다.
    opt.disabled = true;
    select.prepend(opt);
    select.value = REPLAY_OPTION_VALUE;
  };

  const set = (selection: Selection): void => {
    last = selection;
    removeReplayOption(sup.select);
    removeReplayOption(scn.select);
    if (sup.select.value !== selection.supervisor) sup.select.value = selection.supervisor;
    if (scn.select.value !== selection.scenario) scn.select.value = selection.scenario;
  };
  const showReplay = (labels: ReplaySelectLabels | null): void => {
    if (!labels) return;
    addReplayOption(sup.select, labels.supervisor);
    addReplayOption(scn.select, labels.scenario);
  };
  const setScenarioOptions = (options: readonly SelectOption[]): void => {
    fillOptions(scn.select, options);
    scn.select.value = last.scenario;
  };
  set(initial);
  return { set, showReplay, setScenarioOptions };
}
