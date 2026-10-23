import { describe, expect, it } from 'vitest';
import {
  artifactGeometry, beatRow, canBeat, cellFace, clearLoom, finishLoom, freshLoomDraft, LOOM_MAX_ROWS,
  parseLoomDraft, passComplete, passDirection, resumeLoom, setPassProgress, setWeft, shedGroup, startLoom,
  undoLoom, WARP_SCHEMES, warpColor, WEFT_COLORS, type LoomDraft,
} from '../../src/games/craft/loom/engine';

function woven(rows: number, warp = WARP_SCHEMES[0].id): LoomDraft {
  let draft = startLoom(freshLoomDraft(), warp);
  for (let row = 0; row < rows; row += 1) {
    draft = setPassProgress(draft, 1);
    draft = beatRow(draft);
  }
  return draft;
}

describe('小小织布机：平纹、抬经与压紧', () => {
  it('开始织布会绷好经线，清掉上一条布', () => {
    const dirty = { ...freshLoomDraft(), started: true, rows: [{ color: 2 }], progress: 0.4 };
    const started = startLoom(dirty, 'indigo');
    expect(started.started).toBe(true);
    expect(started.warp).toBe('indigo');
    expect(started.rows).toEqual([]);
    expect(started.progress).toBe(0);
    expect(startLoom(dirty, 'not-a-scheme').warp).toBe(WARP_SCHEMES[0].id);
  });

  it('平纹格由行号与经线号共同决定，经纬交错', () => {
    expect(cellFace(0, 0)).toBe('warp');
    expect(cellFace(0, 1)).toBe('weft');
    expect(cellFace(1, 0)).toBe('weft');
    expect(cellFace(1, 1)).toBe('warp');
    expect(cellFace(2, 0)).toBe('warp');
  });

  it('每压一行换一组经线，梭子方向也跟着回头', () => {
    let draft = freshLoomDraft();
    expect(shedGroup(draft)).toBe(0);
    expect(passDirection(draft)).toBe(1);
    draft = startLoom(draft, 'oat');
    draft = beatRow(setPassProgress(draft, 1));
    expect(shedGroup(draft)).toBe(1);
    expect(passDirection(draft)).toBe(-1);
    draft = beatRow(setPassProgress(draft, 1));
    expect(shedGroup(draft)).toBe(0);
    expect(passDirection(draft)).toBe(1);
  });

  it('梭子进度夹在 0 到 1 之间；没上机时不动', () => {
    const fresh = freshLoomDraft();
    expect(setPassProgress(fresh, 0.5)).toBe(fresh);
    let draft = startLoom(fresh, 'oat');
    expect(setPassProgress(draft, -3).progress).toBe(0);
    draft = setPassProgress(draft, 4);
    expect(draft.progress).toBe(1);
    expect(passComplete(draft)).toBe(true);
    expect(canBeat(draft)).toBe(true);
    expect(setPassProgress(draft, Number.NaN).progress).toBe(0);
    expect(passComplete(setPassProgress(draft, 0.994))).toBe(false);
  });

  it('只有梭子穿完才能压紧；压紧后多一行、梭子回到起点', () => {
    let draft = startLoom(freshLoomDraft(), 'moss');
    expect(beatRow(draft)).toBe(draft);
    draft = setPassProgress(draft, 1);
    const next = beatRow(draft);
    expect(next.rows).toEqual([{ color: 0 }]);
    expect(next.progress).toBe(0);
    expect(next).not.toBe(draft);
  });

  it('纬线颜色只影响之后压的行', () => {
    let draft = startLoom(freshLoomDraft(), 'oat');
    draft = beatRow(setPassProgress(draft, 1));
    draft = setWeft(draft, 3);
    draft = beatRow(setPassProgress(draft, 1));
    expect(draft.rows.map((row) => row.color)).toEqual([0, 3]);
    expect(setWeft(draft, -1)).toBe(draft);
    expect(setWeft(draft, WEFT_COLORS.length)).toBe(draft);
    expect(setWeft(draft, 1.5)).toBe(draft);
  });

  it('织满之后不能再压，收边后仍能退回继续织', () => {
    const full = woven(LOOM_MAX_ROWS);
    expect(full.rows).toHaveLength(LOOM_MAX_ROWS);
    expect(canBeat(setPassProgress(full, 1))).toBe(false);
    expect(beatRow(setPassProgress(full, 1))).toEqual(setPassProgress(full, 0));
    expect(finishLoom(full).finished).toBe(true);
    const resumed = resumeLoom(finishLoom(full));
    expect(resumed.finished).toBe(false);
    expect(resumed.rows).toHaveLength(LOOM_MAX_ROWS);
  });

  it('没有布时不能收边', () => {
    const draft = startLoom(freshLoomDraft(), 'oat');
    expect(finishLoom(draft)).toBe(draft);
  });

  it('撤销先退半途的梭子，再退一整行', () => {
    let draft = woven(2);
    draft = setPassProgress(draft, 0.6);
    const halfway = undoLoom(draft);
    expect(halfway.rows).toHaveLength(2);
    expect(halfway.progress).toBe(0);
    const row = undoLoom(halfway);
    expect(row.rows).toHaveLength(1);
    expect(undoLoom(freshLoomDraft())).toEqual(freshLoomDraft());
  });

  it('撤销收边会回到可继续织的状态', () => {
    const finished = finishLoom(woven(1));
    const undone = undoLoom(finished);
    expect(undone.finished).toBe(false);
    expect(undone.rows).toEqual([]);
  });

  it('经线配色按经线号循环取色', () => {
    const draft = startLoom(freshLoomDraft(), 'berry');
    const colors = WARP_SCHEMES.find((scheme) => scheme.id === 'berry')!.colors;
    expect(warpColor(draft, 0)).toBe(colors[0]);
    expect(warpColor(draft, colors.length)).toBe(colors[0]);
    expect(warpColor(draft, -1)).toBe(colors[colors.length - 1]);
  });

  it('成品几何随行数增高，左右留白固定', () => {
    const one = artifactGeometry(1);
    const many = artifactGeometry(10);
    expect(many.width).toBe(one.width);
    expect(many.height).toBeGreaterThan(one.height);
    expect(many.x).toBe(one.x);
    expect(many.y).toBe(one.y);
  });
});

describe('小小织布机：草稿解析', () => {
  it('坏 JSON 与旧版本一律丢弃', () => {
    expect(parseLoomDraft(null)).toBeNull();
    expect(parseLoomDraft('{')).toBeNull();
    expect(parseLoomDraft(JSON.stringify({ version: 2 }))).toBeNull();
    expect(parseLoomDraft('x'.repeat(400_001))).toBeNull();
  });

  it('合法草稿原样恢复，非法行与颜色被过滤', () => {
    const raw = JSON.stringify({
      version: 1, started: true, warp: 'indigo', weft: 2,
      rows: [{ color: 1 }, { color: 99 }, null, { color: 3 }], progress: 0.62, finished: false,
    });
    const parsed = parseLoomDraft(raw)!;
    expect(parsed.started).toBe(true);
    expect(parsed.warp).toBe('indigo');
    expect(parsed.weft).toBe(2);
    expect(parsed.rows).toEqual([{ color: 1 }, { color: 3 }]);
    expect(parsed.progress).toBeCloseTo(0.62);
    expect(parsed.finished).toBe(false);
  });

  it('未知经线回落到第一组，进度越界被夹紧', () => {
    const parsed = parseLoomDraft(JSON.stringify({
      version: 1, started: true, warp: 'unknown', weft: -2, rows: [], progress: 9, finished: false,
    }))!;
    expect(parsed.warp).toBe(WARP_SCHEMES[0].id);
    expect(parsed.weft).toBe(0);
    expect(parsed.progress).toBe(1);
  });

  it('收边状态必须真的有布；未上机时进度归零', () => {
    const emptyFinished = parseLoomDraft(JSON.stringify({
      version: 1, started: true, warp: 'oat', weft: 0, rows: [], progress: 0.5, finished: true,
    }))!;
    expect(emptyFinished.finished).toBe(false);
    expect(emptyFinished.progress).toBe(0.5);
    const notStarted = parseLoomDraft(JSON.stringify({
      version: 1, started: false, warp: 'oat', weft: 0, rows: [{ color: 0 }], progress: 0.5, finished: false,
    }))!;
    expect(notStarted.progress).toBe(0);
    const finished = parseLoomDraft(JSON.stringify({
      version: 1, started: true, warp: 'oat', weft: 0, rows: [{ color: 0 }], progress: 0.8, finished: true,
    }))!;
    expect(finished.finished).toBe(true);
    expect(finished.progress).toBe(0);
  });

  it('行数超过上限时截断', () => {
    const rows = Array.from({ length: LOOM_MAX_ROWS + 6 }, () => ({ color: 0 }));
    const parsed = parseLoomDraft(JSON.stringify({
      version: 1, started: true, warp: 'oat', weft: 0, rows, progress: 0, finished: false,
    }))!;
    expect(parsed.rows).toHaveLength(LOOM_MAX_ROWS);
  });

  it('清空回到全新草稿', () => {
    expect(clearLoom()).toEqual(freshLoomDraft());
  });
});
