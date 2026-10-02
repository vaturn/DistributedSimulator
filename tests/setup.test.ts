import { describe, expect, it } from "vitest";

// M0 스모크 테스트: Vitest가 tests/ 아래 TypeScript 테스트를 찾아 실행하는지 확인한다.
describe("프로젝트 셋업", () => {
  it("TypeScript 테스트가 실행되고 단언이 평가된다", () => {
    const values: readonly number[] = [1, 2, 3];
    const sum = values.reduce((acc, v) => acc + v, 0);
    expect(sum).toBe(6);
  });

  it("실패하는 단언은 예외를 던진다", () => {
    expect(() => expect(1).toBe(2)).toThrow();
  });
});
