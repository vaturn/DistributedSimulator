// greedy 정책: 필요한 결과를 주고 가장 빨리 비는 모듈에 배치한다 (기획서 §4.1).
// 규칙 계산(필요한 결과, 대기 시간, 배치 가능 여부)은 모두 engine/rules.ts의 조회 함수를 쓴다.
import { canAssign, canUnassign, estimatedWaitTime, usefulResults } from "../../engine/rules";
import type { Command, Job, JobId, ModuleId } from "../../engine/types";
import type { Supervisor, WorldView } from "../types";

const POLICY_NAME = "greedy";

/** 이번 step에 배치를 결정할 작업: 처리 끝나 모듈을 점유 중인 작업 먼저(슬롯 비우기), 그다음 대기 구역 작업 */
function candidateJobs(view: WorldView): Job[] {
  const done: Job[] = [];
  const pool: Job[] = [];
  for (const job of view.jobs.values()) {
    if (job.state === "DONE_AT_MODULE") done.push(job);
    else if (job.state === "POOL") pool.push(job);
  }
  return [...done, ...pool];
}

/** 이 작업을 보낼 모듈: 필요한 결과를 주고, 배치 가능하고, 예상 대기 시간이 가장 짧은 모듈 (동점은 시나리오 순서) */
function chooseModule(view: WorldView, job: Job, planned: Map<ModuleId, JobId[]>): ModuleId | null {
  let best: ModuleId | null = null;
  let bestWait = Infinity;
  for (const moduleId of view.modules.keys()) {
    if (usefulResults(view, job.id, moduleId).length === 0) continue;
    if (!canAssign(view, job.id, moduleId).ok) continue;
    const wait = estimatedWaitTime(view, moduleId, {
      exceptJobId: job.id,
      extraJobIds: planned.get(moduleId) ?? [],
    });
    if (best === null || wait < bestWait) {
      best = moduleId;
      bestWait = wait;
    }
  }
  return best;
}

export function createGreedySupervisor(): Supervisor {
  return {
    name: POLICY_NAME,
    decide(view: WorldView): Command[] {
      const commands: Command[] = [];
      // 이번 step에 모듈별로 새로 보낸 작업 (같은 step 안에서 한 모듈에 몰리지 않게 대기 시간에 반영)
      const planned = new Map<ModuleId, JobId[]>();
      for (const job of candidateJobs(view)) {
        const target = chooseModule(view, job, planned);
        if (target !== null) {
          commands.push({ type: "assign", jobId: job.id, moduleId: target });
          planned.set(target, [...(planned.get(target) ?? []), job.id]);
        } else if (job.state === "DONE_AT_MODULE" && canUnassign(view, job.id).ok) {
          // 갈 곳이 없으면 슬롯을 비워 다른 작업이 쓰게 한다.
          commands.push({ type: "unassign", jobId: job.id });
        }
      }
      return commands;
    },
  };
}
