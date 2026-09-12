'use client';

// ─────────────────────────────────────────────────────────────────────────────
// LocalBoardGame.tsx — 走子类棋的**单机对局壳**（同机双人，三款棋共用）
//
// 【为什么只写一份】三款棋的单机玩法一字不差：两个人挤在同一块屏幕前轮流走子、
// 随时能悔棋、能开新局。差别只有「画哪张棋盘」「某一方叫什么」——那正是
// LocalGameSpec 里的四个字段。各写一份的话，「点空处取消选择」「终局后点不动」
// 「悔棋要恢复上一手的判定」这些细节必然在某一款里漏掉。
//
// 【规则不在这里】合法落点由各棋的规则模块算（`board.generateMoves`），走子与判
// 终局由 `board.submit` 做 —— 与联机那边**跑的是同一份代码**（联机只是把 submit
// 换成 POST）。所以单机能走的着法，联机一定也能走。
//
// 【终局判定为什么要压栈】悔棋之后要把状态栏与"被将军"高亮恢复到上一手走完的样子。
// 重新算一遍是做不到的（棋盘判终局要生成整棵着法树，而且"上一手是否将军"是历史信息），
// 所以每走一手把 submit 返回的 Outcome 压进栈，悔棋时弹出即可。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useMemo, useRef, useState } from 'react';
import type { MoveInput, Outcome, Square } from '@/lib/board-shared';
import type { LocalGameBoard, LocalGameSpec } from './board-view';
import { useMoveSelection } from './useMoveSelection';

/** 对局进行中、无人被将。栈底与"新对局"都用它。 */
const PLAYING: Outcome = { status: 'playing', check: null };

export default function LocalBoardGame({
  createBoard,
  Board,
  sideName,
  reasonNote,
  isPromotion,
  promotionChoices,
}: LocalGameSpec) {
  // 棋盘是原地改的可变对象，引用不变 —— 靠 seq 这个计数器驱动重渲染
  const boardRef = useRef<LocalGameBoard>(createBoard());
  const board = boardRef.current;

  const [seq, setSeq] = useState(0);
  const outcomesRef = useRef<Outcome[]>([PLAYING]);
  const [outcome, setOutcome] = useState<Outcome>(PLAYING);
  /** 待选兵种的升变路径（只有国际象棋会用到）。 */
  const [pending, setPending] = useState<Square[] | null>(null);

  const finished = outcome.status !== 'playing';
  // 挂起升变时也把棋盘锁上，免得玩家一边选兵种一边又点了别处
  const locked = finished || pending !== null;

  const legalMoves = useMemo(
    () => (finished ? [] : board.generateMoves(board.turn)),
    // seq 变了就是棋盘变了；board 本身引用恒定，列出来只为让 lint 满意
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, seq, finished]
  );

  const applyMove = useCallback(
    (move: MoveInput) => {
      const next = board.submit(board.turn, move);
      // 理论上到不了：着法来自 board.generateMoves
      if (!next) return;
      outcomesRef.current.push(next);
      setOutcome(next);
      setSeq((n) => n + 1);
    },
    [board]
  );

  const onPlay = useCallback(
    (move: MoveInput) => {
      const from = move.path[0];
      const to = move.path[move.path.length - 1];
      // 升变要先问兵种：不报就落子等于替玩家选了后，而升变成马有时是唯一的赢法
      if (isPromotion?.(board.grid[from[0]][from[1]], to)) {
        setPending(move.path);
        return;
      }
      applyMove(move);
    },
    [applyMove, board, isPromotion]
  );

  const selection = useMoveSelection(legalMoves, !locked, onPlay, seq);

  const choosePromotion = useCallback(
    (piece: string) => {
      if (!pending) return;
      setPending(null);
      applyMove({ path: pending, promotion: piece });
    },
    [applyMove, pending]
  );

  const newGame = useCallback(() => {
    board.reset();
    outcomesRef.current = [PLAYING];
    setOutcome(PLAYING);
    setPending(null);
    setSeq((n) => n + 1);
  }, [board]);

  const undo = useCallback(() => {
    // 栈底那一条是"开局"，弹掉它就没有可恢复的判定了
    if (outcomesRef.current.length <= 1) return;
    if (!board.undo()) return;
    outcomesRef.current.pop();
    setOutcome(outcomesRef.current[outcomesRef.current.length - 1]);
    setPending(null);
    setSeq((n) => n + 1);
  }, [board]);

  const statusText = (() => {
    if (pending) return '选择升变';
    if (outcome.status === 'won') return `${sideName(outcome.winner)}获胜！${reasonNote(outcome.reason)}`;
    if (outcome.status === 'draw') return `和棋${reasonNote(outcome.reason)}`;
    const check = outcome.check ? '（被将军）' : '';
    return `${sideName(board.turn)}走棋${check}`;
  })();

  return (
    <div className="board-card">
      <div className="board-status">{statusText}</div>

      <Board
        grid={board.grid}
        lastMove={board.getLastMove()}
        highlight={outcome.status === 'won' ? outcome.highlight : []}
        check={outcome.status === 'playing' ? outcome.check : null}
        selection={selection}
        onSquareClick={(r, c) => selection.click([r, c])}
        disabled={locked}
      />

      {pending && promotionChoices && (
        <div className="board-promotion" role="group" aria-label="选择升变的棋子">
          <span className="board-promotion__label">升变为</span>
          {promotionChoices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className="board-btn board-btn--small"
              onClick={() => choosePromotion(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}

      <div className="board-controls">
        <button type="button" className="board-btn" onClick={newGame}>
          新对局
        </button>
        <button
          type="button"
          className="board-btn"
          onClick={undo}
          disabled={outcomesRef.current.length <= 1 || pending !== null}
        >
          悔棋
        </button>
      </div>
    </div>
  );
}
