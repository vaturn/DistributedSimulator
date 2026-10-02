// 감독관·시나리오 선택 select (기획서 §7 컨트롤). DOM 요소를 만들고 선택 변경을 콜백으로 넘기기만 한다.
// 쿼리 파싱·기본값·세션 설정 결정은 selection.ts의 순수 함수가 한다.

import type { Selection, SelectionChoices, SelectOption } from "./selection";

export interface SelectorsCallbacks {
  /** 사용자가 선택을 바꿨다 (바뀐 뒤의 전체 선택) */
  onChange(selection: Selection): void;
}

export interface Selectors {
  /** 표시 값을 선택에 맞춘다. */
  set(selection: Selection): void;
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
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    select.append(opt);
  }
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

  const current = (): Selection => ({ supervisor: sup.select.value, scenario: scn.select.value });
  for (const select of [sup.select, scn.select]) {
    select.addEventListener("change", () => {
      callbacks.onChange(current());
      // 선택 후 포커스를 풀어 단축키가 바로 동작하게 한다.
      select.blur();
    });
  }
  root.append(sup.label, scn.label);

  const set = (selection: Selection): void => {
    if (sup.select.value !== selection.supervisor) sup.select.value = selection.supervisor;
    if (scn.select.value !== selection.scenario) scn.select.value = selection.scenario;
  };
  set(initial);
  return { set };
}
