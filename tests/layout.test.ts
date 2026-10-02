import { describe, expect, it } from "vitest";
import {
  computeLayout,
  rectInside,
  rectsOverlap,
  slotCenter,
  type Layout,
  type ModuleShape,
  type Rect,
} from "../src/render/layout";

const VIEWPORT = { width: 960, height: 600 };

function shapes(n: number): ModuleShape[] {
  return Array.from({ length: n }, (_, i) => ({ id: `mod${i}`, capacity: (i % 3) + 1 }));
}

/** 모듈 하나가 차지하는 전체 영역 (상자 + 아래 대기열) */
function moduleFootprint(layout: Layout, i: number): Rect {
  const m = layout.modules[i];
  return { x: m.box.x, y: m.box.y, w: m.box.w, h: m.box.h + m.queueArea.h };
}

describe("computeLayout", () => {
  for (const n of [1, 3, 7]) {
    describe(`모듈 ${n}개`, () => {
      const layout = computeLayout(VIEWPORT, shapes(n));

      it("모든 모듈을 시나리오 순서대로 배치한다", () => {
        expect(layout.modules.map((m) => m.id)).toEqual(shapes(n).map((s) => s.id));
      });

      it("모듈 상자와 대기열이 서로, 그리고 대기 구역·상태 표시줄과 겹치지 않는다", () => {
        const areas: Rect[] = [layout.hud, layout.pool, ...layout.modules.map((_, i) => moduleFootprint(layout, i))];
        for (let a = 0; a < areas.length; a++) {
          for (let b = a + 1; b < areas.length; b++) {
            expect(rectsOverlap(areas[a], areas[b]), `영역 ${a}와 ${b}`).toBe(false);
          }
        }
      });

      it("모든 영역이 캔버스 안에 있고 크기가 양수다", () => {
        const areas: Rect[] = [layout.hud, layout.pool, layout.poolContent];
        layout.modules.forEach((_, i) => areas.push(moduleFootprint(layout, i)));
        for (const r of areas) {
          expect(rectInside(r, VIEWPORT)).toBe(true);
          expect(r.w).toBeGreaterThan(0);
          expect(r.h).toBeGreaterThan(0);
        }
      });

      it("슬롯 원이 모듈 상자 안에 있고 서로 겹치지 않는다", () => {
        for (const m of layout.modules) {
          const centers = Array.from({ length: m.capacity }, (_, i) => slotCenter(m, i));
          for (const c of centers) {
            expect(c.x - m.jobRadius).toBeGreaterThanOrEqual(m.box.x);
            expect(c.x + m.jobRadius).toBeLessThanOrEqual(m.box.x + m.box.w);
            expect(c.y - m.jobRadius).toBeGreaterThanOrEqual(m.slotArea.y);
            expect(c.y + m.jobRadius).toBeLessThanOrEqual(m.box.y + m.box.h);
          }
          for (let i = 1; i < centers.length; i++) {
            expect(centers[i].x - centers[i - 1].x).toBeGreaterThanOrEqual(2 * m.jobRadius);
          }
        }
      });

      it("같은 입력이면 같은 배치를 돌려준다 (결정적)", () => {
        expect(computeLayout(VIEWPORT, shapes(n))).toEqual(layout);
      });
    });
  }

  it("좁은 화면에서는 여러 줄로 나누어도 겹치지 않는다", () => {
    const narrow = { width: 400, height: 800 };
    const layout = computeLayout(narrow, shapes(7));
    const rows = new Set(layout.modules.map((m) => m.box.y));
    expect(rows.size).toBeGreaterThan(1);
    for (let a = 0; a < 7; a++) {
      expect(rectInside(moduleFootprint(layout, a), narrow)).toBe(true);
      for (let b = a + 1; b < 7; b++) {
        expect(rectsOverlap(moduleFootprint(layout, a), moduleFootprint(layout, b))).toBe(false);
      }
    }
  });
});
