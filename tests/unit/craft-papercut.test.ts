import { describe, expect, it } from 'vitest';
import {
  FOLD_OPTIONS,
  MAX_CUTS,
  PAPER_RADIUS,
  PAPER_SAVE_KEY,
  addCut,
  axisCount,
  axisStep,
  clampToWedge,
  cleanPoints,
  clearCuts,
  foldOption,
  freshPaperDraft,
  insideWedge,
  layerCount,
  layerTransform,
  parsePaperDraft,
  pathLength,
  setPaperColor,
  setPaperFolds,
  setUnfold,
  simplifyPoints,
  transformPoint,
  undoCuts,
  unfoldStroke,
  wedgeAngle,
  wedgeAngleOf,
  wedgeBoundary,
  type PaperPoint,
} from '../../src/games/craft/papercut/engine';

/** 楔形内的一条竖切口：沿着靠竖直折痕的一侧从纸心往上。 */
function verticalKerf(folds: 2 | 3, radius = 300): PaperPoint[] {
  // 楔形是 [0, θ]；取 0.2θ，靠近竖直的那条折痕。
  const angle = wedgeAngle(folds) * 0.2;
  const points: PaperPoint[] = [];
  for (let i = 0; i <= 12; i += 1) {
    const r = (radius * i) / 12;
    points.push({ x: r * Math.sin(angle), y: -r * Math.cos(angle) });
  }
  return points;
}

function approx(a: PaperPoint, b: PaperPoint, tolerance = 1e-6): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < tolerance;
}

describe('剪纸窗花：折数与层数', () => {
  it('层数是 2 的折数次方', () => {
    expect(layerCount(2)).toBe(4);
    expect(layerCount(3)).toBe(8);
    expect(foldOption(2)).toEqual(FOLD_OPTIONS[0]);
    expect(foldOption(3).layers).toBe(8);
  });

  it('镜像轴数 = 层数 / 2，相邻轴相距 2π/层数', () => {
    expect(axisCount(2)).toBe(2);
    expect(axisCount(3)).toBe(4);
    // 4 层：两条轴（竖、横），相距 90°。
    expect(axisStep(2)).toBeCloseTo(Math.PI / 2, 10);
    // 8 层：四条轴，相距 45°。
    expect(axisStep(3)).toBeCloseTo(Math.PI / 4, 10);
  });

  it('楔形张角 = 2π/层数（4 层是 90° 的象限，8 层是 45°）', () => {
    expect(wedgeAngle(2)).toBeCloseTo(Math.PI / 2, 10);
    expect(wedgeAngle(3)).toBeCloseTo(Math.PI / 4, 10);
  });

  it('楔形纸的边界从圆心出发，最远不超过纸半径，且落在两条折痕之间', () => {
    for (const folds of [2, 3] as const) {
      const boundary = wedgeBoundary(folds);
      const theta = wedgeAngle(folds);
      expect(boundary[0]).toEqual({ x: 0, y: 0 });
      expect(boundary.some((point) => Math.abs(Math.hypot(point.x, point.y) - PAPER_RADIUS) < 0.5)).toBe(true);
      for (const point of boundary) expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(PAPER_RADIUS + 1e-9);
      // 楔形的角度区间是 [0, θ]，两条直边都是折痕。
      for (const point of boundary) {
        if (Math.hypot(point.x, point.y) < 1) continue;
        const angle = wedgeAngleOf(point.x, point.y);
        expect(angle).toBeGreaterThanOrEqual(-1e-9);
        expect(angle).toBeLessThanOrEqual(theta + 1e-9);
      }
    }
  });
});

describe('剪纸窗花：展开是镜像对称，不是旋转对称', () => {
  it('一条切口展开后关于竖轴镜像对称（这是折叠出来的必然结果）', () => {
    for (const folds of [2, 3] as const) {
      const unfolded = unfoldStroke(verticalKerf(folds), folds).flat();
      for (const point of unfolded) {
        const mirrored = { x: -point.x, y: point.y };
        const hit = unfolded.some((other) => approx(other, mirrored, 1e-6));
        expect(hit, `folds=${folds} 点 (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) 的镜像不在展开结果里`).toBe(true);
      }
    }
  });

  it('一条切口展开后也关于横轴镜像对称（4 层时横轴也是折痕）', () => {
    for (const folds of [2, 3] as const) {
      const unfolded = unfoldStroke(verticalKerf(folds), folds).flat();
      for (const point of unfolded) {
        const mirrored = { x: point.x, y: -point.y };
        const hit = unfolded.some((other) => approx(other, mirrored, 1e-6));
        expect(hit, `folds=${folds} 点 (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) 的横轴镜像不在展开结果里`).toBe(true);
      }
    }
  });

  it('展开后的层数正好铺满整圈，每层落在自己的角度扇区里', () => {
    for (const folds of [2, 3] as const) {
      const layers = layerCount(folds);
      const unfolded = unfoldStroke(verticalKerf(folds), folds);
      expect(unfolded).toHaveLength(layers);
      for (let index = 0; index < layers; index += 1) {
        const center = transformPoint({ x: 0, y: -100 }, folds, index);
        const angle = Math.atan2(center.x, -center.y);
        const step = (Math.PI * 2) / layers;
        const ratio = (((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / step;
        expect(Math.abs(ratio - Math.round(ratio)) * step).toBeLessThan(1e-9);
      }
    }
  });

  it('层变换串与算术一致：奇数层带镜像，偶数层不带', () => {
    for (const folds of [2, 3] as const) {
      for (let index = 0; index < layerCount(folds); index += 1) {
        const text = layerTransform(folds, index);
        expect(text).toMatch(/^rotate\(/);
        if (index % 2 === 1) expect(text).toMatch(/scale\(-1 1\)$/);
        else expect(text).not.toMatch(/scale/);
      }
    }
  });

  it('变换保持半径（等距）', () => {
    for (const folds of [2, 3] as const) {
      for (let index = 0; index < layerCount(folds); index += 1) {
        const point = { x: 37, y: -211 };
        const moved = transformPoint(point, folds, index);
        expect(Math.hypot(moved.x, moved.y)).toBeCloseTo(Math.hypot(point.x, point.y), 9);
      }
    }
  });
});

describe('剪纸窗花：楔形内的坐标', () => {
  it('楔形内的点判为在内，楔形外的判为在外', () => {
    // 4 层时楔形是 [0°, 90°] 这一个象限：正上方到正右方。
    expect(insideWedge(0, -100, 2)).toBe(true);
    expect(insideWedge(60, -60, 2)).toBe(true);
    expect(insideWedge(100, 0, 2)).toBe(true);
    // 正左方与正下方都在别的层上。
    expect(insideWedge(-60, -60, 2)).toBe(false);
    expect(insideWedge(0, 100, 2)).toBe(false);
  });

  it('画到纸外的点被夹回纸内', () => {
    const clamped = clampToWedge(1000, -1000, 2);
    expect(Math.hypot(clamped.x, clamped.y)).toBeLessThanOrEqual(PAPER_RADIUS + 1e-9);
    expect(insideWedge(clamped.x, clamped.y, 2)).toBe(true);
  });

  it('非有限数不会漏进来', () => {
    expect(clampToWedge(Number.NaN, 0, 2)).toEqual({ x: 0, y: 0 });
    expect(clampToWedge(0, Number.POSITIVE_INFINITY, 2)).toEqual({ x: 0, y: 0 });
    expect(cleanPoints([{ x: Number.NaN, y: 5 }], 2)).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('剪纸窗花：折痕摆在楔形的两条直边上', () => {
  it('楔形的一条直边是竖直的（第一次对折留下的折痕）', () => {
    const boundary = wedgeBoundary(2);
    // 第一条折痕边上的点全部 x = 0（正上方）。
    const firstEdge = boundary.filter((point) => point.y < 0 && Math.abs(point.x) < 1e-9);
    expect(firstEdge.length).toBeGreaterThan(0);
  });

  it('两条直边的方位角正好是 0 与 θ', () => {
    for (const folds of [2, 3] as const) {
      const theta = wedgeAngle(folds);
      const boundary = wedgeBoundary(folds);
      const angles = boundary
        .filter((point) => Math.hypot(point.x, point.y) > 1)
        .map((point) => wedgeAngleOf(point.x, point.y));
      const min = Math.min(...angles);
      const max = Math.max(...angles);
      expect(min).toBeCloseTo(0, 6);
      expect(max).toBeCloseTo(theta, 6);
    }
  });

  it('2^折数 层各占一个互不重叠的扇区，合起来铺满整圈', () => {
    for (const folds of [2, 3] as const) {
      const layers = layerCount(folds);
      const theta = wedgeAngle(folds);
      // 取楔形正中一点，看每层把它转到第几个扇区里。
      const mid = { x: 100 * Math.sin(theta / 2), y: -100 * Math.cos(theta / 2) };
      const sectors = new Set<number>();
      for (let index = 0; index < layers; index += 1) {
        const moved = transformPoint(mid, folds, index);
        const angle = wedgeAngleOf(moved.x, moved.y);
        // 归一化到 [0, 2π)，再换算成扇区序号（扇区 j 覆盖 [jθ, (j+1)θ)）。
        const wrapped = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        sectors.add(Math.floor((wrapped + 1e-6) / theta) % layers);
      }
      // 每层落在不同扇区 —— 若铺法错了（楔形居中到 ±θ/2），这里只有一半。
      expect(sectors.size).toBe(layers);
    }
  });
});

describe('剪纸窗花：一笔剪口的分类', () => {
  it('太短的一笔不算剪口', () => {
    const draft = addCut(freshPaperDraft(), [{ x: 0, y: -10 }, { x: 1, y: -12 }]);
    expect(draft.cuts).toHaveLength(0);
  });

  it('沿楔形划一条长线得到一条细缝', () => {
    const draft = addCut(freshPaperDraft(), verticalKerf(2, 280));
    expect(draft.cuts).toHaveLength(1);
    expect(draft.cuts[0].kind).toBe('kerf');
    expect(draft.cuts[0].id).toBe(1);
  });

  it('不管画到纸外多远，剪口都夹在纸内', () => {
    const draft = addCut(freshPaperDraft(), [
      { x: 0, y: 0 },
      { x: 5, y: -2000 },
      { x: 2000, y: -2000 },
    ]);
    expect(draft.cuts).toHaveLength(1);
    for (const point of draft.cuts[0].points) {
      expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(PAPER_RADIUS + 1);
    }
  });

  it('最多 MAX_CUTS 刀，多余的加不进去', () => {
    let draft = freshPaperDraft();
    for (let i = 0; i < MAX_CUTS + 5; i += 1) draft = addCut(draft, verticalKerf(2, 60 + i * 3));
    expect(draft.cuts.length).toBeLessThanOrEqual(MAX_CUTS);
  });
});

describe('剪纸窗花：几何小工具', () => {
  it('折线长度', () => {
    expect(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBeCloseTo(5, 10);
    expect(pathLength([])).toBe(0);
  });

  it('简化保留转折、去掉抖动', () => {
    const noisy = [
      { x: 0, y: 0 },
      { x: 0.2, y: 0.1 },
      { x: 100, y: 0 },
      { x: 100.1, y: 0.2 },
      { x: 100, y: 100 },
    ];
    const simplified = simplifyPoints(noisy, 2.2);
    expect(simplified.length).toBeLessThan(noisy.length);
    expect(simplified[0]).toEqual({ x: 0, y: 0 });
    expect(simplified[simplified.length - 1]).toEqual({ x: 100, y: 100 });
  });
});

describe('剪纸窗花：草稿', () => {
  it('新草稿是空的、还折着、在修剪视图', () => {
    const draft = freshPaperDraft();
    expect(draft.version).toBe(2);
    expect(draft.cuts).toHaveLength(0);
    expect(draft.unfold).toBe(0);
    expect(draft.view).toBe('trim');
    expect(draft.folds).toBe(2);
  });

  it('展开进度夹在 0..1，非有限数不动', () => {
    const base = freshPaperDraft();
    expect(setUnfold(base, 0.4).unfold).toBeCloseTo(0.4, 10);
    expect(setUnfold(base, -3).unfold).toBe(0);
    expect(setUnfold(base, 9).unfold).toBe(1);
    expect(setUnfold(base, Number.NaN)).toBe(base);
    expect(setUnfold(base, Number.POSITIVE_INFINITY)).toBe(base);
  });

  it('已经有刀口时换折法被拒绝（换了层数，旧刀口对不上）', () => {
    const cut = addCut(freshPaperDraft(), verticalKerf(2, 280));
    expect(cut.cuts).toHaveLength(1);
    expect(setPaperFolds(cut, 3).folds).toBe(2);
    expect(setPaperFolds(freshPaperDraft(), 3).folds).toBe(3);
  });

  it('撤销一刀 / 清空刀口', () => {
    let draft = addCut(freshPaperDraft(), verticalKerf(2, 280));
    draft = addCut(draft, verticalKerf(2, 240));
    expect(draft.cuts).toHaveLength(2);
    expect(undoCuts(draft).cuts).toHaveLength(1);
    expect(undoCuts(freshPaperDraft())).toEqual(freshPaperDraft());
    expect(clearCuts(draft).cuts).toHaveLength(0);
    expect(clearCuts(draft).unfold).toBe(0);
  });

  it('纸色只接受登记过的名字', () => {
    expect(setPaperColor(freshPaperDraft(), 'indigo').color).toBe('indigo');
    expect(setPaperColor(freshPaperDraft(), 'not-a-color').color).toBe('vermilion');
  });

  it('草稿键带版本号', () => {
    expect(PAPER_SAVE_KEY).toBe('craft-papercut-v2');
  });

  it('解析：坏数据、旧版本、坏刀口都被挡掉', () => {
    expect(parsePaperDraft(null)).toBeNull();
    expect(parsePaperDraft('not json')).toBeNull();
    expect(parsePaperDraft(JSON.stringify({ version: 1, cuts: [] }))).toBeNull();

    const parsed = parsePaperDraft(JSON.stringify({
      version: 2,
      folds: 7,
      color: 'nope',
      unfold: 2,
      view: 'wat',
      cuts: [
        { kind: 'kerf', points: [{ x: 0, y: 0 }, { x: 0, y: -100 }] },
        { kind: 'bogus', points: [{ x: 0, y: 0 }, { x: 0, y: -100 }] },
        { kind: 'kerf', points: [] },
        { kind: 'pocket', points: [{ x: 0, y: 0 }, { x: 0, y: -100 }] },
      ],
    }))!;
    expect(parsed.folds).toBe(2);
    expect(parsed.color).toBe('vermilion');
    expect(parsed.unfold).toBe(1);
    expect(parsed.view).toBe('trim');
    // 只有第一条是合法的细缝：坏 kind / 空点集 / 缺边界的切块都被丢掉。
    expect(parsed.cuts).toHaveLength(1);
    expect(parsed.cuts[0].kind).toBe('kerf');
  });

  it('解析：纸外的点被丢掉', () => {
    const parsed = parsePaperDraft(JSON.stringify({
      version: 2,
      folds: 2,
      color: 'vermilion',
      unfold: 0,
      view: 'trim',
      cuts: [{ kind: 'kerf', points: [{ x: 0, y: 0 }, { x: 99_999, y: 0 }, { x: 0, y: -100 }] }],
    }))!;
    expect(parsed.cuts[0].points).toHaveLength(2);
  });
});

describe('剪纸窗花：折叠选项', () => {
  it('只有两折与三折，层数与轴数自洽', () => {
    expect(FOLD_OPTIONS).toHaveLength(2);
    for (const option of FOLD_OPTIONS) {
      expect(option.layers).toBe(layerCount(option.folds));
      expect(option.axisCount).toBe(layerCount(option.folds) / 2);
      // 楔形张角 × 层数 = 整圈。
      expect(wedgeAngle(option.folds) * option.layers).toBeCloseTo(Math.PI * 2, 10);
    }
  });
});
