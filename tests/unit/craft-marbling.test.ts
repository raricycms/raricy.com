import { describe, expect, it } from 'vitest';
import {
  MARBLING_COLORS,
  MARBLING_H,
  MARBLING_MAX_HISTORY,
  MARBLING_PALETTES,
  MARBLING_SAVE_KEY,
  MARBLING_W,
  clearMarbling,
  colorValueAt,
  colorValueOf,
  combStroke,
  decodeGrid,
  dropPaint,
  emptyGrid,
  encodeGrid,
  freshMarbling,
  gridHasPaint,
  needleStroke,
  parseMarblingDraft,
  reprintMarbling,
  setMarblingColor,
  setMarblingLay,
  setMarblingPalette,
  setMarblingTool,
  takePrint,
  undoMarbling,
  valueHex,
  withGrid,
  type MarblingDraft,
} from '../../src/games/craft/marbling/engine';

/** 逐字节比对两张网格 —— 颜色烘没烘进格子，只有这样才看得出来。 */
function gridBytes(grid: Uint8Array): number[] {
  return Array.from(grid);
}

function countDiff(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) count += 1;
  return count;
}

function draftGrid(draft: MarblingDraft): Uint8Array {
  const grid = decodeGrid(draft.cells);
  if (!grid) throw new Error('草稿里的网格解不出来');
  return grid;
}

describe('水面印花：颜色烘进格子，不是调色板下标', () => {
  it('空格子是 0，颜料值是 1..颜色数', () => {
    expect(emptyGrid().every((value) => value === 0)).toBe(true);
    // 每个调色板的每个颜色都能换成一个正规的颜料值。
    for (const palette of MARBLING_PALETTES) {
      for (const hex of palette.colors) {
        const value = colorValueOf(hex);
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(MARBLING_COLORS.length);
        expect(valueHex(value)).toBe(hex.toLowerCase());
      }
    }
    // 全站颜色表是去重后的并集。
    expect(MARBLING_COLORS.length).toBe(new Set(MARBLING_COLORS).size);
    expect(valueHex(0)).toBeNull();
    expect(valueHex(MARBLING_COLORS.length + 1)).toBeNull();
  });

  it('★ 换调色板不会给已经落下的颜料重新着色（逐字节不变）', () => {
    // 在 A 调色板下滴一滴，记下字节。
    const first = takeDropAt(freshMarbling(), 'jade', 0, 100, 80);
    const before = gridBytes(draftGrid(first));
    expect(gridHasPaint(draftGrid(first))).toBe(true);

    // 换成另外三组调色板，再换回来 —— 颜料一个字节都不该动。
    let switched = first;
    for (const palette of MARBLING_PALETTES) {
      switched = setMarblingPalette(switched, palette.id);
      expect(gridBytes(draftGrid(switched))).toEqual(before);
    }
    switched = setMarblingPalette(switched, 'jade');
    expect(switched.cells).toBe(first.cells);
  });

  it('★ 同一句"第 0 号颜色"在不同调色板下是不同的颜料值', () => {
    // 这就是换调色板时"下一滴"该变的证据 —— 也说明为什么不能存下标。
    const jade = colorValueAt('jade', 0);
    const rose = colorValueAt('rose', 0);
    expect(valueHex(jade)).toBe(MARBLING_PALETTES[0].colors[0].toLowerCase());
    expect(valueHex(rose)).toBe(
      MARBLING_PALETTES.find((entry) => entry.id === 'rose')!.colors[0].toLowerCase(),
    );
    expect(jade).not.toBe(rose);
    // 越界的下标被夹住，不会去查表外。
    expect(colorValueAt('jade', -5)).toBe(colorValueAt('jade', 0));
    expect(colorValueAt('jade', 99)).toBe(colorValueAt('jade', 5));
  });

  it('滴入的颜色就是当前调的这一个，原有颜色被推到圆盘之外', () => {
    const empty = emptyGrid();
    const dropped = dropPaint(empty, 120, 84, 3);
    expect(gridHasPaint(dropped)).toBe(true);
    // 圆心是刚滴的颜色。
    expect(dropped[84 * MARBLING_W + 120]).toBe(3);
    /**
     * 压在下面那一层没有被涂掉，而是被推到了圆盘之外 —— 同心环就是这么长出来的。
     *
     * 断言取两点：圆盘之内全是新色，圆盘之外的老颜色还在。若只断言"圆心是新色"，
     * 一个只会涂圆、不挪旧料的实现也能过。
     */
    const layered = emptyGrid();
    layered.fill(2);
    const pushed = dropPaint(layered, 120, 84, 5);
    expect(pushed[84 * MARBLING_W + 120]).toBe(5);
    // 圆盘之内的老颜色被盖住了。
    expect(pushed[84 * MARBLING_W + 150]).toBe(5);
    // 圆盘之外，老颜色仍然在（被推开而不是被抹掉）。
    expect(pushed[84 * MARBLING_W + 230]).toBe(2);
    // 而且它并没有被新色污染：整张网格只有 2 和 5 两种值。
    const values = new Set(Array.from(pushed));
    expect([...values].sort()).toEqual([2, 5]);
  });

  it('反复滴在同一处会长出同心环 —— 每一滴都留下自己的一圈', () => {
    // 这是水面印花的核心手感：若外圈不推旧料，第二滴会把第一圈整个盖掉，
    // 屏幕上永远只有最后一色。逐滴检查沿半径的颜色序列，才能钉住这件事。
    let grid = emptyGrid();
    const colors = [1, 7, 12, 19, 4];
    colors.forEach((value, index) => {
      grid = dropPaint(grid, 240, 168, value);
      // 每滴完都断一次：圆心是这一滴，外面仍能找到之前滴过的颜色。
      expect(grid[168 * MARBLING_W + 240]).toBe(value);
      if (index > 0) {
        const ring = new Set<number>();
        for (let r = 0; r < 200; r += 1) {
          const x = 240 + r;
          if (x >= MARBLING_W) break;
          const cell = grid[168 * MARBLING_W + x];
          if (cell !== 0) ring.add(cell);
        }
        // 半径上至少还留着上一滴的颜色，说明它没有被这一滴抹掉。
        expect(ring.has(colors[index - 1])).toBe(true);
        // 并且不止一种颜色 —— 真的是一圈套一圈。
        expect(ring.size).toBeGreaterThan(1);
      }
    });
  });

  it('越界的颜料值不落笔 —— 宁可什么都不发生', () => {
    const empty = emptyGrid();
    expect(gridBytes(dropPaint(empty, 120, 84, 0))).toEqual(gridBytes(empty));
    expect(gridBytes(dropPaint(empty, 120, 84, MARBLING_COLORS.length + 1))).toEqual(gridBytes(empty));
    expect(gridBytes(dropPaint(empty, 120, 84, 1.5))).toEqual(gridBytes(empty));
  });
});

/** 在指定调色板下滴一滴，返回新的草稿。 */
function takeDropAt(draft: MarblingDraft, palette: string, color: number, x: number, y: number): MarblingDraft {
  const withPalette = setMarblingColor(setMarblingPalette(draft, palette), color);
  const grid = draftGrid(withPalette);
  const value = colorValueAt(withPalette.palette, withPalette.color);
  return withGrid(withPalette, dropPaint(grid, x, y, value));
}

describe('水面印花：游程编码', () => {
  it('编码解码是往返的，空水盆只占一段', () => {
    const grid = emptyGrid();
    expect(gridHasPaint(grid)).toBe(false);
    const encoded = encodeGrid(grid);
    expect(encoded).toBe(`0:${MARBLING_W * MARBLING_H}`);
    expect(decodeGrid(encoded)).toEqual(grid);

    const marked = emptyGrid();
    marked.fill(2, 0, 10);
    marked.fill(3, 10, 20);
    expect(encodeGrid(marked)).toBe(`2:10,3:10,0:${MARBLING_W * MARBLING_H - 20}`);
    expect(decodeGrid(encodeGrid(marked))).toEqual(marked);
    expect(gridHasPaint(marked)).toBe(true);
  });

  it('坏编码一律拒绝，不会返回半张水盆', () => {
    expect(decodeGrid('')).toBeNull();
    expect(decodeGrid('0:0')).toBeNull();
    expect(decodeGrid('-1:1')).toBeNull();
    expect(decodeGrid('1:-2')).toBeNull();
    expect(decodeGrid('1.5:3')).toBeNull();
    // 超出颜色表的值 —— 存进去就再也没法解析成颜色。
    expect(decodeGrid(`${MARBLING_COLORS.length + 1}:${MARBLING_W * MARBLING_H}`)).toBeNull();
    // 总数不够 / 超过一整个水盆。
    expect(decodeGrid('1:5')).toBeNull();
    expect(decodeGrid(`1:${MARBLING_W * MARBLING_H + 1}`)).toBeNull();
    expect(decodeGrid('nonsense')).toBeNull();
  });
});

describe('水面印花：历史与撤销', () => {
  it('改动画面就记一步，撤销退回去', () => {
    const start = freshMarbling();
    const first = takeDropAt(start, 'jade', 0, 90, 70);
    const second = takeDropAt(first, 'jade', 1, 140, 90);
    expect(second.history.length).toBe(2);
    const undone = undoMarbling(second);
    expect(undone.cells).toBe(first.cells);
    expect(undone.history.length).toBe(1);
    // 一路退到底就停在那里，不会退成空。
    expect(undoMarbling(undoMarbling(undone)).cells).toBe(start.cells);
    expect(undoMarbling(start).history).toEqual([]);
  });

  it('画布没变就不记历史 —— 免得撤销栈被空操作塞满', () => {
    const start = freshMarbling();
    expect(withGrid(start, emptyGrid()).cells).toBe(start.cells);
    expect(withGrid(start, emptyGrid()).history).toEqual([]);
  });

  it('历史有上限，不会无限长', () => {
    let draft = freshMarbling();
    for (let step = 0; step < MARBLING_MAX_HISTORY + 6; step += 1) {
      draft = takeDropAt(draft, 'jade', step % 6, 20 + step * 9, 40 + step * 5);
    }
    expect(draft.history.length).toBe(MARBLING_MAX_HISTORY);
  });

  it('换一盆清水把水面清空，但可以撤销回来', () => {
    const painted = takeDropAt(freshMarbling(), 'jade', 0, 100, 80);
    const cleared = clearMarbling(painted);
    expect(gridHasPaint(draftGrid(cleared))).toBe(false);
    expect(cleared.stage).toBe('water');
    // 清水这一步也进了撤销栈 —— 比弹一个确认框更贴合手上在做的事。
    expect(undoMarbling(cleared).cells).toBe(painted.cells);
  });
});

describe('水面印花：铺纸与揭纸是同一个动作的两头', () => {
  it('往下拖到满是盖住，往上拖回顶是揭起来并留下成品', () => {
    let draft = takeDropAt(freshMarbling(), 'jade', 0, 100, 80);
    // 半途：纸正盖下去。
    draft = setMarblingLay(draft, 0.5);
    expect(draft.stage).toBe('paper');
    expect(draft.lay).toBeCloseTo(0.5, 6);
    // 盖满 —— 颜料吸到纸上。
    draft = setMarblingLay(draft, 1);
    expect(draft.stage).toBe('paper');
    expect(draft.inked).toBe(true);
    expect(draft.print).toBeNull();
    // 揭到顶 —— 这时候才有成品，而且成品的图案就是水面那一份。
    draft = setMarblingLay(draft, 0);
    expect(draft.stage).toBe('print');
    expect(draft.print).toBe(draft.cells);
  });

  it('没盖满就缩回去：纸没碰到水，什么也没印上', () => {
    let draft = takeDropAt(freshMarbling(), 'jade', 0, 100, 80);
    draft = setMarblingLay(draft, 0.4);
    draft = setMarblingLay(draft, 0);
    expect(draft.stage).toBe('water');
    expect(draft.print).toBeNull();
    expect(draft.inked).toBe(false);
  });

  it('进度被夹在 0..1，NaN 不会把状态机弄坏', () => {
    const start = freshMarbling();
    expect(setMarblingLay(start, -3).lay).toBe(0);
    expect(setMarblingLay(start, 7).lay).toBe(1);
    expect(setMarblingLay(start, Number.NaN)).toBe(start);
  });

  it('再印一张：进度归零，水面留着，可以接着印', () => {
    let draft = takeDropAt(freshMarbling(), 'jade', 0, 100, 80);
    draft = setMarblingLay(setMarblingLay(draft, 1), 0);
    expect(draft.stage).toBe('print');
    const again = reprintMarbling(draft);
    expect(again.stage).toBe('water');
    expect(again.lay).toBe(0);
    expect(again.inked).toBe(false);
    // 盆里的颜料还在，成品也还在。
    expect(gridHasPaint(draftGrid(again))).toBe(true);
    expect(again.print).toBe(draft.print);
  });

  it('takePrint 不做镜像 —— 纸吸起颜料，正面看就是水面那一份', () => {
    const painted = takeDropAt(freshMarbling(), 'jade', 0, 100, 80);
    expect(takePrint(painted).print).toBe(painted.cells);
  });
});

describe('水面印花：针与梳子拉出不同的东西', () => {
  /** 一张有渐变的底纹 —— 纯色里做位移是看不出来的（位移前后的颜色一样）。 */
  function texturedGrid(): Uint8Array {
    const grid = emptyGrid();
    for (let y = 0; y < MARBLING_H; y += 1) {
      for (let x = 0; x < MARBLING_W; x += 1) grid[y * MARBLING_W + x] = ((y * 7 + x * 3) % 5) + 1;
    }
    return grid;
  }

  it('针拖出一道局部位移，梳子拉出一排平行纹路', () => {
    const base = texturedGrid();
    const from = { x: 60, y: 80 };
    const to = { x: 150, y: 84 };
    const needled = needleStroke(base, from, to);
    const combed = combStroke(base, from, to);
    // 两者都动了画面，但梳子是一排齿，覆盖面比针大得多。
    expect(countDiff(base, needled)).toBeGreaterThan(0);
    expect(countDiff(base, combed)).toBeGreaterThan(0);
    expect(countDiff(base, combed)).toBeGreaterThan(countDiff(base, needled));
  });

  it('梳齿垂直于拖动方向 —— 横向拖，纹路沿纵向排开', () => {
    // 一整片底纹里拉一条横向的梳子。齿沿法线（纵向）分开，所以改动会覆盖
    // 拖动方向上的一大段，而不是只有一枚齿那么一点。
    const base = texturedGrid();
    const combed = combStroke(base, { x: 60, y: 84 }, { x: 180, y: 84 });
    // 按列统计"这一列有没有被改动"。
    const touched: boolean[] = [];
    for (let x = 0; x < MARBLING_W; x += 1) {
      let any = false;
      for (let y = 0; y < MARBLING_H; y += 1) {
        if (combed[y * MARBLING_W + x] !== base[y * MARBLING_W + x]) { any = true; break; }
      }
      touched.push(any);
    }
    const runs: number[] = [];
    let run = 0;
    for (const flag of touched) {
      if (flag) run += 1;
      else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    // 拖动方向是横向：改动覆盖一大段连续的列，不是一条细线。
    expect(runs.length).toBeGreaterThan(0);
    expect(Math.max(...runs)).toBeGreaterThan(40);
  });

  it('几乎没动的那一下不落笔 —— 原样返回同一个数组', () => {
    const base = texturedGrid();
    expect(needleStroke(base, { x: 50, y: 50 }, { x: 50, y: 50 })).toBe(base);
    expect(combStroke(base, { x: 50, y: 50 }, { x: 50.1, y: 50.1 })).toBe(base);
  });

  it('针与梳子都不改调用方传进来的那张网格', () => {
    const base = texturedGrid();
    const snapshot = Array.from(base);
    needleStroke(base, { x: 40, y: 40 }, { x: 140, y: 100 });
    combStroke(base, { x: 40, y: 40 }, { x: 140, y: 100 });
    expect(Array.from(base)).toEqual(snapshot);
  });
});

describe('水面印花：草稿', () => {
  it('新草稿是空的、水面上、没印过', () => {
    const draft = freshMarbling();
    expect(draft.version).toBe(2);
    expect(draft.stage).toBe('water');
    expect(draft.print).toBeNull();
    expect(draft.lay).toBe(0);
    expect(draft.inked).toBe(false);
    expect(draft.history).toEqual([]);
    expect(gridHasPaint(draftGrid(draft))).toBe(false);
    expect(MARBLING_SAVE_KEY).toBe('craft-marbling-v2');
  });

  it('往返：存下来的草稿能原样读回', () => {
    let draft = takeDropAt(freshMarbling(), 'rose', 3, 120, 90);
    draft = setMarblingTool(draft, 'comb');
    draft = setMarblingLay(draft, 1);
    const parsed = parseMarblingDraft(JSON.stringify(draft));
    expect(parsed).not.toBeNull();
    expect(parsed!.cells).toBe(draft.cells);
    expect(parsed!.tool).toBe('comb');
    expect(parsed!.palette).toBe('rose');
    expect(parsed!.color).toBe(3);
    expect(parsed!.history).toEqual(draft.history);
    expect(parsed!.stage).toBe('paper');
    expect(parsed!.lay).toBe(1);
    expect(parsed!.inked).toBe(true);
  });

  it('版本对不上、字段坏掉的一律读不回来（旧草稿会被静默丢掉）', () => {
    expect(parseMarblingDraft(null)).toBeNull();
    expect(parseMarblingDraft('')).toBeNull();
    expect(parseMarblingDraft('not json')).toBeNull();
    expect(parseMarblingDraft(JSON.stringify({ version: 1, cells: encodeGrid(emptyGrid()) }))).toBeNull();
    expect(parseMarblingDraft(JSON.stringify({ version: 2 }))).toBeNull();
    expect(parseMarblingDraft(JSON.stringify({ version: 2, cells: 'broken' }))).toBeNull();
  });

  it('坏字段被逐个清洗，不会让状态机走不动', () => {
    const cells = encodeGrid(emptyGrid());
    const parsed = parseMarblingDraft(JSON.stringify({
      version: 2,
      cells,
      palette: '不存在的调色板',
      color: 99,
      tool: '锤子',
      history: ['坏:1', 42, cells],
      print: 'broken',
      stage: 'print',
      lay: 5,
      inked: 'yes',
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.palette).toBe(MARBLING_PALETTES[0].id);
    expect(parsed!.color).toBe(0);
    expect(parsed!.tool).toBe('drop');
    // 只留下能解码的那一条历史。
    expect(parsed!.history).toEqual([cells]);
    // 没有成品就不可能是"看成品"这一步。
    expect(parsed!.print).toBeNull();
    expect(parsed!.stage).toBe('water');
    expect(parsed!.lay).toBe(1);
    expect(parsed!.inked).toBe(false);
  });

  it('没有成品却记着 print、或者盖着纸却进度为 0，都被拉回水面', () => {
    const cells = encodeGrid(emptyGrid());
    const noPrint = parseMarblingDraft(JSON.stringify({ version: 2, cells, stage: 'print' }));
    expect(noPrint!.stage).toBe('water');
    const flat = parseMarblingDraft(JSON.stringify({ version: 2, cells, stage: 'paper', lay: 0 }));
    expect(flat!.stage).toBe('water');
  });

  it('成品是合法网格时读得回来', () => {
    const cells = encodeGrid(emptyGrid());
    const parsed = parseMarblingDraft(JSON.stringify({
      version: 2, cells, print: cells, stage: 'print',
    }));
    expect(parsed!.print).toBe(cells);
    expect(parsed!.stage).toBe('print');
  });
});
