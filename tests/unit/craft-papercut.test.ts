import { describe, expect, it } from 'vitest';
import {
  addCut, analyzeStroke, clampToWedge, cleanPoints, cutMaskShape, cutRegionPoints,
  EDGE_SNAP, FOLD_OPTIONS, foldOption, freshPaperDraft, insideWedge, KERF_WIDTH, layerAngle, layerCount,
  MAX_CUTS, MAX_POINTS, PAPER_COLORS, PAPER_RADIUS, paperColor, parsePaperDraft,
  pathLength, polygonArea, restartPaper, setPaperView, simplifyPoints, smoothPath, startPaper,
  undoCuts, wedgeBoundary, type PaperCut, type PaperPoint,
} from '../../src/games/craft/papercut/engine';

const HALF45 = Math.PI / 4;

describe('剪纸窗花：折层与楔形纸', () => {
  it('两折四层、三折八层，层角匀分一整圈', () => {
    expect(layerCount(2)).toBe(4);
    expect(layerCount(3)).toBe(8);
    expect(foldOption(2)).toEqual(FOLD_OPTIONS[0]);
    expect(foldOption(3).angle).toBe(45);
    expect(layerAngle(2, 3)).toBe(270);
    expect(layerAngle(3, 7)).toBe(315);
  });

  it('楔形纸的边界从圆心出发，最远不超过纸半径', () => {
    for (const folds of [2, 3] as const) {
      const boundary = wedgeBoundary(folds);
      expect(boundary[0]).toEqual({ x: 0, y: 0 });
      expect(boundary.some((point) => Math.abs(Math.hypot(point.x, point.y) - PAPER_RADIUS) < 0.5)).toBe(true);
      for (const point of boundary) expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(PAPER_RADIUS + 1e-9);
      const half = foldOption(folds).angle * Math.PI / 360;
      for (const point of boundary) {
        if (Math.hypot(point.x, point.y) < 1) continue;
        expect(Math.abs(Math.atan2(point.x, -point.y))).toBeLessThanOrEqual(half + 1e-9);
      }
    }
  });

  it('判定纸内会同时看半径与张角', () => {
    expect(insideWedge(0, -100, 2)).toBe(true);
    expect(insideWedge(0, 100, 2)).toBe(false);
    expect(insideWedge(100, -100, 2)).toBe(true);
    expect(insideWedge(100, -100, 3)).toBe(false);
    expect(insideWedge(30, -82.4, 3)).toBe(true);
    expect(insideWedge(0, -PAPER_RADIUS - 1, 2)).toBe(false);
  });

  it('画到纸外时沿半径与折边夹回，不丢点', () => {
    const clamped = clampToWedge(200, -100, 2);
    const radius = Math.hypot(200, 100);
    expect(clamped.x).toBeCloseTo(radius * Math.sin(HALF45));
    expect(clamped.y).toBeCloseTo(-radius * Math.cos(HALF45));
    expect(clampToWedge(0, -1000, 2)).toEqual({ x: 0, y: -PAPER_RADIUS });
    expect(clampToWedge(Number.NaN, 10, 2)).toEqual({ x: 0, y: 0 });
    const inside = clampToWedge(10, -100, 2);
    expect(inside.x).toBeCloseTo(10);
    expect(inside.y).toBeCloseTo(-100);
  });

  it('清理笔画会舍入、夹回并去掉过密的点', () => {
    const points = cleanPoints([
      { x: 0, y: -100.04 },
      { x: 0, y: -101 },
      { x: 400, y: -400 },
      { x: 400, y: -400 },
    ], 2);
    expect(points[0]).toEqual({ x: 0, y: -100 });
    expect(points).toHaveLength(2);
    expect(Math.hypot(points[1].x, points[1].y)).toBeLessThanOrEqual(PAPER_RADIUS + 0.1);
    expect(cleanPoints(Array.from({ length: MAX_POINTS + 30 }, (_, index) => ({ x: index % 2, y: -index })), 2).length)
      .toBeLessThanOrEqual(MAX_POINTS);
  });

  it('折线简化保留转折、去掉共线抖动', () => {
    const straight = Array.from({ length: 10 }, (_, index) => ({ x: 0, y: -index * 10 }));
    expect(simplifyPoints(straight)).toEqual([straight[0], straight[straight.length - 1]]);
    const corner = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    expect(simplifyPoints(corner)).toEqual(corner);
    expect(pathLength(corner)).toBe(100);
  });
});

describe('剪纸窗花：一笔怎么变成一刀', () => {
  it('太短的一笔不算剪切', () => {
    expect(analyzeStroke([{ x: 0, y: -100 }, { x: 0, y: -108 }], 2)).toBeNull();
    expect(analyzeStroke([{ x: 0, y: -100 }], 2)).toBeNull();
  });

  it('闭合且够长的一笔是孔洞', () => {
    const cut = analyzeStroke([
      { x: 0, y: -100 }, { x: 60, y: -100 }, { x: 60, y: -160 }, { x: 0, y: -160 }, { x: 0, y: -100 },
    ], 2)!;
    expect(cut.kind).toBe('hole');
    expect(cutMaskShape(cut).mode).toBe('fill');
    expect(cutMaskShape(cut).d.endsWith('Z')).toBe(true);
  });

  it('闭合但周长不够的一笔退成细缝', () => {
    const cut = analyzeStroke([{ x: 0, y: -50 }, { x: 20, y: -50 }, { x: 20, y: -70 }, { x: 0, y: -70 }], 2)!;
    expect(cut.kind).toBe('kerf');
    expect(cutMaskShape(cut).mode).toBe('stroke');
  });

  it('两端都贴纸边的一笔是连边切块，沿较近的纸边闭合', () => {
    const start: PaperPoint = { x: -100 * Math.sin(HALF45), y: -100 * Math.cos(HALF45) };
    const end: PaperPoint = { x: 100 * Math.sin(HALF45), y: -100 * Math.cos(HALF45) };
    const cut = analyzeStroke([start, { x: 0, y: -70.7 }, end], 2)!;
    expect(cut.kind).toBe('pocket');
    expect(cut.boundary?.length).toBeGreaterThan(2);
    expect(cutRegionPoints(cut).length).toBeGreaterThan(cut.points.length);
    const shape = cutMaskShape(cut);
    expect(shape.mode).toBe('fill');
    expect(shape.d.endsWith('Z')).toBe(true);
    expect(Math.abs(polygonArea(cutRegionPoints(cut)))).toBeGreaterThan(40);
  });

  it('远离纸边的一笔是细缝，掩膜按剪刀宽度描边', () => {
    const cut = analyzeStroke([{ x: 0, y: -100 }, { x: 0, y: -260 }], 2)!;
    expect(cut.kind).toBe('kerf');
    expect(cut.boundary).toBeUndefined();
    expect(KERF_WIDTH).toBeGreaterThan(0);
    expect(EDGE_SNAP).toBeLessThan(PAPER_RADIUS);
  });

  it('切块与孔洞沿折线重复；撤销退回上一刀', () => {
    let draft = startPaper(freshPaperDraft(), 3, 'indigo');
    draft = addCut(draft, [
      { x: 0, y: -100 }, { x: 60, y: -100 }, { x: 60, y: -160 }, { x: 0, y: -160 }, { x: 0, y: -100 },
    ]);
    draft = addCut(draft, [{ x: 0, y: -200 }, { x: 0, y: -320 }]);
    expect(draft.cuts.map((cut) => cut.kind)).toEqual(['hole', 'kerf']);
    expect(draft.cuts.map((cut) => cut.id)).toEqual([1, 2]);
    expect(draft.color).toBe('indigo');
    expect(undoCuts(draft).cuts).toHaveLength(1);
    expect(undoCuts(freshPaperDraft()).cuts).toHaveLength(0);
  });

  it('剪满之后不再增加刀数', () => {
    const cuts: PaperCut[] = Array.from({ length: MAX_CUTS }, (_, index) => ({
      id: index + 1, kind: 'kerf', points: [{ x: 0, y: -10 }, { x: 0, y: -20 }],
    }));
    const draft = { ...freshPaperDraft(), cuts };
    expect(addCut(draft, [{ x: 0, y: -200 }, { x: 0, y: -320 }])).toBe(draft);
  });

  it('路径生成：开口不闭合、孔洞闭合、单点合法', () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
    expect(smoothPath(points).startsWith('M0 0')).toBe(true);
    expect(smoothPath(points).endsWith('Z')).toBe(false);
    expect(smoothPath(points, true).endsWith('Z')).toBe(true);
    expect(smoothPath([{ x: 5, y: 6 }])).toBe('M5 6');
    expect(smoothPath([])).toBe('');
  });

  it('换纸会丢掉剪法，换视图不会', () => {
    let draft = startPaper(freshPaperDraft(), 2, 'pine');
    draft = addCut(draft, [{ x: 0, y: -100 }, { x: 0, y: -260 }]);
    const windowed = setPaperView(draft, 'window');
    expect(windowed.view).toBe('window');
    expect(windowed.cuts).toHaveLength(1);
    const restarted = restartPaper(draft);
    expect(restarted.started).toBe(false);
    expect(restarted.cuts).toHaveLength(0);
    expect(restarted.view).toBe('trim');
  });
});

describe('剪纸窗花：草稿解析', () => {
  it('坏数据一律丢弃', () => {
    expect(parsePaperDraft(null)).toBeNull();
    expect(parsePaperDraft('not json')).toBeNull();
    expect(parsePaperDraft(JSON.stringify({ version: 2 }))).toBeNull();
    expect(parsePaperDraft('x'.repeat(3_000_001))).toBeNull();
  });

  it('恢复纸色、折法、视图与三类刀口', () => {
    const raw = JSON.stringify({
      version: 1, started: true, folds: 3, color: 'calendula', view: 'window',
      cuts: [
        { id: 1, kind: 'kerf', points: [{ x: 0, y: -100 }, { x: 0, y: -260 }] },
        { id: 2, kind: 'hole', points: [{ x: 0, y: -100 }, { x: 40, y: -100 }, { x: 40, y: -140 }] },
        { id: 3, kind: 'pocket', points: [{ x: 0, y: -100 }, { x: 50, y: -100 }], boundary: [{ x: 0, y: 0 }, { x: -10, y: -10 }] },
      ],
    });
    const parsed = parsePaperDraft(raw)!;
    expect(parsed.started).toBe(true);
    expect(parsed.folds).toBe(3);
    expect(parsed.color).toBe('calendula');
    expect(parsed.view).toBe('window');
    expect(parsed.cuts.map((cut) => cut.kind)).toEqual(['kerf', 'hole', 'pocket']);
    expect(parsed.cuts.map((cut) => cut.id)).toEqual([1, 2, 3]);
    expect(parsed.cuts[2].boundary).toHaveLength(2);
  });

  it('非法刀口、越界点与缺边界的切块被丢掉', () => {
    const raw = JSON.stringify({
      version: 1, started: true, folds: 2, color: 'unknown', view: 'trim',
      cuts: [
        { kind: 'scratch', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { kind: 'kerf', points: [{ x: 0, y: 0 }, { x: 9999, y: 0 }] },
        { kind: 'pocket', points: [{ x: 0, y: -100 }, { x: 10, y: -100 }] },
        { kind: 'hole', points: 'bad' },
      ],
    });
    const parsed = parsePaperDraft(raw)!;
    expect(parsed.folds).toBe(2);
    expect(parsed.color).toBe(PAPER_COLORS[0].id);
    expect(parsed.cuts).toHaveLength(0);
  });

  it('未开始的草稿不允许停在展开视图', () => {
    const raw = JSON.stringify({
      version: 1, started: false, folds: 3, color: 'rice', view: 'unfolded', cuts: [],
    });
    expect(parsePaperDraft(raw)!.view).toBe('trim');
    expect(parsePaperDraft(raw)!.folds).toBe(3);
  });

  it('纸色与折法的取值都走白名单', () => {
    expect(paperColor('vermilion').fill).toBe(PAPER_COLORS[0].fill);
    expect(paperColor('nope')).toBe(PAPER_COLORS[0]);
    expect(paperColor('pine').name).toBe('松绿');
  });
});
