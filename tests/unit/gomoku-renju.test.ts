// ─────────────────────────────────────────────────────────────────────────────
// gomoku-renju.test.ts —— 五子棋**先手禁手**（三三 / 四四 / 长连）。
//
// 【口径 · 改动前必读】本站取的是**拒绝落子**，不是 Renju 的「走了判负」：
// `forbiddenKind(row, col, player)` 是**落子前**对空点的查询，返回非 null 就拒绝
// 这一手，棋盘一格不动。所以棋盘上永远不会出现黑棋的长连或四四。
//
// 【为什么这些用例要一条条手搭局面】禁手的三种形状各有各的边界，而单条用例只能
// 验证你想得到的情形。这里刻意把「看起来像禁手其实合法」的几种都钉住 —— 四三、
// 四三三、活四、两个眠三、贴边的三 —— 因为**误判成禁手**的代价是玩家有一手合法
// 的好棋走不出去，比漏判更难发现（不会报错，只会觉得「这一手怎么点不动」）。
//
// 【不测什么】不测「串味」与「成五点重复计数」那两处已修的口径 —— 它们在
// `gomoku-ai.test.ts` 里（`analyzeMove` 一层）。这里补一句为什么禁手不受它们
// 影响：三三**只在一个四都没有时才判**，而两处 bug 都要求局面里已经存在成五点
// （即已经有一个四），那种局面根本走不到三三分支。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { BLACK, GomokuBoard, WHITE, type Player } from '@/lib/gomoku-rules';

// ─── 摆局面的辅助 ────────────────────────────────────────────────────────────
// `.` 空、`X` 黑、`O` 白、`_` 待查询的空点。片段一律**居中**摆放（15 格时贴边）。
// 约定与 `gomoku-ai.test.ts` 一致，两边读起来是同一套。

const CENTER = 7;

/**
 * 由 ASCII 片段摆出局面，返回棋盘与 `_` 所在的坐标。
 * `_` 必须**有且只有一个** —— 多一个就会静默地测了另一个点。
 */
function layout(rows: string[]): { board: GomokuBoard; hole: [number, number] } {
  const b = new GomokuBoard();
  const top = rows.length === 15 ? 0 : CENTER - Math.floor(rows.length / 2);
  const holes: Array<[number, number]> = [];
  rows.forEach((row, i) => {
    const left = row.length === 15 ? 0 : CENTER - Math.floor(row.length / 2);
    [...row].forEach((ch, j) => {
      if (ch === '_') holes.push([top + i, left + j]);
      else if (ch === 'X') b.placeStone(top + i, left + j, BLACK);
      else if (ch === 'O') b.placeStone(top + i, left + j, WHITE);
    });
  });
  if (holes.length !== 1) throw new Error(`片段里要恰好一个 \`_\`，实际 ${holes.length} 个`);
  return { board: b, hole: holes[0] };
}

/** 查询「player 落在 `_` 处」是不是禁手。 */
function forbidden(rows: string[], player: Player = BLACK): string | null {
  const { board, hole } = layout(rows);
  return board.forbiddenKind(hole[0], hole[1], player);
}

/** 顺手量一下这个局面里棋盘长什么样 —— 用来钉「查询不改棋盘」。 */
function snapshot(b: GomokuBoard): string {
  return JSON.stringify(b.grid);
}

describe('禁手 —— 长连', () => {
  it('黑棋补成六连是禁手', () => {
    // 横向已有 4 连，右边隔一格还有一个子：补在中间那格就成六连
    const kind = forbidden([
      '.......',
      '.......',
      '.......',
      'XXXX_XX',
      '.......',
      '.......',
      '.......',
    ]);
    expect(kind).toBe('overline');
  });

  it('黑棋填洞成七连也是禁手', () => {
    const kind = forbidden([
      '.......',
      '.......',
      '.......',
      'XXX_XXX',
      '.......',
      '.......',
      '.......',
    ]);
    expect(kind).toBe('overline');
  });

  it('白棋长连不是禁手（Renju 只约束先手）', () => {
    const kind = forbidden(
      [
        '.......',
        '.......',
        '.......',
        'OOO_OOO',
        '.......',
        '.......',
        '.......',
      ],
      WHITE
    );
    expect(kind).toBeNull();
  });
});

describe('禁手 —— 四四', () => {
  it('两个方向各造一个四是禁手', () => {
    // 十字形：中心补一手，横竖各成四
    const kind = forbidden([
      '...X...',
      '...X...',
      '...X...',
      'XXX_...',
      '.......',
      '.......',
      '.......',
    ]);
    expect(kind).toBe('double-four');
  });

  it('同一方向上两个成五点是「活四」，合法且是必胜手', () => {
    // 与上一条只差竖线那三子 —— 别把「活四」误当成「四四」，
    // 那会让黑棋唯一的一类合法必胜手走不出去。
    const kind = forbidden([
      '.......',
      '.......',
      '.......',
      'XXX_...',
      '.......',
      '.......',
      '.......',
    ]);
    expect(kind).toBeNull();
  });
});

describe('禁手 —— 三三与它不该触发的几种情形', () => {
  it('两个方向各造一个活三是禁手', () => {
    const kind = forbidden([
      '.......',
      '.......',
      '...X...',
      '..X_X..',
      '...X...',
      '.......',
      '.......',
    ]);
    expect(kind).toBe('double-three');
  });

  it('四三是合法着法（有一个四就不判三三）', () => {
    const kind = forbidden([
      '...X...',
      '...X...',
      '...X...',
      '.XX_...',
      '.......',
      '.......',
      '.......',
    ]);
    expect(kind).toBeNull();
  });

  it('四三三（一个四 + 两个活三）也是合法着法', () => {
    const kind = forbidden([
      '...X...',
      '.X.X...',
      '..XX...',
      '.XX_...',
      '.......',
      '.......',
      '.......',
    ]);
    expect(kind).toBeNull();
  });

  it('两个眠三不是双活三', () => {
    // 横竖都各只有一个方向能长出冲四（另一端被白子堵死），不是活三
    const kind = forbidden([
      '...O...',
      '...X...',
      '...X...',
      'OXX_...',
      '.......',
      '.......',
      '.......',
    ]);
    expect(kind).toBeNull();
  });

  it('贴边的三不是活三（棋盘边界就是封堵）', () => {
    const kind = forbidden(['XX_............']);
    expect(kind).toBeNull();
  });
});

describe('禁手 —— 优先级与契约', () => {
  it('五连优先于禁手：同一点横成五、竖成长连时算胜不算禁手', () => {
    // 这条钉的是判定**顺序**：连长那一趟必须在「恰好五连」之后查，
    // 反过来的话这一手会被判成长连禁手 —— 而它本该是赢棋。
    const kind = forbidden([
      '....X...',
      '....X...',
      '....X...',
      'XXXX_...',
      '....X...',
      '....X...',
      '........',
    ]);
    expect(kind).toBeNull();
  });

  it('白棋在任何禁手形状上都不判禁手', () => {
    expect(
      forbidden(
        [
          '...X...',
          '...X...',
          '...X...',
          'XXX_...',
          '.......',
          '.......',
          '.......',
        ],
        WHITE
      )
    ).toBeNull();
  });

  it('查询不改动棋盘（逐格快照相同）', () => {
    const { board, hole } = layout([
      '...X...',
      '...X...',
      '...X...',
      'XXX_...',
      '.......',
      '.......',
      '.......',
    ]);
    const before = snapshot(board);
    board.forbiddenKind(hole[0], hole[1], BLACK);
    board.isForbidden(hole[0], hole[1], BLACK);
    expect(snapshot(board)).toBe(before);
  });

  it('非空格与越界一律不是禁手（那是「非法」，不是「禁手」）', () => {
    const { board, hole } = layout(['XXX_...']);
    // 已有子：不是禁手点，是非法着法 —— isForbidden 不该越权回答
    expect(board.forbiddenKind(hole[0], hole[1] - 1, BLACK)).toBeNull();
    expect(board.forbiddenKind(-1, 0, BLACK)).toBeNull();
    expect(board.forbiddenKind(15, 15, BLACK)).toBeNull();
  });
});
