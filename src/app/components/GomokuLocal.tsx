'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 五子棋**本地对局**（pvp / 人机）。
//
// 【规则与 AI 都不在这里】棋盘模型与胜负判定在 @/lib/gomoku-rules（联机对战时
// 服务端要用同一份代码判胜负，两边各写一份必然 drift）；AI 引擎在 @/lib/gomoku-ai。
// 本文件只剩 canvas 渲染与本地对局状态机。
//
// 【AI 跑在 Web Worker 里】普通档的思考是**秒级**的，而搜索是纯同步紧循环 ——
// 放主线程上就是整页冻死那么多秒。组件只负责把着法历史发给 worker、把结果收
// 回来，见 gomoku-ai.worker.ts。
//
// 【一次只认一个在途请求】`requestSeq` 每发一次请求自增，回来的结果对不上号
// 就丢掉；重开一局 / 切模式时直接 `terminate()` 掉 worker 并换新的。这样
// 「AI 还在想，玩家点了新游戏」不会在空棋盘上落下一颗迟到的子 —— 老实现用
// 裸 setTimeout 且从不 clearTimeout，回调触发时才去读 AI 实例，真的有这个 bug。
//
// 【回合是着法历史的函数，不是"走一手翻一次面"】`currentPlayerRef` 只是
// `sideToMove(history)` 的一份同步副本 —— 每次动过棋盘（落子 / 悔棋 / 重开）都由
// `syncTurn()` 重算一次。翻面在**终局那一手**上会算错：那一手走完没人接，回合停在
// 落子方，而翻面会把它翻给对手，悔棋时再翻一次就成了「同一方连下两步」。详见
// gomoku-rules 的 sideToMove 与 tests/unit/gomoku-local-undo.test.ts。
// （联机那边同一条口径：board-room 的 respondUndo 把 room.turn 直接写成请求方的
// 席位，也不连翻两次。）
//
// 本组件覆盖的玩法：
//   • 双人对战（pvp）或人机对战（ai，人执黑、AI 执白）。
//   • 悔棋：pvp 撤 1 步；ai 撤到「又轮到人类走」为止（人类走完 AI 立刻应招，通常
//     是 2 步；人类那一手若直接终结了比赛就没有应招，撤 1 步）。重新开始。
//
// 棋盘用 <canvas> 绘制（与原实现一致），棋局状态存于 ref，命令式重绘。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { BLACK, GomokuBoard, sideToMove, WHITE, type Move, type Player } from '@/lib/gomoku-rules';
import { findBestMove, type Difficulty } from '@/lib/gomoku-ai';
import GomokuCanvas from './GomokuCanvas';
import type { AiProtocolMove, AiRequest, AiResponse } from './gomoku-ai-protocol';

// ─── React 组件（对齐 main.js 控制器）────────────────────────────────────────
// 画布（调色板 / DPR / resize / 主题 / 点击换算）全在 GomokuCanvas 里，
// 与联机模式共用。本组件只剩本地对局的 AI 与状态机。
type Mode = 'pvp' | 'ai';
type HumanSide = 'black' | 'white';
type StatusKind = 'turn' | 'thinking' | 'win-black' | 'win-white' | 'draw';

/** 棋盘上「谁执黑/执白」到 Player 的换算。人类选的是颜色，引擎要的是 Player。 */
function playerOf(side: HumanSide): Player {
  return side === 'black' ? BLACK : WHITE;
}

/** 「思考中」后面跳动的点。worker 让主线程空着，所以指示器可以是活的。 */
const THINKING_DOTS = ['·', '··', '···'];

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
  /** 谁执黑/谁执白。人机模式下人类可以选，所以不能写死「人恒执黑」。 */
  const humanPlayerRef = useRef<Player>(BLACK);
  const aiPlayerRef = useRef<Player>(WHITE);

  // DOM 展示态
  const [mode, setMode] = useState<Mode>('pvp');
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [humanSide, setHumanSide] = useState<HumanSide>('black');
  const [statusText, setStatusText] = useState<string>('黑方落子');
  const [statusKind, setStatusKind] = useState<StatusKind>('turn');
  const [undoDisabled, setUndoDisabled] = useState<boolean>(true);
  const [thinkingDots, setThinkingDots] = useState<number>(0);

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

  /**
   * AI 先手时，它开局那一手不算「可悔的」—— 悔棋不该把棋盘撤成「轮到 AI 走
   * 却没人走」的状态。人类执黑时这个值是 0，退化成原来的「撤到空盘」。
   */
  const openingMoves = useCallback((): number => {
    return modeRef.current === 'ai' && aiPlayerRef.current === BLACK ? 1 : 0;
  }, []);

  const refreshUndoDisabled = useCallback(() => {
    setUndoDisabled(
      boardRef.current.getHistory().length <= openingMoves() || isAiThinkingRef.current
    );
  }, [openingMoves]);

  /** 回合唯一的重算处：按剩下的着法历史定「接下来轮到谁」（见文件头）。 */
  const syncTurn = useCallback(() => {
    currentPlayerRef.current = sideToMove(boardRef.current.getHistory());
  }, []);

  const applyView = useCallback(() => {
    // 先同步回合再刷状态 —— 状态行读的就是它
    syncTurn();
    // 自增而非比较：棋盘被原地改了，引用比不出变化（见 GomokuCanvas 文件头）
    setViewSeq((n) => n + 1);
    updateStatus();
    refreshUndoDisabled();
  }, [syncTurn, updateStatus, refreshUndoDisabled]);

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
    if (currentPlayerRef.current !== aiPlayerRef.current) return;

    isAiThinkingRef.current = true;
    updateStatus();
    refreshUndoDisabled();

    const board = boardRef.current;
    const aiPlayer = aiPlayerRef.current;
    const moves: AiProtocolMove[] = board
      .getHistory()
      .map((m) => ({ row: m.row, col: m.col, player: m.player }));
    const id = ++requestSeqRef.current;

    const apply = (row: number, col: number): void => {
      placeAndCheck(row, col, aiPlayer);
      isAiThinkingRef.current = false;
      // 再刷一次：placeAndCheck 里那次读到的还是「AI 思考中…」（回合已由那边同步好）
      applyView();
    };

    const worker = ensureAiWorker();
    if (worker) {
      pendingRef.current = { id, apply };
      const req: AiRequest = { id, moves, player: aiPlayer, difficulty };
      worker.postMessage(req);
      return;
    }

    const best = findBestMove(board, aiPlayer, { difficulty });
    apply(best.row, best.col);
  }, [
    difficulty,
    updateStatus,
    refreshUndoDisabled,
    ensureAiWorker,
    placeAndCheck,
    applyView,
  ]);

  const handleCellClick = useCallback(
    (row: number, col: number) => {
      if (gameOverRef.current) return;
      if (isAiThinkingRef.current) return;
      if (!boardRef.current.isValidMove(row, col)) return;
      // 禁手点（黑棋三三 / 四四 / 长连）走不上去。口径是**拒绝落子**，不是判负 ——
      // 所以这里静默挡掉，状态栏不动。**别顺手改成「落子后判负」**：那要同时改
      // 判定链路、状态行文案与联机协议，而且和规则模块的口径就分家了。
      if (boardRef.current.isForbidden(row, col, currentPlayerRef.current)) return;

      // AI 模式下只有人类那一方可以点（人类可能执黑也可能执白）
      if (modeRef.current === 'ai' && currentPlayerRef.current !== humanPlayerRef.current) return;

      placeAndCheck(row, col, currentPlayerRef.current);

      // 【回合不用在这里翻】placeAndCheck → applyView 已按着法历史同步过（见 syncTurn），
      // 状态行读到的就是刚落子之后的回合 —— 曾经这里补一次 switchTurn + applyView 正是
      // 为了让回合提示不慢一拍，那件事现在在 applyView 里做，这里只剩「该 AI 了就喊它」。
      if (!gameOverRef.current) maybeAiMove();
    },
    [placeAndCheck, maybeAiMove]
  );

  const initGame = useCallback(
    (nextMode: Mode, nextDifficulty: Difficulty, nextHumanSide: HumanSide) => {
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

      const human = playerOf(nextHumanSide);
      humanPlayerRef.current = human;
      aiPlayerRef.current = human === BLACK ? WHITE : BLACK;

      applyView();

      // AI 执黑时由它开局（空盘引擎直接给天元）
      if (nextMode === 'ai' && aiPlayerRef.current === BLACK) maybeAiMove();
    },
    [resetAiWorker, applyView, maybeAiMove]
  );

  /**
   * 撤一手，并把回合同步回「被撤那一手的落子方」。没有可撤的返回 false。
   *
   * 【为什么不能用 switchTurn 翻回来】翻面只在「走完一手」时成立，而**终局那一手
   * 不翻**（没人接着走）—— 刚有人获胜时当前回合还停在获胜方，此时悔棋再翻一次就把
   * 他翻给了对手，对手连下两步。按剩下的历史重算没有这个前提（见 syncTurn）。
   */
  const undoOnce = useCallback((): boolean => {
    if (!boardRef.current.undo()) return false;
    syncTurn();
    return true;
  }, [syncTurn]);

  const undoMove = useCallback(() => {
    if (isAiThinkingRef.current) return;
    if (boardRef.current.getHistory().length === 0) return;

    if (modeRef.current === 'ai') {
      // 撤到「又轮到人类走」为止 —— 也就是把人类那一手连同它之后 AI 的应招一起撤掉。
      // 先撤一手再判断，是因为进来时**正是**人类的回合，条件直接判会一次都不撤。
      // 判据是"轮到谁"而不是"撤几步"：人类那一手若直接终结了比赛，它后面**没有**
      // AI 的应招，撤一步就够了（按固定步数撤会连 AI 上一步一起撤掉，人类白得一手）。
      // 人类执白时 AI 的开局手不在可撤范围内（openingMoves），撤到底会停在它上面。
      const opening = openingMoves();
      do {
        if (!undoOnce()) break;
      } while (
        boardRef.current.getHistory().length > opening &&
        currentPlayerRef.current !== humanPlayerRef.current
      );
    } else {
      undoOnce();
    }

    gameOverRef.current = false;
    winningLineRef.current = null;
    lastMoveRef.current = boardRef.current.getLastMove();
    applyView();
  }, [openingMoves, undoOnce, applyView]);

  // 初始化（对齐 main.js）。画布的 resize / 主题 / 点击换算已移交 GomokuCanvas，
  // 这里只剩本地对局自己的初始化。
  useEffect(() => {
    initGame('pvp', 'easy', 'black');
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

  // 「思考中」后面跳动的点。搜索跑在 worker 上、主线程是空的，所以这个间隔
  // 真的会按时触发 —— 老实现里主线程被同步搜索占死，加了也只会定格。
  useEffect(() => {
    if (statusKind !== 'thinking') return;
    const t = window.setInterval(() => setThinkingDots((n) => (n + 1) % 3), 400);
    return () => window.clearInterval(t);
  }, [statusKind]);

  // 改任意一项都重开一局（与原来「切模式即重开」的行为一致）
  const onModeChange = useCallback(
    (value: Mode) => {
      setMode(value);
      initGame(value, difficulty, humanSide);
    },
    [initGame, difficulty, humanSide]
  );

  const onDifficultyChange = useCallback(
    (value: Difficulty) => {
      setDifficulty(value);
      initGame('ai', value, humanSide);
    },
    [initGame, humanSide]
  );

  const onHumanSideChange = useCallback(
    (value: HumanSide) => {
      setHumanSide(value);
      initGame('ai', difficulty, value);
    },
    [initGame, difficulty]
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

      {/* 人机模式才有难度与先手 —— 双人对战下调它们没有意义 */}
      {mode === 'ai' && (
        <div className="gomoku-options">
          <div className="gomoku-option-group">
            <span className="gomoku-option-title">难度</span>
            <div className="gomoku-mode-selector" role="radiogroup" aria-label="AI 难度">
              <label className="gomoku-mode-option">
                <input
                  type="radio"
                  name="gomoku-difficulty"
                  value="easy"
                  checked={difficulty === 'easy'}
                  onChange={() => onDifficultyChange('easy')}
                />
                <span>简单</span>
              </label>
              <label className="gomoku-mode-option">
                <input
                  type="radio"
                  name="gomoku-difficulty"
                  value="normal"
                  checked={difficulty === 'normal'}
                  onChange={() => onDifficultyChange('normal')}
                />
                <span>普通</span>
              </label>
            </div>
          </div>

          <div className="gomoku-option-group">
            <span className="gomoku-option-title">先手</span>
            <div className="gomoku-mode-selector" role="radiogroup" aria-label="谁先手">
              <label className="gomoku-mode-option">
                <input
                  type="radio"
                  name="gomoku-first"
                  value="black"
                  checked={humanSide === 'black'}
                  onChange={() => onHumanSideChange('black')}
                />
                <span>我执黑先手</span>
              </label>
              <label className="gomoku-mode-option">
                <input
                  type="radio"
                  name="gomoku-first"
                  value="white"
                  checked={humanSide === 'white'}
                  onChange={() => onHumanSideChange('white')}
                />
                <span>我执白后手</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* 状态 */}
      <div className="board-status" style={statusColor ? { color: statusColor } : undefined}>
        {statusKind === 'thinking'
          ? `AI 思考中${THINKING_DOTS[thinkingDots]}`
          : statusText}
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
        <button
          type="button"
          className="board-btn"
          onClick={() => initGame(modeRef.current, difficulty, humanSide)}
        >
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
