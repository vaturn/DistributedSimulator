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

// ---------- 카운터(해시) 기반 난수: 상태를 이어 쓰지 않고 키에서 바로 난수 흐름을 만든다 ----------

/** FNV-1a 32비트 오프셋 기준값 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32비트 소수 */
const FNV_PRIME = 0x01000193;
/** murmur3 fmix32 곱셈 상수 1 */
const FMIX_MULTIPLIER_1 = 0x85ebca6b;
/** murmur3 fmix32 곱셈 상수 2 */
const FMIX_MULTIPLIER_2 = 0xc2b2ae35;
/** 해시 결합용 황금비 상수 (2^32 / φ) */
const GOLDEN_RATIO_32 = 0x9e3779b9;

/** 문자열을 32비트 정수로 해시한다 (FNV-1a, UTF-16 코드 단위 기준). */
export function hashString(text: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** 32비트 정수를 고르게 섞는다 (murmur3 fmix32). */
export function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, FMIX_MULTIPLIER_1);
  h ^= h >>> 13;
  h = Math.imul(h, FMIX_MULTIPLIER_2);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 여러 32비트 정수를 순서에 따라 하나의 RNG 상태로 결합한다 (같은 입력 → 같은 상태). */
export function combineState(...parts: readonly number[]): number {
  let h = 0;
  for (const part of parts) {
    h = mix32((h ^ (part >>> 0)) + GOLDEN_RATIO_32);
  }
  return h;
}

/** 시드에서 용도별(salt) 독립 상태를 파생한다. 같은 시드라도 salt가 다르면 다른 흐름이 된다. */
export function deriveState(seed: number, salt: number): number {
  return combineState(seedToState(seed), salt);
}

/** 상태 하나에서 시작하는 일회용 난수 함수 (mulberry32). 같은 상태면 같은 난수열. */
export function randomFromState(state: number): () => number {
  let s = state >>> 0;
  return () => {
    const draw = nextRandom(s);
    s = draw.state;
    return draw.value;
  };
}
