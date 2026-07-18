'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 四子棋（Connect Four）— 从 Flask 侧 app/static/js/game/connect4.js 忠实移植到
// React 客户端组件。纯前端逻辑，无服务端依赖。
//
// 规则要点（与原实现一一对应）：
//   • 4 行 × 7 列棋盘；红先（red），蓝后（blue）；重力落子，四子连线获胜。
//   • 四种模式：
//       - normal   普通模式：常规落子。
//       - obstacle 障碍模式：开局先由玩家点击放置 2 枚障碍（不计入连线），再红先。
//       - blind    盲棋模式：落子后棋子淡出隐藏（仍在盘上），禁用悔棋。
//       - blind2   盲棋模式2：棋子落下即隐藏（下落动画淡出），禁用悔棋。
//   • 胜负：四方向（横/竖/两斜）连成 ≥4 子获胜；障碍子不参与判定。占满平局。
//   • 悔棋：normal / obstacle 可撤销 1 步（含障碍阶段回退），blind / blind2 禁用。
//   • 交互：点击列 / 数字键 1–7 落子；满列闪烁提示；下落动画；胜者浮层。
//
// 与原生 JS 版一致，棋盘单元格与棋子采用命令式 DOM 操作（下落动画、淡出/隐藏
// 类名、悔棋重建都依赖直接的 DOM 节点），React 只负责渲染静态外壳与响应式的
// 顶部信息（当前玩家、障碍阶段提示、悔棋禁用、胜者浮层）。棋局状态存于 ref。
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

const ROWS = 4;
const COLS = 7;

type Piece = 'red' | 'blue' | 'obstacle';
type Cell = Piece | null;
type GameMode = 'normal' | 'obstacle' | 'blind' | 'blind2';

type Snapshot = {
  board: Cell[][];
  columnHeights: number[];
  currentPlayer: 'red' | 'blue';
  obstaclePhase: boolean;
  obstaclesPlaced: number;
  row: number;
  col: number;
};

type WinResult = { isWin: boolean; winningPieces: Array<[number, number]> };

export default function Connect4() {
  // ─── DOM 引用 ───────────────────────────────────────────────────────────────
  const boardRef = useRef<HTMLDivElement | null>(null);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);

  // ─── 命令式棋局状态（对齐原文件顶部的模块级变量）─────────────────────────────
  const currentPlayerRef = useRef<'red' | 'blue'>('red');
  const boardModelRef = useRef<Cell[][]>([]);
  const columnHeightsRef = useRef<number[]>([]);
  const isDroppingRef = useRef<boolean>(false);
  const gameOverRef = useRef<boolean>(false);
  const moveHistoryRef = useRef<Snapshot[]>([]);
  const gameModeRef = useRef<GameMode>('normal');
  const obstaclePhaseRef = useRef<boolean>(false);
  const obstaclesPlacedRef = useRef<number>(0);

  // ─── React 展示态 ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<GameMode>('normal');
  const [playerText, setPlayerText] = useState<string>('红色');
  const [playerColor, setPlayerColor] = useState<string>('#ff6b6b');
  const [gameStatus, setGameStatus] = useState<string>('');
  const [obstacleText, setObstacleText] = useState<string>('');
  const [obstacleVisible, setObstacleVisible] = useState<boolean>(false);
  const [undoDisabled, setUndoDisabled] = useState<boolean>(true);
  const [winnerText, setWinnerText] = useState<string>('');
  const [winnerShow, setWinnerShow] = useState<boolean>(false);

  // ─── 顶部信息刷新（对齐 updateCurrentPlayerDisplay/updateObstaclePhase/…）──────
  const updateCurrentPlayerDisplay = useCallback(() => {
    if (obstaclePhaseRef.current) {
      setPlayerText('放置障碍');
      setPlayerColor('#8b6914');
    } else {
      setPlayerText(currentPlayerRef.current === 'red' ? '红色' : '蓝色');
      setPlayerColor(currentPlayerRef.current === 'red' ? '#ff6b6b' : '#74b9ff');
    }
  }, []);

  const updateObstaclePhase = useCallback(() => {
    if (gameModeRef.current === 'obstacle' && obstaclePhaseRef.current) {
      setObstacleVisible(true);
      setObstacleText('障碍放置阶段 (' + obstaclesPlacedRef.current + '/2)');
    } else {
      setObstacleVisible(false);
    }
  }, []);

  const updateUndoButton = useCallback(() => {
    if (gameModeRef.current === 'blind' || gameModeRef.current === 'blind2') {
      setUndoDisabled(true);
    } else {
      setUndoDisabled(moveHistoryRef.current.length === 0);
    }
  }, []);

  const updateGameStatus = useCallback((message: string) => {
    setGameStatus(message);
  }, []);

  const showWinnerAnnouncement = useCallback((message: string) => {
    setWinnerText(message);
    setWinnerShow(true);
  }, []);

  const hideWinnerAnnouncement = useCallback(() => {
    setWinnerShow(false);
  }, []);

  // ─── 棋盘构建（对齐 createBoard）──────────────────────────────────────────────
  const createBoard = useCallback((onCellClick: (col: number) => void) => {
    const boardElement = boardRef.current;
    if (!boardElement) return;
    boardElement.innerHTML = '';

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const cell = document.createElement('div');
        cell.className = 'connect4-cell';
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        cell.onclick = () => onCellClick(col);
        boardElement.appendChild(cell);
      }
    }
  }, []);

  // ─── 胜负判定（对齐 checkWin / checkDraw）────────────────────────────────────
  const checkWin = useCallback((row: number, col: number, player: 'red' | 'blue'): WinResult => {
    const board = boardModelRef.current;
    const directions: Array<[number, number]> = [
      [0, 1],
      [1, 0],
      [1, 1],
      [1, -1],
    ];

    for (let d = 0; d < directions.length; d++) {
      const dr = directions[d][0];
      const dc = directions[d][1];
      const winningPieces: Array<[number, number]> = [];

      for (let direction = -1; direction <= 1; direction += 2) {
        let r = row;
        let c = col;
        while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) {
          winningPieces.push([r, c]);
          r += dr * direction;
          c += dc * direction;
        }
      }

      const seen: Record<string, boolean> = {};
      const uniquePieces: Array<[number, number]> = [];
      for (let i = 0; i < winningPieces.length; i++) {
        const key = winningPieces[i][0] + ',' + winningPieces[i][1];
        if (!seen[key]) {
          seen[key] = true;
          uniquePieces.push(winningPieces[i]);
        }
      }

      if (uniquePieces.length >= 4) {
        return { isWin: true, winningPieces: uniquePieces };
      }
    }

    return { isWin: false, winningPieces: [] };
  }, []);

  const checkDraw = useCallback((): boolean => {
    return columnHeightsRef.current.every((height) => height >= ROWS);
  }, []);

  // ─── 显示/隐藏与高亮（对齐 showAllPieces / highlightWinningPieces / …）─────────
  const showAllPieces = useCallback(() => {
    const cells = boardRef.current?.querySelectorAll('.connect4-cell');
    cells?.forEach((cell) => {
      const piece = cell.querySelector<HTMLDivElement>('.connect4-piece');
      if (piece) {
        piece.style.opacity = '1';
        piece.style.visibility = 'visible';
        piece.classList.remove(
          'connect4-piece--blind-fade',
          'connect4-piece--blind2-fade',
          'connect4-piece--blind2-invisible'
        );
        piece.style.animation = 'none';
      }
    });
  }, []);

  const highlightWinningPieces = useCallback((winningPieces: Array<[number, number]>) => {
    const cells = boardRef.current?.querySelectorAll('.connect4-cell');
    if (!cells) return;
    winningPieces.forEach((pos) => {
      const cellIndex = pos[0] * COLS + pos[1];
      cells[cellIndex]?.classList.add('connect4-cell--winning');
    });
  }, []);

  const highlightFullColumn = useCallback((col: number) => {
    const cells = boardRef.current?.querySelectorAll('.connect4-cell');
    if (!cells) return;
    for (let row = 0; row < ROWS; row++) {
      const cellIndex = row * COLS + col;
      cells[cellIndex]?.classList.add('connect4-cell--full');
    }
    setTimeout(() => {
      for (let row = 0; row < ROWS; row++) {
        const cellIndex = row * COLS + col;
        cells[cellIndex]?.classList.remove('connect4-cell--full');
      }
    }, 500);
  }, []);

  // ─── 棋子放置辅助（对齐 placePiece / placePieceInvisible / placePieceDirectly）─
  const placePiece = useCallback((row: number, col: number, pieceType: Piece): HTMLDivElement => {
    const cells = boardRef.current!.querySelectorAll('.connect4-cell');
    const targetCell = cells[row * COLS + col];
    const piece = document.createElement('div');
    piece.className = 'connect4-piece connect4-piece--' + pieceType;
    targetCell.appendChild(piece);
    return piece;
  }, []);

  const placePieceInvisible = useCallback(
    (row: number, col: number, pieceType: Piece): HTMLDivElement => {
      const cells = boardRef.current!.querySelectorAll('.connect4-cell');
      const targetCell = cells[row * COLS + col];
      const piece = document.createElement('div');
      piece.className =
        'connect4-piece connect4-piece--' + pieceType + ' connect4-piece--blind2-invisible';
      targetCell.appendChild(piece);
      return piece;
    },
    []
  );

  const placePieceDirectly = useCallback(
    (row: number, col: number, pieceType: Piece): HTMLDivElement => {
      const cells = boardRef.current!.querySelectorAll('.connect4-cell');
      const targetCell = cells[row * COLS + col];
      const piece = document.createElement('div');
      piece.className = 'connect4-piece connect4-piece--' + pieceType;
      targetCell.appendChild(piece);
      return piece;
    },
    []
  );

  // ─── 下落动画（对齐 createFallingAnimation）───────────────────────────────────
  const createFallingAnimation = useCallback(
    (col: number, targetRow: number, pieceType: Piece) => {
      const boardContainer = boardWrapRef.current;
      if (!boardContainer) return;

      const fallingPiece = document.createElement('div');
      fallingPiece.className = 'connect4-falling-piece connect4-falling-piece--' + pieceType;

      let cellSize = 80;
      let gap = 8;
      let padding = 15;
      let pieceOffset = 5;

      if (window.innerWidth <= 640) {
        cellSize = 46;
        gap = 5;
        padding = 10;
        pieceOffset = 3;
      }

      const startX = padding + col * (cellSize + gap) + pieceOffset;

      fallingPiece.style.left = startX + 'px';
      fallingPiece.style.top = '-80px';

      if (gameModeRef.current === 'blind2' && pieceType !== 'obstacle') {
        fallingPiece.classList.add('connect4-falling-piece--blind2-fade');
      }

      boardContainer.appendChild(fallingPiece);

      const endY = padding + targetRow * (cellSize + gap) + pieceOffset;

      setTimeout(() => {
        fallingPiece.style.transition = 'top 0.35s linear';
        fallingPiece.style.top = endY + 'px';
      }, 10);

      setTimeout(() => {
        if (boardContainer.contains(fallingPiece)) {
          boardContainer.removeChild(fallingPiece);
        }
      }, 400);
    },
    []
  );

  // ─── 落子完成处理（对齐 handleMoveCompletion）────────────────────────────────
  const handleMoveCompletion = useCallback(
    (targetRow: number, col: number, _pieceType: Piece) => {
      if (obstaclePhaseRef.current) {
        obstaclesPlacedRef.current++;
        if (obstaclesPlacedRef.current >= 2) {
          obstaclePhaseRef.current = false;
          currentPlayerRef.current = 'red';
        }
        updateObstaclePhase();
      } else {
        const winResult = checkWin(targetRow, col, currentPlayerRef.current);
        if (winResult.isWin) {
          gameOverRef.current = true;
          if (gameModeRef.current === 'blind' || gameModeRef.current === 'blind2') {
            showAllPieces();
          }
          highlightWinningPieces(winResult.winningPieces);
          showWinnerAnnouncement(
            (currentPlayerRef.current === 'red' ? '红色' : '蓝色') + '玩家获胜！'
          );
        } else if (checkDraw()) {
          gameOverRef.current = true;
          if (gameModeRef.current === 'blind' || gameModeRef.current === 'blind2') {
            showAllPieces();
          }
          showWinnerAnnouncement('平局！');
        } else {
          currentPlayerRef.current = currentPlayerRef.current === 'red' ? 'blue' : 'red';
        }
      }

      updateCurrentPlayerDisplay();
      updateUndoButton();
      isDroppingRef.current = false;
    },
    [
      checkWin,
      checkDraw,
      showAllPieces,
      highlightWinningPieces,
      showWinnerAnnouncement,
      updateObstaclePhase,
      updateCurrentPlayerDisplay,
      updateUndoButton,
    ]
  );

  // ─── 落子（对齐 dropPiece）──────────────────────────────────────────────────
  const dropPiece = useCallback(
    (col: number) => {
      if (isDroppingRef.current || gameOverRef.current) return;
      if (columnHeightsRef.current[col] >= ROWS) {
        highlightFullColumn(col);
        return;
      }

      isDroppingRef.current = true;
      const targetRow = ROWS - 1 - columnHeightsRef.current[col];

      let pieceType: Piece;
      if (obstaclePhaseRef.current) {
        pieceType = 'obstacle';
      } else {
        pieceType = currentPlayerRef.current;
      }

      moveHistoryRef.current.push({
        board: boardModelRef.current.map((row) => row.slice()),
        columnHeights: columnHeightsRef.current.slice(),
        currentPlayer: currentPlayerRef.current,
        obstaclePhase: obstaclePhaseRef.current,
        obstaclesPlaced: obstaclesPlacedRef.current,
        row: targetRow,
        col: col,
      });

      createFallingAnimation(col, targetRow, pieceType);

      boardModelRef.current[targetRow][col] = pieceType;
      columnHeightsRef.current[col]++;

      setTimeout(() => {
        if (gameModeRef.current === 'blind2' && pieceType !== 'obstacle') {
          placePieceInvisible(targetRow, col, pieceType);
        } else {
          const placedPiece = placePiece(targetRow, col, pieceType);
          if (gameModeRef.current === 'blind' && pieceType !== 'obstacle') {
            placedPiece.classList.add('connect4-piece--blind-fade');
          }
        }
        handleMoveCompletion(targetRow, col, pieceType);
      }, 400);
    },
    [highlightFullColumn, createFallingAnimation, placePieceInvisible, placePiece, handleMoveCompletion]
  );

  // dropPiece 需在 createBoard 的闭包中调用，用 ref 持有最新引用
  const dropPieceRef = useRef(dropPiece);
  dropPieceRef.current = dropPiece;

  // ─── 悔棋（对齐 undoMove）────────────────────────────────────────────────────
  const undoMove = useCallback(() => {
    if (gameModeRef.current === 'blind' || gameModeRef.current === 'blind2') return;
    if (moveHistoryRef.current.length === 0 || isDroppingRef.current) return;

    const lastMove = moveHistoryRef.current.pop()!;
    const row = lastMove.row;
    const col = lastMove.col;

    const cells = boardRef.current!.querySelectorAll('.connect4-cell');
    const targetCell = cells[row * COLS + col];
    const piece = targetCell.querySelector<HTMLDivElement>('.connect4-piece');

    if (piece) {
      piece.classList.add('connect4-piece--fade-out');
      setTimeout(() => {
        boardModelRef.current = lastMove.board;
        columnHeightsRef.current = lastMove.columnHeights;
        currentPlayerRef.current = lastMove.currentPlayer;
        obstaclePhaseRef.current = lastMove.obstaclePhase;
        obstaclesPlacedRef.current = lastMove.obstaclesPlaced;
        gameOverRef.current = false;

        const allCells = boardRef.current!.querySelectorAll('.connect4-cell');
        allCells.forEach((cell) => {
          cell.innerHTML = '';
          cell.classList.remove('connect4-cell--winning');
        });

        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const val = boardModelRef.current[r][c];
            if (val) {
              const placedPiece = placePieceDirectly(r, c, val);
              if (gameModeRef.current === 'blind' && val !== 'obstacle') {
                placedPiece.classList.add('connect4-piece--blind-fade');
              } else if (gameModeRef.current === 'blind2' && val !== 'obstacle') {
                placedPiece.classList.add('connect4-piece--blind2-invisible');
              }
            }
          }
        }

        updateCurrentPlayerDisplay();
        updateUndoButton();
        updateGameStatus('');
        updateObstaclePhase();
        hideWinnerAnnouncement();
      }, 200);
    }
  }, [
    placePieceDirectly,
    updateCurrentPlayerDisplay,
    updateUndoButton,
    updateGameStatus,
    updateObstaclePhase,
    hideWinnerAnnouncement,
  ]);

  const undoMoveRef = useRef(undoMove);
  undoMoveRef.current = undoMove;

  // ─── 初始化 / 重开（对齐 initGame / resetGame）───────────────────────────────
  const initGame = useCallback(
    (nextMode: GameMode) => {
      boardModelRef.current = Array(ROWS)
        .fill(null)
        .map(() => Array<Cell>(COLS).fill(null));
      columnHeightsRef.current = Array(COLS).fill(0);
      currentPlayerRef.current = 'red';
      isDroppingRef.current = false;
      gameOverRef.current = false;
      moveHistoryRef.current = [];

      gameModeRef.current = nextMode;
      obstaclePhaseRef.current = nextMode === 'obstacle';
      obstaclesPlacedRef.current = 0;

      updateCurrentPlayerDisplay();
      updateUndoButton();
      updateGameStatus('');
      updateObstaclePhase();
      hideWinnerAnnouncement();
      createBoard((c) => dropPieceRef.current(c));
    },
    [
      updateCurrentPlayerDisplay,
      updateUndoButton,
      updateGameStatus,
      updateObstaclePhase,
      hideWinnerAnnouncement,
      createBoard,
    ]
  );

  const initGameRef = useRef(initGame);
  initGameRef.current = initGame;

  // ─── 挂载：初始化 + 键盘监听（对齐文件末尾的监听 + init）───────────────────────
  useEffect(() => {
    initGameRef.current('normal');

    const onKeydown = (event: KeyboardEvent) => {
      const key = event.key;
      if (key >= '1' && key <= '7') {
        const col = parseInt(key, 10) - 1;
        dropPieceRef.current(col);
        event.preventDefault();
      }
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 模式切换（对齐 mode change 监听 → initGame）─────────────────────────────
  const onModeChange = useCallback(
    (value: GameMode) => {
      setMode(value);
      initGameRef.current(value);
    },
    []
  );

  const resetGame = useCallback(() => {
    initGameRef.current(gameModeRef.current);
  }, []);

  return (
    <div className="connect4-page-embed">
      <style>{CONNECT4_CSS}</style>

      <div className="connect4-container">
        <div
          className={'connect4-winner-announcement' + (winnerShow ? ' show' : '')}
          id="winner-announcement"
        >
          <div id="winner-text">{winnerText}</div>
          <button
            type="button"
            className="connect4-btn connect4-btn--reset"
            onClick={resetGame}
            style={{ marginTop: 15, fontSize: 14, padding: '8px 16px' }}
          >
            再来一局
          </button>
        </div>

        <div className="connect4-mode-selector">
          <div className="connect4-mode-option">
            <input
              type="radio"
              id="normal-mode"
              name="game-mode"
              value="normal"
              checked={mode === 'normal'}
              onChange={() => onModeChange('normal')}
            />
            <label htmlFor="normal-mode">普通模式</label>
          </div>
          <div className="connect4-mode-option">
            <input
              type="radio"
              id="obstacle-mode"
              name="game-mode"
              value="obstacle"
              checked={mode === 'obstacle'}
              onChange={() => onModeChange('obstacle')}
            />
            <label htmlFor="obstacle-mode">障碍模式</label>
          </div>
          <div className="connect4-mode-option">
            <input
              type="radio"
              id="blind-mode"
              name="game-mode"
              value="blind"
              checked={mode === 'blind'}
              onChange={() => onModeChange('blind')}
            />
            <label htmlFor="blind-mode">盲棋模式</label>
          </div>
          <div className="connect4-mode-option">
            <input
              type="radio"
              id="blind2-mode"
              name="game-mode"
              value="blind2"
              checked={mode === 'blind2'}
              onChange={() => onModeChange('blind2')}
            />
            <label htmlFor="blind2-mode">盲棋模式2</label>
          </div>
        </div>

        <div className="connect4-info">
          <div className="connect4-info__player">
            当前玩家:{' '}
            <span id="current-player-color" style={{ color: playerColor }}>
              {playerText}
            </span>
          </div>
          <div className="connect4-info__status" id="game-status">
            {gameStatus}
          </div>
          <div className="connect4-controls">
            <button
              type="button"
              className="connect4-btn connect4-btn--undo"
              id="undo-btn"
              onClick={undoMove}
              disabled={undoDisabled}
            >
              悔棋
            </button>
            <button
              type="button"
              className="connect4-btn connect4-btn--reset"
              onClick={resetGame}
            >
              重新开始
            </button>
          </div>
        </div>

        <div
          className="connect4-obstacle-phase"
          id="obstacle-phase"
          style={{ display: obstacleVisible ? 'block' : 'none' }}
        >
          {obstacleText}
        </div>
        <div className="connect4-keyboard-hint">按数字键 1-7 可在对应列落子</div>

        <div className="connect4-board-wrap" ref={boardWrapRef}>
          <div className="connect4-column-numbers">
            <div className="connect4-column-number">1</div>
            <div className="connect4-column-number">2</div>
            <div className="connect4-column-number">3</div>
            <div className="connect4-column-number">4</div>
            <div className="connect4-column-number">5</div>
            <div className="connect4-column-number">6</div>
            <div className="connect4-column-number">7</div>
          </div>
          <div className="connect4-board" id="board" ref={boardRef} />
        </div>
      </div>
    </div>
  );
}

// ─── 自包含样式（移植 app/static/scss/pages/game/_connect4.scss，SCSS 变量已展开
//     为字面值；颜色令牌沿用 rebuild.css 提供的 --color-* / --shadow-* 变量）──────
const CONNECT4_CSS = `
.connect4-container {
  text-align: center;
  background: var(--color-background-card, #fff);
  padding: 24px;
  border-radius: 10px;
  box-shadow: var(--shadow-card, 0 4px 20px rgba(0,0,0,.06));
  position: relative;
  max-width: 680px;
  width: 100%;
  margin: 0 auto;
}
.connect4-mode-selector {
  margin-bottom: 12px;
  display: flex;
  justify-content: center;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.connect4-mode-option {
  display: flex;
  align-items: center;
  gap: 5px;
}
.connect4-mode-option input[type="radio"] { margin: 0; accent-color: var(--color-brand-primary, #0071E3); }
.connect4-mode-option label {
  font-size: 0.95rem;
  color: var(--color-text-primary, #1D1D1F);
  cursor: pointer;
}
.connect4-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  gap: 16px;
  flex-wrap: wrap;
}
.connect4-info__player { color: var(--color-text-primary, #1D1D1F); font-size: 1.25rem; }
.connect4-info__status {
  color: var(--color-text-primary, #1D1D1F);
  font-size: 1.1rem;
  font-weight: bold;
  min-height: 30px;
}
.connect4-controls { display: flex; gap: 8px; }
.connect4-btn {
  padding: 12px 16px;
  font-size: 0.95rem;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  color: #fff;
  transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
}
.connect4-btn:hover { transform: translateY(-2px); box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,.05)); }
.connect4-btn:active { transform: translateY(0); }
.connect4-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
.connect4-btn--undo { background: linear-gradient(45deg, #74b9ff, #0984e3); }
.connect4-btn--reset { background: linear-gradient(45deg, #ff6b6b, #ee5a24); }
.connect4-obstacle-phase {
  color: #8b6914;
  font-weight: bold;
  margin-bottom: 8px;
  display: none;
}
.connect4-keyboard-hint {
  color: var(--color-text-secondary, #6E6E73);
  font-size: 0.85rem;
  margin-bottom: 12px;
  text-align: center;
}
.connect4-board-wrap { position: relative; display: inline-block; }
.connect4-column-numbers {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 0 15px;
}
.connect4-column-number {
  width: 80px;
  text-align: center;
  font-size: 1.1rem;
  font-weight: bold;
  color: #2d5a27;
}
.connect4-board {
  background: linear-gradient(135deg, #2d5a27, #4a7c59);
  border-radius: 15px;
  padding: 15px;
  box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.3), 0 10px 30px rgba(0, 0, 0, 0.2);
  display: grid;
  grid-template-columns: repeat(7, 80px);
  grid-template-rows: repeat(4, 80px);
  gap: 8px;
}
.connect4-cell {
  width: 80px;
  height: 80px;
  background: radial-gradient(circle at 30% 30%, #fff, #e0e0e0);
  border-radius: 50%;
  cursor: pointer;
  position: relative;
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.2), 0 2px 5px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s ease-out, box-shadow 0.15s ease-out;
  display: flex;
  align-items: center;
  justify-content: center;
}
.connect4-cell:hover {
  transform: scale(1.08);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.2), 0 4px 15px rgba(0, 0, 0, 0.2);
}
.connect4-cell--winning {
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.2), 0 0 20px rgba(255, 215, 0, 0.9);
}
.connect4-cell--full { animation: connect4-full-blink 0.4s ease-out; }
.connect4-piece {
  width: 70px;
  height: 70px;
  border-radius: 50%;
  position: absolute;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3), inset 0 2px 4px rgba(255, 255, 255, 0.3), inset 0 -2px 4px rgba(0, 0, 0, 0.2);
}
.connect4-piece--red {
  background: radial-gradient(circle at 30% 30%, #ff6b6b, #e74c3c, #c0392b);
  border: 2px solid #a93226;
}
.connect4-piece--blue {
  background: radial-gradient(circle at 30% 30%, #74b9ff, #3498db, #2980b9);
  border: 2px solid #1f4e79;
}
.connect4-piece--obstacle {
  background:
    radial-gradient(circle at 30% 30%, #d4a574, #b8956a, #8b6914),
    repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(139, 105, 20, 0.1) 2px, rgba(139, 105, 20, 0.1) 4px);
  border: 2px solid #654321;
}
.connect4-piece--fade-out {
  opacity: 0;
  transform: scale(0.8);
  transition: opacity 0.15s ease-out, transform 0.15s ease-out;
}
.connect4-piece--blind-fade { animation: connect4-blind-fade-out 0.6s ease-out forwards; }
.connect4-piece--blind2-fade { animation: connect4-blind2-fade-out 0.8s ease-out forwards; }
.connect4-piece--blind2-invisible { opacity: 0 !important; visibility: hidden !important; }
.connect4-falling-piece {
  position: absolute;
  width: 70px;
  height: 70px;
  border-radius: 50%;
  z-index: 100;
  pointer-events: none;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3), inset 0 2px 4px rgba(255, 255, 255, 0.3), inset 0 -2px 4px rgba(0, 0, 0, 0.2);
}
.connect4-falling-piece--red {
  background: radial-gradient(circle at 30% 30%, #ff6b6b, #e74c3c, #c0392b);
  border: 2px solid #a93226;
}
.connect4-falling-piece--blue {
  background: radial-gradient(circle at 30% 30%, #74b9ff, #3498db, #2980b9);
  border: 2px solid #1f4e79;
}
.connect4-falling-piece--obstacle {
  background:
    radial-gradient(circle at 30% 30%, #d4a574, #b8956a, #8b6914),
    repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(139, 105, 20, 0.1) 2px, rgba(139, 105, 20, 0.1) 4px);
  border: 2px solid #654321;
}
.connect4-falling-piece--blind2-fade { animation: connect4-blind2-fall-and-fade 0.4s linear forwards; }
.connect4-winner-announcement {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--color-background-card, #fff);
  padding: 25px 35px;
  border-radius: 10px;
  box-shadow: var(--shadow-card, 0 4px 20px rgba(0,0,0,.06));
  z-index: 1000;
  text-align: center;
  font-size: 1.25rem;
  font-weight: bold;
  display: none;
  border: 3px solid #ffd700;
  color: var(--color-text-primary, #1D1D1F);
}
.connect4-winner-announcement.show { display: block; animation: connect4-pop-in 0.3s ease-out; }
@keyframes connect4-full-blink {
  0%, 100% { background: radial-gradient(circle at 30% 30%, #fff, #e0e0e0); }
  50% { background: radial-gradient(circle at 30% 30%, #ffcccc, #ffaaaa); }
}
@keyframes connect4-pop-in {
  from { transform: translate(-50%, -50%) scale(0.8); opacity: 0; }
  to { transform: translate(-50%, -50%) scale(1); opacity: 1; }
}
@keyframes connect4-blind-fade-out { 0% { opacity: 1; } 100% { opacity: 0; } }
@keyframes connect4-blind2-fade-out { 0% { opacity: 1; } 100% { opacity: 0; } }
@keyframes connect4-blind2-fall-and-fade { 0% { opacity: 1; } 70% { opacity: 0.2; } 100% { opacity: 0; } }
:root[data-theme="dark"] .connect4-cell {
  background: radial-gradient(circle at 30% 30%, #555, #3a3a3a);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.4), 0 2px 5px rgba(0, 0, 0, 0.5);
}
@media (max-width: 640px) {
  .connect4-container { padding: 12px; margin: 0 8px; border-radius: 5px; }
  .connect4-board {
    grid-template-columns: repeat(7, 46px);
    grid-template-rows: repeat(4, 46px);
    gap: 5px;
    padding: 10px;
    border-radius: 10px;
  }
  .connect4-cell { width: 46px; height: 46px; }
  .connect4-piece { width: 40px; height: 40px; }
  .connect4-falling-piece { width: 40px; height: 40px; }
  .connect4-column-number { width: 46px; font-size: 0.9rem; }
  .connect4-column-numbers { gap: 5px; padding: 0 10px; }
  .connect4-btn { padding: 8px 12px; font-size: 0.85rem; }
  .connect4-mode-selector { gap: 8px; font-size: 0.85rem; }
}
`;
