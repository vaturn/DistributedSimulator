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
