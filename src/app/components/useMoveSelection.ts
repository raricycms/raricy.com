'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useMoveSelection.ts — 走子类棋的**选子 / 落点**状态机（三款棋共用）
//
// 【为什么共用】「点一下自己的子 → 高亮它现在能去哪 → 再点一下落点」这套交互对
// 国际象棋、中国象棋、国际跳棋一字不差。各写一份的话，三处的"点空处取消选择"
// 「点自己的另一个子改选」「走完一手自动清空」必然慢慢分叉 —— 而这正是
// 「同一个站里三款棋手感不一样」的来源。
//
// 【它刻意不认识棋】合法着法由调用方从**共享的规则模块**算好传进来
// （`generateMoves`）—— 客户端算这些只为给玩家做提示，服务端仍会重新判一遍
// （见 lib/board-room.ts 的服务端权威）。所以这里没有一行规则。
//
// 【为什么按路径而不是"起点+终点"】国际跳棋的连吃是一条含多个落点的路径，
// 而**起点终点相同的两条不同吃法**是可能存在的（绕着圈吃，吃的子不同）。
// 若只按起点+终点匹配，玩家就没法表达自己要哪一条 —— 服务端收到的会是另一手棋。
// 所以本 hook 按"已点路径是某条合法着法的前缀"来推进：
//   • 点下去正好凑成一条完整着法 → 走子
//   • 还只是某条着法的前缀     → 记下这一跳，继续等下一个落点
// 对两格着法（象棋 / 国际象棋）来说就是普通的一次点击，对跳棋则天然是逐跳连吃。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MoveInput, Square } from '@/lib/board-shared';

function sameSquare(a: Square, b: Square): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** `path` 是不是 `full` 的前缀（逐格、按顺序）。 */
function isPrefix(path: Square[], full: Square[]): boolean {
  if (path.length > full.length) return false;
  for (let i = 0; i < path.length; i++) if (!sameSquare(path[i], full[i])) return false;
  return true;
}

export interface MoveSelection {
  /** 已经点过的格子（含起点）。空数组 = 还没选子。 */
  path: Square[];
  /** 现在可以点的下一格 —— 棋盘点出来的"可以走这儿"提示。 */
  targets: Square[];
  /** 点一个格子。已选中的子照常显示，点别处会改选或取消。 */
  click: (square: Square) => void;
  clear: () => void;
}

/**
 * @param legalMoves 当前走子方的**全部**合法着法（由各棋的规则模块算出）
 * @param canPlay    现在能不能走（轮到你 + 连接正常 + 对局进行中）
 * @param onPlay     走这一手（在线是 POST，单机是本地落子）
 * @param resetKey   局面变了就清空选择。**必须传**，否则对手走完一手之后，
 *                   你上一步选中的子还高亮着，看着像还能走。
 */
export function useMoveSelection(
  legalMoves: MoveInput[],
  canPlay: boolean,
  onPlay: (move: MoveInput) => void,
  resetKey: number
): MoveSelection {
  const [path, setPath] = useState<Square[]>([]);

  // 局面一变就清空（含对手走子、终局、再来一局）
  useEffect(() => {
    setPath([]);
  }, [resetKey]);

  const targets = useMemo(() => {
    const next: Square[] = [];
    for (const move of legalMoves) {
      if (move.path.length <= path.length) continue; // 这一手已经走完了
      if (!isPrefix(path, move.path)) continue;
      const square = move.path[path.length];
      if (!next.some((s) => sameSquare(s, square))) next.push(square);
    }
    return next;
  }, [legalMoves, path]);

  const click = useCallback(
    (square: Square) => {
      if (!canPlay) return;

      const attempt = [...path, square];

      // 1) 正好凑成一条完整着法 → 走子
      const exact = legalMoves.find(
        (m) => m.path.length === attempt.length && isPrefix(attempt, m.path)
      );
      if (exact) {
        onPlay(exact);
        setPath([]);
        return;
      }

      // 2) 还只是某条着法的前缀 → 记下这一跳，继续等下一个落点（跳棋连吃走这里）
      if (legalMoves.some((m) => m.path.length > attempt.length && isPrefix(attempt, m.path))) {
        setPath(attempt);
        return;
      }

      // 3) 点不动。若这一格有自己的子，就是改选；否则当作取消。
      const isOwnPiece = legalMoves.some((m) => sameSquare(m.path[0], square));
      setPath(isOwnPiece ? [square] : []);
    },
    [canPlay, legalMoves, path, onPlay]
  );

  const clear = useCallback(() => setPath([]), []);

  return { path, targets, click, clear };
}
