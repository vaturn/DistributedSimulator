// 감독관 공용 타입. 감독관은 엔진 상태를 읽기만 하고 Command로만 상태 변경을 요청한다.
import type { Command, WorldState } from "../engine/types";

/** 감독관에게 보여 주는 월드 (읽기 전용으로 다룬다) */
export type WorldView = Readonly<WorldState>;

/** 감독관: 사용자(수동) 또는 정책 알고리즘 */
export interface Supervisor {
  readonly name: string;
  /** 매 step 호출된다. view를 바꾸지 않고 이번 step에 적용할 명령을 돌려준다. */
  decide(view: WorldView): Command[];
}

/** 정책 감독관 목록의 항목 (supervisor/registry). 화면의 감독관 선택과 CLI의 --policy가 같은 항목을 쓴다. */
export interface PolicyEntry {
  /** CLI와 결과 파일에 쓰는 이름 */
  name: string;
  /** 화면에 보이는 이름 */
  label: string;
  /** 감독관을 만든다. 난수를 쓰지 않는 정책은 seed를 무시한다. */
  create(seed: number): Supervisor;
  /** 룰 정책이면 정의한 파일 경로 (예: "rules/greedy.ts") */
  source?: string;
  /** 룰 정책이면 룰 클래스 (같은 룰이 두 경로로 등록될 때 알아보는 데 쓴다) */
  ruleClass?: abstract new () => unknown;
}
