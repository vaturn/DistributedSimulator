// 경고 토스트 목록. 실제 시간(ms)으로 수명을 센다. 순수 로직만 두고 그리기는 canvas.ts가 한다.
// 시간은 호출자가 넘긴다(performance.now() 등). 엔진의 simTime과는 무관하다.

import { TOAST_DURATION_MS, TOAST_MAX } from "./theme";

export interface Toast {
  message: string;
  /** 같은 메시지가 연달아 들어온 횟수 */
  count: number;
  /** 마지막으로 들어온 실제 시각(ms) */
  at: number;
}

export interface ToastOptions {
  max: number;
  durationMs: number;
}

export interface ToastQueue {
  push(message: string, now: number): void;
  /** 아직 사라지지 않은 토스트 (오래된 것 먼저). 만료된 것은 정리한다. */
  active(now: number): readonly Toast[];
}

export function createToastQueue(options: ToastOptions = { max: TOAST_MAX, durationMs: TOAST_DURATION_MS }): ToastQueue {
  let toasts: Toast[] = [];
  const prune = (now: number): void => {
    toasts = toasts.filter((t) => now - t.at < options.durationMs);
  };
  return {
    push(message, now) {
      prune(now);
      const last = toasts[toasts.length - 1];
      if (last && last.message === message) {
        // 같은 경고가 반복되면 줄을 늘리지 않고 횟수만 올린다.
        last.count++;
        last.at = now;
        return;
      }
      toasts.push({ message, count: 1, at: now });
      if (toasts.length > options.max) toasts = toasts.slice(toasts.length - options.max);
    },
    active(now) {
      prune(now);
      return toasts;
    },
  };
}
