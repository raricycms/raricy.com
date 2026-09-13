'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 五子棋**本地对局**（pvp / 人机）。
//
// 【规则与 AI 都不在这里】棋盘模型与胜负判定在 @/lib/gomoku-rules（联机对战时
// 服务端要用同一份代码判胜负，两边各写一份必然 drift）；AI 引擎在 @/lib/gomoku-ai。
// 本文件只剩 canvas 渲染与本地对局状态机。
//
// 【AI 跑在 Web Worker 里】困难档的思考是**秒级**的，而搜索是纯同步紧循环 ——
// 放主线程上就是整页冻死那么多秒。组件只负责把着法历史发给 worker、把结果收
// 回来，见 gomoku-ai.worker.ts。
//
// 【一次只认一个在途请求】`requestSeq` 每发一次请求自增，回来的结果对不上号
// 就丢掉；重开一局 / 切模式时直接 `terminate()` 掉 worker 并换新的。这样
// 「AI 还在想，玩家点了新游戏」不会在空棋盘上落下一颗迟到的子 —— 老实现用
// 裸 setTimeout 且从不 clearTimeout，回调触发时才去读 AI 实例，真的有这个 bug。
//
// 本组件覆盖的玩法：
//   • 双人对战（pvp）或人机对战（ai，人执黑、AI 执白）。
//   • 悔棋：pvp 撤销 1 步；ai 撤销 2 步（AI 的 + 人的）。重新开始。
//
// 棋盘用 <canvas> 绘制（与原实现一致），棋局状态存于 ref，命令式重绘。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { BLACK, GomokuBoard, WHITE, type Move, type Player } from '@/lib/gomoku-rules';
import { findBestMove } from '@/lib/gomoku-ai';
import GomokuCanvas from './GomokuCanvas';
import type { AiProtocolMove, AiRequest, AiResponse } from './gomoku-ai-protocol';

// ─── React 组件（对齐 main.js 控制器）────────────────────────────────────────
// 画布（调色板 / DPR / resize / 主题 / 点击换算）全在 GomokuCanvas 里，
// 与联机模式共用。本组件只剩本地对局的 AI 与状态机。
type Mode = 'pvp' | 'ai';
type StatusKind = 'turn' | 'thinking' | 'win-black' | 'win-white' | 'draw';

export default function GomokuLocal() {
  const boardRef = useRef<GomokuBoard>(new GomokuBoard());

  // ── AI worker ──
  const aiWorkerRef = useRef<Worker | null>(null);
  /** 每发一次请求自增；回来的结果对不上就说明局面已经变了，丢掉。 */
  const requestSeqRef = useRef<number>(0);
  /** 在途请求的落点回调。worker 是单线程串行的，所以只可能有一个。 */
  const pendingRef = useRef<{ id: number; apply: (row: number, col: number) => void } | null>(
    null
  );

  // 运行时棋局状态（命令式，存 ref 以避免绘制耦合 React 渲染）
  const currentPlayerRef = useRef<Player>(BLACK);
  const gameOverRef = useRef<boolean>(false);
  const winningLineRef = useRef<Array<[number, number]> | null>(null);
  const lastMoveRef = useRef<Move | null>(null);
  const isAiThinkingRef = useRef<boolean>(false);
  const modeRef = useRef<Mode>('pvp');

  // DOM 展示态
  const [mode, setMode] = useState<Mode>('pvp');
  const [statusText, setStatusText] = useState<string>('黑方落子');
  const [statusKind, setStatusKind] = useState<StatusKind>('turn');
  const [undoDisabled, setUndoDisabled] = useState<boolean>(true);

  // 棋盘是原地改的可变对象，引用不变 —— 靠这个计数器通知 GomokuCanvas 重绘。
  const [viewSeq, setViewSeq] = useState<number>(0);

  const updateStatus = useCallback(() => {
    if (isAiThinkingRef.current) {
      setStatusText('AI 思考中…');
      setStatusKind('thinking');
      return;
    }
    if (gameOverRef.current) {
      const line = winningLineRef.current;
      const last = lastMoveRef.current;
      if (line && line.length > 0 && last) {
        if (last.player === BLACK) {
          setStatusText('黑方获胜！');
          setStatusKind('win-black');
        } else {
          setStatusText('白方获胜！');
          setStatusKind('win-white');
        }
      } else {
        setStatusText('平局！');
        setStatusKind('draw');
      }
      return;
    }
    setStatusText(currentPlayerRef.current === BLACK ? '黑方落子' : '白方落子');
    setStatusKind('turn');
  }, []);

  const refreshUndoDisabled = useCallback(() => {
    setUndoDisabled(
      boardRef.current.getHistory().length === 0 || isAiThinkingRef.current
    );
  }, []);

  const applyView = useCallback(() => {
    // 自增而非比较：棋盘被原地改了，引用比不出变化（见 GomokuCanvas 文件头）
    setViewSeq((n) => n + 1);
    updateStatus();
    refreshUndoDisabled();
  }, [updateStatus, refreshUndoDisabled]);

  const placeAndCheck = useCallback(
    (row: number, col: number, player: Player) => {
      boardRef.current.placeStone(row, col, player);
      lastMoveRef.current = { row, col, player };

      const wr = boardRef.current.checkWinAt(row, col, player);
      if (wr.won) {
        gameOverRef.current = true;
        winningLineRef.current = wr.line;
      } else if (boardRef.current.isFull()) {
        gameOverRef.current = true;
        winningLineRef.current = null;
      }
      applyView();
    },
    [applyView]
  );

  const switchTurn = useCallback(() => {
    currentPlayerRef.current = currentPlayerRef.current === BLACK ? WHITE : BLACK;
  }, []);

  /** 惰性创建 AI worker。只在真的要人机对战时才建，pvp 模式不浪费线程。 */
  const ensureAiWorker = useCallback((): Worker | null => {
    if (aiWorkerRef.current) return aiWorkerRef.current;
    try {
      const w = new Worker(new URL('./gomoku-ai.worker.ts', import.meta.url));
      w.onmessage = (e: MessageEvent<AiResponse>) => {
        const p = pendingRef.current;
        // 对不上号 = 局面已经被重置过（重开一局 / 悔棋 / 切模式），丢弃
        if (!p || p.id !== e.data.id) return;
        pendingRef.current = null;
        p.apply(e.data.row, e.data.col);
      };
      aiWorkerRef.current = w;
      return w;
    } catch {
      // 建不起来（老浏览器 / 打包异常）就退回主线程，宁可卡一下也不能不能玩
      return null;
    }
  }, []);

  /**
   * 作废在途请求并销毁 worker。
   *
   * `terminate()` 是唯一能真正**打断** worker 的手段 —— 搜索是同步紧循环，
   * 收不到 message。重开一局时不做这一步的话，那个线程会白烧掉整个思考时间。
   */
  const resetAiWorker = useCallback(() => {
    requestSeqRef.current++;
    pendingRef.current = null;
    aiWorkerRef.current?.terminate();
    aiWorkerRef.current = null;
  }, []);

  const maybeAiMove = useCallback(() => {
    if (modeRef.current !== 'ai') return;
    if (gameOverRef.current) return;
    if (currentPlayerRef.current !== WHITE) return;

    isAiThinkingRef.current = true;
    updateStatus();
    refreshUndoDisabled();

    const board = boardRef.current;
    const moves: AiProtocolMove[] = board
      .getHistory()
      .map((m) => ({ row: m.row, col: m.col, player: m.player }));
    const id = ++requestSeqRef.current;

    const apply = (row: number, col: number): void => {
      placeAndCheck(row, col, WHITE);
      isAiThinkingRef.current = false;
      if (!gameOverRef.current) switchTurn();
      applyView();
    };

    const worker = ensureAiWorker();
    if (worker) {
      pendingRef.current = { id, apply };
      const req: AiRequest = { id, moves, player: WHITE, difficulty: 'normal' };
      worker.postMessage(req);
      return;
    }

    const best = findBestMove(board, WHITE, { difficulty: 'normal' });
    apply(best.row, best.col);
  }, [
    updateStatus,
    refreshUndoDisabled,
    ensureAiWorker,
    placeAndCheck,
    switchTurn,
    applyView,
  ]);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (gameOverRef.current) return;
      if (isAiThinkingRef.current) return;
      if (!boardRef.current.isValidMove(row, col)) return;

      // AI 模式下仅人类（黑）可点
      if (modeRef.current === 'ai' && currentPlayerRef.current !== BLACK) return;

      placeAndCheck(row, col, currentPlayerRef.current);

      if (!gameOverRef.current) {
        switchTurn();
        // 【为什么这里要补一次 applyView】placeAndCheck 内部已经刷新过一次状态，
        // 但那是在 switchTurn 之前 —— 读到的还是刚落子那方。AI 模式下 maybeAiMove
        // 会再补一次，pvp 模式下它立刻返回，状态栏就永远停在「刚落子那方」，
        // 回合提示慢一拍（玩家会以为还是对方走）。同一次事件里 setState 会合并，
        // AI 模式随后覆盖成「AI 思考中…」，不会闪。
        applyView();
        maybeAiMove();
      }
    },
    [placeAndCheck, switchTurn, maybeAiMove, applyView]
  );

  const initGame = useCallback(
    (nextMode: Mode) => {
      // 先把在途的 AI 结果作废并掐掉 worker，再动棋盘。
      // 顺序反过来的话，迟到的结果会在**新**棋盘上落子。
      resetAiWorker();

      boardRef.current.reset();
      currentPlayerRef.current = BLACK;
      gameOverRef.current = false;
      winningLineRef.current = null;
      lastMoveRef.current = null;
      isAiThinkingRef.current = false;
      modeRef.current = nextMode;

      applyView();
    },
    [resetAiWorker, applyView]
  );

  const undoMove = useCallback(() => {
    if (isAiThinkingRef.current) return;
    if (boardRef.current.getHistory().length === 0) return;

    if (modeRef.current === 'ai') {
      // 撤销两步：AI 的 + 人的；人类恒执黑
      boardRef.current.undo();
      boardRef.current.undo();
      currentPlayerRef.current = BLACK;
    } else {
      boardRef.current.undo();
      switchTurn();
    }

    gameOverRef.current = false;
    winningLineRef.current = null;
    lastMoveRef.current = boardRef.current.getLastMove();
    applyView();
  }, [switchTurn, applyView]);

  // 初始化（对齐 main.js）。画布的 resize / 主题 / 点击换算已移交 GomokuCanvas，
  // 这里只剩本地对局自己的初始化。
  useEffect(() => {
    initGame('pvp');
    // 卸载时把 worker 线程收掉，别让它留在后台
    return () => {
      requestSeqRef.current++;
      pendingRef.current = null;
      aiWorkerRef.current?.terminate();
      aiWorkerRef.current = null;
    };
    // 仅挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onModeChange = useCallback(
    (value: Mode) => {
      setMode(value);
      initGame(value);
    },
    [initGame]
  );

  // 胜负文字用主题令牌着色。此前写死 var(--ink, #333) / var(--muted, #888) ——
  // 这两个变量主题体系里并不存在，暗色下「黑方获胜」是深色底上的近黑色。
  const statusColor: string | undefined =
    statusKind === 'win-black'
      ? 'var(--color-text-primary)'
      : statusKind === 'win-white'
        ? 'var(--color-text-secondary)'
        : undefined;

  return (
    <div className="board-card">
      {/* 模式选择 */}
      <div className="gomoku-mode-selector" role="radiogroup" aria-label="对战模式">
        <label className="gomoku-mode-option">
          <input
            type="radio"
            name="gomoku-mode"
            value="pvp"
            checked={mode === 'pvp'}
            onChange={() => onModeChange('pvp')}
          />
          <span>双人对战</span>
        </label>
        <label className="gomoku-mode-option">
          <input
            type="radio"
            name="gomoku-mode"
            value="ai"
            checked={mode === 'ai'}
            onChange={() => onModeChange('ai')}
          />
          <span>人机对战</span>
        </label>
      </div>

      {/* 状态 */}
      <div className="board-status" style={statusColor ? { color: statusColor } : undefined}>
        {statusText}
      </div>

      {/* 棋盘 */}
      <GomokuCanvas
        grid={boardRef.current.grid}
        lastMove={lastMoveRef.current}
        winningLine={winningLineRef.current}
        version={viewSeq}
        onCellClick={handleCellClick}
      />

      {/* 控制 */}
      <div className="board-controls">
        <button type="button" className="board-btn" onClick={() => initGame(modeRef.current)}>
          新游戏
        </button>
        <button
          type="button"
          className="board-btn"
          onClick={undoMove}
          disabled={undoDisabled}
        >
          悔棋
        </button>
      </div>
    </div>
  );
}
