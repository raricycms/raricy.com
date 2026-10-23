import { describe, expect, it } from 'vitest';
import {
  clearMarbling, combStroke, decodeGrid, dropPaint, emptyGrid, encodeGrid, freshMarbling,
  gridHasPaint, MARBLING_COLOR_COUNT, MARBLING_EMPTY, MARBLING_H, MARBLING_PALETTES, MARBLING_W,
  marblingPalette, needleStroke, parseMarblingDraft, printMarbling, setMarblingColor,
  setMarblingPalette, setMarblingTool, type MarblingDraft,
} from '../../src/games/craft/marbling/engine';

const INDEX = (x: number, y: number) => y * MARBLING_W + x;

function paintedGrid(color = 1): Uint8Array {
  return new Uint8Array(MARBLING_W * MARBLING_H).fill(color);
}

function countDiff(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) count += 1;
  return count;
}

describe('水面印花：色格与游程编码', () => {
  it('编码解码是往返的，空水盆只占一段', () => {
    const grid = emptyGrid();
    expect(gridHasPaint(grid)).toBe(false);
    const encoded = encodeGrid(grid);
    expect(encoded).toBe(`${MARBLING_EMPTY}:${MARBLING_W * MARBLING_H}`);
    expect(decodeGrid(encoded)).toEqual(grid);

    const marked = emptyGrid();
    marked.fill(2, 0, 10);
    marked.fill(3, 10, 20);
    expect(encodeGrid(marked)).toBe(`2:10,3:10,${MARBLING_EMPTY}:${MARBLING_W * MARBLING_H - 20}`);
    expect(decodeGrid(encodeGrid(marked))).toEqual(marked);
    expect(gridHasPaint(marked)).toBe(true);
  });

  it('坏编码一律拒绝，不会返回半张水盆', () => {
    expect(decodeGrid('')).toBeNull();
    expect(decodeGrid('0:0')).toBeNull();
    expect(decodeGrid('-1:1')).toBeNull();
    expect(decodeGrid('256:1')).toBeNull();
    expect(decodeGrid('1:1.5')).toBeNull();
    expect(decodeGrid('x:1')).toBeNull();
    expect(decodeGrid('1:1,')).toBeNull();
    expect(decodeGrid('1:100')).toBeNull();
    expect(decodeGrid(`1:${MARBLING_W * MARBLING_H},1:1`)).toBeNull();
  });
});

describe('水面印花：滴、针与梳', () => {
  it('滴管把新颜色落进中心，不修改原网格', () => {
    const empty = emptyGrid();
    const dropped = dropPaint(empty, 100, 70, 4);
    expect(dropped).not.toBe(empty);
    expect(dropped[INDEX(100, 70)]).toBe(4);
    expect(empty[INDEX(100, 70)]).toBe(MARBLING_EMPTY);
    expect(dropped[INDEX(5, 5)]).toBe(MARBLING_EMPTY);
    expect(gridHasPaint(dropped)).toBe(true);

    const filled = paintedGrid(1);
    const pushed = dropPaint(filled, 100, 70, 2);
    expect(pushed[INDEX(100, 70)]).toBe(2);
    expect(pushed[INDEX(100, 92)]).toBe(1);
    expect(pushed[INDEX(0, 0)]).toBe(1);
    expect(Array.from(pushed).includes(MARBLING_EMPTY)).toBe(false);
    expect(pushed).not.toBe(filled);
  });

  it('非法颜色与画布外的滴点不改变颜色', () => {
    const grid = paintedGrid(1);
    expect(dropPaint(grid, 100, 70, -1)).toBe(grid);
    expect(dropPaint(grid, 100, 70, MARBLING_COLOR_COUNT)).toBe(grid);
    expect(dropPaint(emptyGrid(), -200, -200, 2)).toEqual(emptyGrid());
  });

  it('针会把拖过位置的颜色沿运动方向带出来', () => {
    const stripe = emptyGrid();
    for (let y = 0; y < MARBLING_H; y += 1) stripe[INDEX(100, y)] = 3;
    const dragged = needleStroke(stripe, { x: 80, y: 70 }, { x: 100, y: 70 });
    expect(dragged).not.toBe(stripe);
    expect(stripe[INDEX(104, 70)]).toBe(MARBLING_EMPTY);
    expect(dragged[INDEX(104, 70)]).toBe(3);
    expect(countDiff(dragged, stripe)).toBeGreaterThan(0);
    expect(needleStroke(stripe, { x: 50, y: 50 }, { x: 50.1, y: 50.2 })).toEqual(stripe);
  });

  it('梳子一次拖出多排平行纹理', () => {
    const grid = emptyGrid();
    for (let y = 0; y < MARBLING_H; y += 1) {
      for (let x = 0; x < MARBLING_W; x += 1) grid[INDEX(x, y)] = (x + y) % MARBLING_COLOR_COUNT;
    }
    const combed = combStroke(grid, { x: 100, y: 70 }, { x: 130, y: 70 });
    expect(combed).not.toBe(grid);
    expect(countDiff(combed, grid)).toBeGreaterThan(50);
    expect(Array.from(combed).some((value) => value >= MARBLING_COLOR_COUNT)).toBe(false);
    expect(combStroke(grid, { x: 50, y: 50 }, { x: 50, y: 50.2 })).toEqual(grid);
  });
});

describe('水面印花：配色、工具与草稿', () => {
  it('配色与颜料选择都走白名单与上下界', () => {
    let draft = freshMarbling();
    draft = setMarblingPalette(draft, 'rose');
    expect(draft.palette).toBe('rose');
    expect(setMarblingPalette(draft, 'nope').palette).toBe(MARBLING_PALETTES[0].id);
    expect(setMarblingColor(draft, -3).color).toBe(0);
    expect(setMarblingColor(draft, 99).color).toBe(MARBLING_COLOR_COUNT - 1);
    expect(setMarblingColor(draft, 2.6).color).toBe(3);
    expect(setMarblingTool(draft, 'comb').tool).toBe('comb');
    expect(marblingPalette('ember').name).toBe('晚霞');
  });

  it('印张快照记下当时的配色，清空只洗水面', () => {
    const grid = emptyGrid();
    grid[INDEX(100, 70)] = 2;
    const print = printMarbling(grid, 'indigo');
    expect(print.palette).toBe('indigo');
    expect(decodeGrid(print.cells)).toEqual(grid);
    expect(printMarbling(grid, 'nope').palette).toBe(MARBLING_PALETTES[0].id);

    const draft: MarblingDraft = { ...freshMarbling(), palette: 'rose', color: 4, tool: 'comb', print, stage: 'print' };
    const cleared = clearMarbling(draft);
    expect(cleared.stage).toBe('water');
    expect(cleared.print).toBeNull();
    expect(cleared.cells).toBe(encodeGrid(emptyGrid()));
    expect(cleared.palette).toBe('rose');
    expect(cleared.color).toBe(4);
    expect(cleared.tool).toBe('comb');
  });

  it('合法草稿原样恢复', () => {
    const source: MarblingDraft = {
      ...freshMarbling(), palette: 'ember', color: 3, tool: 'needle', stage: 'water',
    };
    const parsed = parseMarblingDraft(JSON.stringify(source))!;
    expect(parsed).toEqual(source);
  });

  it('坏格子、坏版本与超长内容一律丢弃', () => {
    const base = freshMarbling();
    expect(parseMarblingDraft(null)).toBeNull();
    expect(parseMarblingDraft('{')).toBeNull();
    expect(parseMarblingDraft(JSON.stringify({ ...base, version: 2 }))).toBeNull();
    expect(parseMarblingDraft(JSON.stringify({ ...base, cells: '1:3' }))).toBeNull();
    expect(parseMarblingDraft(JSON.stringify({ ...base, cells: 42 }))).toBeNull();
    expect(parseMarblingDraft('x'.repeat(4_000_001))).toBeNull();
  });

  it('未知配色、颜料、工具回落到默认值；坏印张被丢掉', () => {
    const parsed = parseMarblingDraft(JSON.stringify({
      version: 1, palette: 'nope', color: 99, tool: 'fork', cells: encodeGrid(emptyGrid()),
      print: { palette: 'nope', cells: 'bad' }, stage: 'print',
    }))!;
    expect(parsed.palette).toBe(MARBLING_PALETTES[0].id);
    expect(parsed.color).toBe(0);
    expect(parsed.tool).toBe('drop');
    expect(parsed.print).toBeNull();
    expect(parsed.stage).toBe('water');
  });

  it('有印张才能停在印张视图，覆纸状态可以续存', () => {
    const grid = emptyGrid();
    grid[INDEX(50, 50)] = 1;
    const print = printMarbling(grid, 'jade');
    const kept = parseMarblingDraft(JSON.stringify({
      ...freshMarbling(), print, stage: 'print',
    }))!;
    expect(kept.print).toEqual(print);
    expect(kept.stage).toBe('print');
    const paper = parseMarblingDraft(JSON.stringify({ ...freshMarbling(), stage: 'paper' }))!;
    expect(paper.stage).toBe('paper');
  });
});
