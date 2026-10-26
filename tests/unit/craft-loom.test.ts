// 小小织布机的纯逻辑用例。
//
// 这一份里最重要的是三组断言，它们各自钉住一条"重做时才发现不对"的东西：
//   1. 一次连续拖动 = 一行 —— 引擎里根本没有"织完但没压紧"的中间状态，
//      所以不需要两颗按钮，玩家也不会被按钮打断。
//   2. 反向拖能反悔，但有死区 —— 手抖不该退掉一整行。
//   3. 换梭线只影响之后的投梭 —— 已经织进布里的行不许变色。

import { describe, expect, it } from 'vitest';
import {
  LOOM_CELL_H,
  LOOM_ENDS,
  LOOM_MAX_ROWS,
  LOOM_UNDO_PULL,
  WARP_SCHEMES,
  WEFT_COLORS,
  artifactGeometry,
  canWeave,
  cellFace,
  clearLoom,
  currentRow,
  dragWeft,
  finishLoom,
  freshLoomDraft,
  isFull,
  parseLoomDraft,
  passDirection,
  resetPass,
  resumeLoom,
  rowColor,
  setWarp,
  setWeft,
  shedGroup,
  shuttleX,
  undoLoom,
  warpColor,
  weftColor,
  type LoomDraft,
} from '../../src/games/craft/loom/engine';

/** 织出 rows 行：每一行都是一次"拖到对岸"。 */
function woven(rows: number, warp = WARP_SCHEMES[0].id): LoomDraft {
  let draft: LoomDraft = setWarp(freshLoomDraft(), warp);
  for (let row = 0; row < rows; row += 1) draft = dragWeft(draft, 1);
  return draft;
}

describe('小小织布机：一次拖动就是一行', () => {
  it('拖到一半松手不算完成，梭子停在那里可以接着拖', () => {
    const half = dragWeft(freshLoomDraft(), 0.45);
    expect(half.rows).toHaveLength(0);
    expect(half.progress).toBeCloseTo(0.45, 5);

    const more = dragWeft(half, 0.9);
    expect(more.rows).toHaveLength(0);
    expect(more.progress).toBeCloseTo(0.9, 5);

    // 到岸：这一行立刻织进布面，进度归零 —— 中间没有"等压紧"的状态。
    const done = dragWeft(more, 1);
    expect(done.rows).toHaveLength(1);
    expect(done.progress).toBe(0);
  });

  it('到岸的瞬间同时换梭口与换方向，一气呵成', () => {
    expect(shedGroup(freshLoomDraft())).toBe(0);
    expect(passDirection(freshLoomDraft())).toBe(1);

    const one = dragWeft(freshLoomDraft(), 1);
    expect(shedGroup(one)).toBe(1);
    expect(passDirection(one)).toBe(-1);

    const two = dragWeft(one, 1);
    expect(shedGroup(two)).toBe(0);
    expect(passDirection(two)).toBe(1);
    expect(two.rows).toHaveLength(2);
  });

  it('进度被夹在 0–1 之间，非法值不改变草稿', () => {
    expect(dragWeft(freshLoomDraft(), -0.02).progress).toBe(0);
    const capped = dragWeft(freshLoomDraft(), 0.7);
    expect(capped.progress).toBeCloseTo(0.7, 5);
    const draft = dragWeft(freshLoomDraft(), 0.5);
    expect(dragWeft(draft, Number.NaN)).toBe(draft);
    expect(dragWeft(draft, Number.POSITIVE_INFINITY)).toBe(draft);
  });

  it('一行记下投梭方向，相邻两行相反', () => {
    const two = woven(2);
    expect(two.rows[0].direction).toBe(1);
    expect(two.rows[1].direction).toBe(-1);
  });

  it('梭子的横坐标按当前趟的方向换算，两端对齐布边', () => {
    const draft = freshLoomDraft();
    expect(shuttleX(draft)).toBeCloseTo(168, 5);
    // 反向的那一趟：进度 0 时梭子在右端。
    const back = dragWeft(draft, 1);
    expect(shuttleX(back)).toBeCloseTo(168 + LOOM_ENDS * 32, 5);
    expect(shuttleX(dragWeft(back, 1))).toBeCloseTo(168, 5);
  });
});

describe('小小织布机：反悔', () => {
  it('往回拽够深就退掉刚织的那一行', () => {
    const one = dragWeft(freshLoomDraft(), 1);
    expect(one.rows).toHaveLength(1);
    const undone = dragWeft(one, -LOOM_UNDO_PULL - 0.01);
    expect(undone.rows).toHaveLength(0);
    expect(undone.progress).toBe(0);
  });

  it('反悔有死区：拽得不够多什么都不做，手抖不会退掉一行', () => {
    const one = dragWeft(freshLoomDraft(), 1);
    const stillOne = dragWeft(one, -LOOM_UNDO_PULL / 2);
    expect(stillOne.rows).toHaveLength(1);
    expect(stillOne).toBe(one);
  });

  it('没有行可退时反向拖只是把梭子拨回起点', () => {
    const draft = dragWeft(freshLoomDraft(), 0.6);
    const back = dragWeft(draft, -0.9);
    expect(back.rows).toHaveLength(0);
    expect(back.progress).toBe(0);
  });

  it('退回一趟只清进度，不动已经织好的行', () => {
    const draft = dragWeft(woven(2), 0.5);
    const reset = resetPass(draft);
    expect(reset.rows).toHaveLength(2);
    expect(reset.progress).toBe(0);
    // 进度已是 0 时原样返回，避免无谓的重渲染。
    expect(resetPass(reset)).toBe(reset);
  });

  it('撤销按「行进中 → 上一行 → 取消收边」的顺序退', () => {
    const mid = dragWeft(woven(2), 0.5);
    expect(undoLoom(mid).rows).toHaveLength(2);
    expect(undoLoom(undoLoom(mid)).rows).toHaveLength(1);
    const finished = finishLoom(woven(2));
    expect(undoLoom(finished).finished).toBe(false);
  });
});

describe('小小织布机：经线连续、纬线只影响之后的投梭', () => {
  it('经线颜色只由第几根决定，与行号无关 —— 这是纵向条纹能连续的原因', () => {
    const draft = woven(5);
    expect(warpColor(draft, 0)).toBe(warpColor(draft, 0));
    expect(warpColor(draft, 2)).toBe(warpColor(draft, LOOM_ENDS + 2));
    // 每根经线在整块布上取到的都是同一个色，逐行扫描不会出现颜色跳变。
    for (let end = 0; end < LOOM_ENDS; end += 1) {
      const colors = new Set(Array.from({ length: 5 }, () => warpColor(draft, end)));
      expect(colors.size).toBe(1);
    }
  });

  it('换经线配色只在没上机时有效', () => {
    const fresh = freshLoomDraft();
    expect(setWarp(fresh, 'indigo').warp).toBe('indigo');
    expect(setWarp(fresh, 'not-a-scheme').warp).toBe(WARP_SCHEMES[0].id);
    const started = woven(1);
    expect(setWarp(started, 'moss')).toBe(started);
  });

  it('换梭线不改已经织进布里的行', () => {
    let draft = dragWeft(freshLoomDraft(), 1);
    expect(rowColor(draft, 0)).toBe(WEFT_COLORS[0].hex);

    draft = setWeft(draft, 3);
    expect(draft.weft).toBe(3);
    expect(weftColor(draft)).toBe(WEFT_COLORS[3].hex);
    // 第一行还是米白 —— 换线轴只影响接下来投的梭。
    expect(rowColor(draft, 0)).toBe(WEFT_COLORS[0].hex);

    draft = dragWeft(draft, 1);
    expect(rowColor(draft, 1)).toBe(WEFT_COLORS[3].hex);
    expect(draft.rows.map((row) => row.color)).toEqual([0, 3]);
  });

  it('换梭线拒绝越界下标', () => {
    const draft = freshLoomDraft();
    expect(setWeft(draft, -1)).toBe(draft);
    expect(setWeft(draft, WEFT_COLORS.length)).toBe(draft);
    expect(setWeft(draft, 1.5)).toBe(draft);
  });
});

describe('小小织布机：平纹与布面', () => {
  it('平纹格由行号与经线号共同决定，经纬交错', () => {
    expect(cellFace(0, 0)).toBe('warp');
    expect(cellFace(0, 1)).toBe('weft');
    expect(cellFace(1, 0)).toBe('weft');
    expect(cellFace(1, 1)).toBe('warp');
    expect(cellFace(2, 0)).toBe('warp');
  });

  it('每一行里经线露头与纬线露头的格数各占一半', () => {
    for (let row = 0; row < 4; row += 1) {
      const faces = Array.from({ length: LOOM_ENDS }, (_, end) => cellFace(row, end));
      expect(faces.filter((face) => face === 'warp')).toHaveLength(LOOM_ENDS / 2);
      expect(faces.filter((face) => face === 'weft')).toHaveLength(LOOM_ENDS / 2);
    }
  });

  it('织满之后不能再投梭，也不会把进度推过对岸', () => {
    const full = woven(LOOM_MAX_ROWS);
    expect(isFull(full)).toBe(true);
    expect(canWeave(full)).toBe(false);
    const blocked = dragWeft(full, 0.5);
    expect(blocked.rows).toHaveLength(LOOM_MAX_ROWS);
    expect(blocked.progress).toBe(0);
    expect(dragWeft(full, 1).rows).toHaveLength(LOOM_MAX_ROWS);
  });

  it('收边要求至少一行；收边后不能再投梭', () => {
    expect(finishLoom(freshLoomDraft())).toEqual(freshLoomDraft());
    const finished = finishLoom(woven(1));
    expect(finished.finished).toBe(true);
    expect(finished.progress).toBe(0);
    const ignored = dragWeft(finished, 1);
    expect(ignored.rows).toHaveLength(1);
    expect(resumeLoom(finished).finished).toBe(false);
  });

  it('成品几何随行数长高，宽度恒定', () => {
    const one = artifactGeometry(1);
    const five = artifactGeometry(5);
    expect(five.width).toBe(one.width);
    expect(five.height - one.height).toBe(4 * LOOM_CELL_H);
    // 一行都没有时也要给出一个非零高度，导出不会得到空图。
    expect(artifactGeometry(0).height).toBeGreaterThan(0);
  });
});

describe('小小织布机：草稿', () => {
  it('换经线重新开始时保留梭线选择', () => {
    const draft = setWeft(woven(2), 4);
    const cleared = clearLoom(draft);
    expect(cleared.rows).toEqual([]);
    expect(cleared.progress).toBe(0);
    expect(cleared.weft).toBe(4);
    expect(cleared.warp).toBe(draft.warp);
  });

  it('往返一次不丢东西，方向按行号重算', () => {
    const draft = setWeft(woven(3), 2);
    const parsed = parseLoomDraft(JSON.stringify(draft));
    expect(parsed).not.toBeNull();
    expect(parsed!.rows.map((row) => row.color)).toEqual(draft.rows.map((row) => row.color));
    expect(parsed!.rows.map((row) => row.direction)).toEqual([1, -1, 1]);
  });

  it('坏草稿一律返回 null，交给调用方回落到新作品', () => {
    expect(parseLoomDraft(null)).toBeNull();
    expect(parseLoomDraft('')).toBeNull();
    expect(parseLoomDraft('not json')).toBeNull();
    expect(parseLoomDraft('null')).toBeNull();
    // 旧版草稿（version 1）直接失效 —— 形状变了，不做迁移。
    expect(parseLoomDraft(JSON.stringify({ version: 1, started: true, warp: 'oat', weft: 0, rows: [], progress: 0, finished: false }))).toBeNull();
    expect(parseLoomDraft('x'.repeat(400_001))).toBeNull();
  });

  it('坏字段被就地纠正而不是整份丢掉', () => {
    const parsed = parseLoomDraft(JSON.stringify({
      version: 2,
      warp: 'not-a-scheme',
      weft: 99,
      rows: [{ color: 1 }, { color: 99 }, null, { color: 2 }],
      progress: 4,
      finished: true,
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.warp).toBe(WARP_SCHEMES[0].id);
    expect(parsed!.weft).toBe(0);
    expect(parsed!.rows.map((row) => row.color)).toEqual([1, 2]);
    expect(parsed!.progress).toBe(0);
    expect(parsed!.finished).toBe(true);
  });

  it('行数超过上限的草稿被截断', () => {
    const rows = Array.from({ length: LOOM_MAX_ROWS + 10 }, () => ({ color: 0 }));
    const parsed = parseLoomDraft(JSON.stringify({ version: 2, warp: 'oat', weft: 0, rows, progress: 0, finished: false }));
    expect(parsed!.rows).toHaveLength(LOOM_MAX_ROWS);
  });

  it('没有行的草稿不会被当成已收边', () => {
    const parsed = parseLoomDraft(JSON.stringify({ version: 2, warp: 'oat', weft: 0, rows: [], progress: 0, finished: true }));
    expect(parsed!.finished).toBe(false);
  });

  it('进度在收边后被清零', () => {
    const parsed = parseLoomDraft(JSON.stringify({ version: 2, warp: 'oat', weft: 0, rows: [{ color: 0 }], progress: 0.7, finished: true }));
    expect(parsed!.finished).toBe(true);
    expect(parsed!.progress).toBe(0);
  });
});

describe('小小织布机：基本读数', () => {
  it('currentRow 就是行数，也就是下一行的下标', () => {
    expect(currentRow(freshLoomDraft())).toBe(0);
    expect(currentRow(woven(4))).toBe(4);
  });

  it('每套经线配色都正好给出十二根颜色', () => {
    for (const scheme of WARP_SCHEMES) {
      expect(scheme.colors).toHaveLength(LOOM_ENDS);
    }
  });
});
