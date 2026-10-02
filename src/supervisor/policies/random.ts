// random 정책 (기준선): 대기 구역 작업과 처리 끝난 작업 중 일부를 무작위 모듈에 배치한다 (기획서 §4.1).
// 필요한 결과를 주는지는 따지지 않는다. 다만 엔진이 거부할 명령(rules.canAssign 불가)은 내지 않는다.
// 난수는 engine/rng.ts의 시드 RNG만 쓰므로 같은 seed, 같은 월드 흐름이면 같은 명령을 낸다.
import { createRng } from "../../engine/rng";
import { canAssign } from "../../engine/rules";
import type { Command, ModuleId } from "../../engine/types";
import type { Supervisor, WorldView } from "../types";

const POLICY_NAME = "random";
/** step마다 후보 작업 하나를 배치할 확률 */
export const RANDOM_ASSIGN_PROBABILITY = 0.2;

export function createRandomSupervisor(seed: number): Supervisor {
  const rng = createRng(seed);
  return {
    name: POLICY_NAME,
    decide(view: WorldView): Command[] {
      const commands: Command[] = [];
      for (const job of view.jobs.values()) {
        if (job.state !== "POOL" && job.state !== "DONE_AT_MODULE") continue;
        if (rng.next() >= RANDOM_ASSIGN_PROBABILITY) continue;
        const targets: ModuleId[] = [];
        for (const moduleId of view.modules.keys()) {
          if (canAssign(view, job.id, moduleId).ok) targets.push(moduleId);
        }
        if (targets.length === 0) continue;
        const target = targets[Math.floor(rng.next() * targets.length)];
        if (target !== undefined) commands.push({ type: "assign", jobId: job.id, moduleId: target });
      }
      return commands;
    },
  };
}
