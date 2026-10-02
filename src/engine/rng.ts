// 시드 기반 난수 생성기 (mulberry32).
// 엔진은 Math.random 대신 이것만 쓴다. 상태는 32비트 정수 하나라 world에 그대로 저장할 수 있다.

/** mulberry32 상태 증가 상수 */
const MULBERRY_INCREMENT = 0x6d2b79f5;
/** 32비트 부호 없는 정수를 [0,1)로 바꾸는 나눗수 (2^32) */
const UINT32_RANGE = 4294967296;

/** 한 번 뽑은 결과: 난수 값과 다음 상태 */
export interface RngDraw {
  value: number;
  state: number;
}

/** 시드를 RNG 초기 상태로 바꾼다. */
export function seedToState(seed: number): number {
  return seed >>> 0;
}

/** 상태에서 난수 하나를 뽑고 다음 상태를 돌려준다 (순수 함수). */
export function nextRandom(state: number): RngDraw {
  const nextState = (state + MULBERRY_INCREMENT) >>> 0;
  let t = nextState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  return { value, state: nextState };
}

export interface Rng {
  /** [0,1) 난수 */
  next(): number;
  /** 현재 상태 (저장/복원용) */
  getState(): number;
}

/** 시드로 RNG를 만든다. */
export function createRng(seed: number): Rng {
  let state = seedToState(seed);
  return {
    next(): number {
      const draw = nextRandom(state);
      state = draw.state;
      return draw.value;
    },
    getState(): number {
      return state;
    },
  };
}
