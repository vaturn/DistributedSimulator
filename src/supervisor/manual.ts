// 수동 감독관: 사용자 입력(드래그 앤 드롭)으로 만든 명령을 쌓아 두었다가 다음 step에 넘긴다 (기획서 §6, §7).
// 명령 검증은 하지 않는다. 잘못된 명령은 엔진이 warning 이벤트로 처리한다.
import type { Command } from "../engine/types";
import type { Supervisor, WorldView } from "./types";

const SUPERVISOR_NAME = "manual";

export interface ManualSupervisor extends Supervisor {
  /** 사용자 입력으로 만든 명령을 쌓는다. 다음 decide에서 넣은 순서대로 반환된다. */
  submit(cmd: Command): void;
  /** 아직 엔진에 넘기지 않은 명령 수 */
  pendingCount(): number;
}

export function createManualSupervisor(): ManualSupervisor {
  let pending: Command[] = [];
  return {
    name: SUPERVISOR_NAME,
    submit(cmd: Command): void {
      pending.push(cmd);
    },
    pendingCount(): number {
      return pending.length;
    },
    decide(_view: WorldView): Command[] {
      const out = pending;
      pending = [];
      return out;
    },
  };
}
