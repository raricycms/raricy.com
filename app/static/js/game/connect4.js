(function() {
  var ROWS = 4;
  var COLS = 7;
  var currentPlayer = 'red';
  var board = [];
  var columnHeights = [];
  var isDropping = false;
  var gameOver = false;
  var moveHistory = [];
  var gameMode = 'normal';
  var obstaclePhase = false;
  var obstaclesPlaced = 0;

  function initGame() {
    board = Array(ROWS).fill().map(function() { return Array(COLS).fill(null); });
    columnHeights = Array(COLS).fill(0);
    currentPlayer = 'red';
    isDropping = false;
    gameOver = false;
    moveHistory = [];

    gameMode = document.querySelector('input[name="game-mode"]:checked').value;
    obstaclePhase = gameMode === 'obstacle';
    obstaclesPlaced = 0;

    updateCurrentPlayerDisplay();
    updateUndoButton();
    updateGameStatus('');
    updateObstaclePhase();
    hideWinnerAnnouncement();
    createBoard();
  }

  function createBoard() {
    var boardElement = document.getElementById('board');
    boardElement.innerHTML = '';

    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var cell = document.createElement('div');
        cell.className = 'connect4-cell';
        cell.dataset.row = row;
        cell.dataset.col = col;
        cell.onclick = (function(c) { return function() { dropPiece(c); }; })(col);
        boardElement.appendChild(cell);
      }
    }
  }

  function dropPiece(col) {
    if (isDropping || gameOver) { return; }
    if (columnHeights[col] >= ROWS) {
      highlightFullColumn(col);
      return;
    }

    isDropping = true;
    var targetRow = ROWS - 1 - columnHeights[col];

    var pieceType;
    if (obstaclePhase) {
      pieceType = 'obstacle';
    } else {
      pieceType = currentPlayer;
    }

    moveHistory.push({
      board: board.map(function(row) { return row.slice(); }),
      columnHeights: columnHeights.slice(),
      currentPlayer: currentPlayer,
      obstaclePhase: obstaclePhase,
      obstaclesPlaced: obstaclesPlaced,
      row: targetRow,
      col: col
    });

    createFallingAnimation(col, targetRow, pieceType);

    board[targetRow][col] = pieceType;
    columnHeights[col]++;

    setTimeout(function() {
      var placedPiece;
      if (gameMode === 'blind2' && pieceType !== 'obstacle') {
        placedPiece = placePieceInvisible(targetRow, col, pieceType);
      } else {
        placedPiece = placePiece(targetRow, col, pieceType);
        if (gameMode === 'blind' && pieceType !== 'obstacle') {
          placedPiece.classList.add('connect4-piece--blind-fade');
        }
      }
      handleMoveCompletion(targetRow, col, pieceType);
    }, 400);
  }

  function handleMoveCompletion(targetRow, col, pieceType) {
    if (obstaclePhase) {
      obstaclesPlaced++;
      if (obstaclesPlaced >= 2) {
        obstaclePhase = false;
        currentPlayer = 'red';
      }
      updateObstaclePhase();
    } else {
      var winResult = checkWin(targetRow, col, currentPlayer);
      if (winResult.isWin) {
        gameOver = true;
        if (gameMode === 'blind' || gameMode === 'blind2') {
          showAllPieces();
        }
        highlightWinningPieces(winResult.winningPieces);
        showWinnerAnnouncement((currentPlayer === 'red' ? '红色' : '蓝色') + '玩家获胜！');
      } else if (checkDraw()) {
        gameOver = true;
        if (gameMode === 'blind' || gameMode === 'blind2') {
          showAllPieces();
        }
        showWinnerAnnouncement('平局！');
      } else {
        currentPlayer = currentPlayer === 'red' ? 'blue' : 'red';
      }
    }

    updateCurrentPlayerDisplay();
    updateUndoButton();
    isDropping = false;
  }

  function checkWin(row, col, player) {
    if (player === 'obstacle') {
      return { isWin: false, winningPieces: [] };
    }

    var directions = [[0, 1], [1, 0], [1, 1], [1, -1]];

    for (var d = 0; d < directions.length; d++) {
      var dr = directions[d][0];
      var dc = directions[d][1];
      var winningPieces = [];

      for (var direction = -1; direction <= 1; direction += 2) {
        var r = row;
        var c = col;
        while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) {
          winningPieces.push([r, c]);
          r += dr * direction;
          c += dc * direction;
        }
      }

      var seen = {};
      var uniquePieces = [];
      for (var i = 0; i < winningPieces.length; i++) {
        var key = winningPieces[i][0] + ',' + winningPieces[i][1];
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
  }

  function checkDraw() {
    return columnHeights.every(function(height) { return height >= ROWS; });
  }

  function showAllPieces() {
    var cells = document.querySelectorAll('.connect4-cell');
    cells.forEach(function(cell) {
      var piece = cell.querySelector('.connect4-piece');
      if (piece) {
        piece.style.opacity = '1';
        piece.style.visibility = 'visible';
        piece.classList.remove('connect4-piece--blind-fade', 'connect4-piece--blind2-fade', 'connect4-piece--blind2-invisible');
        piece.style.animation = 'none';
      }
    });
  }

  function highlightWinningPieces(winningPieces) {
    var cells = document.querySelectorAll('.connect4-cell');
    winningPieces.forEach(function(pos) {
      var cellIndex = pos[0] * COLS + pos[1];
      cells[cellIndex].classList.add('connect4-cell--winning');
    });
  }

  function highlightFullColumn(col) {
    var cells = document.querySelectorAll('.connect4-cell');
    for (var row = 0; row < ROWS; row++) {
      var cellIndex = row * COLS + col;
      cells[cellIndex].classList.add('connect4-cell--full');
    }
    setTimeout(function() {
      for (var row = 0; row < ROWS; row++) {
        var cellIndex = row * COLS + col;
        cells[cellIndex].classList.remove('connect4-cell--full');
      }
    }, 500);
  }

  function undoMove() {
    if (gameMode === 'blind' || gameMode === 'blind2') { return; }
    if (moveHistory.length === 0 || isDropping) { return; }

    var lastMove = moveHistory.pop();
    var row = lastMove.row;
    var col = lastMove.col;

    var cells = document.querySelectorAll('.connect4-cell');
    var targetCell = cells[row * COLS + col];
    var piece = targetCell.querySelector('.connect4-piece');

    if (piece) {
      piece.classList.add('connect4-piece--fade-out');
      setTimeout(function() {
        board = lastMove.board;
        columnHeights = lastMove.columnHeights;
        currentPlayer = lastMove.currentPlayer;
        obstaclePhase = lastMove.obstaclePhase;
        obstaclesPlaced = lastMove.obstaclesPlaced;
        gameOver = false;

        var allCells = document.querySelectorAll('.connect4-cell');
        allCells.forEach(function(cell) {
          cell.innerHTML = '';
          cell.classList.remove('connect4-cell--winning');
        });

        for (var r = 0; r < ROWS; r++) {
          for (var c = 0; c < COLS; c++) {
            if (board[r][c]) {
              var placedPiece = placePieceDirectly(r, c, board[r][c]);
              if (gameMode === 'blind' && board[r][c] !== 'obstacle') {
                placedPiece.classList.add('connect4-piece--blind-fade');
              } else if (gameMode === 'blind2' && board[r][c] !== 'obstacle') {
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
  }

  function createFallingAnimation(col, targetRow, pieceType) {
    var boardContainer = document.querySelector('.connect4-board-wrap');
    if (!boardContainer) { return; }

    var fallingPiece = document.createElement('div');
    fallingPiece.className = 'connect4-falling-piece connect4-falling-piece--' + pieceType;

    var cellSize = 80;
    var gap = 8;
    var padding = 15;
    var pieceOffset = 5;

    if (window.innerWidth <= 640) {
      cellSize = 46;
      gap = 5;
      padding = 10;
      pieceOffset = 3;
    }

    var startX = padding + col * (cellSize + gap) + pieceOffset;

    fallingPiece.style.left = startX + 'px';
    fallingPiece.style.top = '-80px';

    if (gameMode === 'blind2' && pieceType !== 'obstacle') {
      fallingPiece.classList.add('connect4-falling-piece--blind2-fade');
    }

    boardContainer.appendChild(fallingPiece);

    var endY = padding + targetRow * (cellSize + gap) + pieceOffset;

    setTimeout(function() {
      fallingPiece.style.transition = 'top 0.35s linear';
      fallingPiece.style.top = endY + 'px';
    }, 10);

    setTimeout(function() {
      if (boardContainer.contains(fallingPiece)) {
        boardContainer.removeChild(fallingPiece);
      }
    }, 400);
  }

  function placePiece(row, col, pieceType) {
    var cells = document.querySelectorAll('.connect4-cell');
    var targetCell = cells[row * COLS + col];
    var piece = document.createElement('div');
    piece.className = 'connect4-piece connect4-piece--' + pieceType;
    targetCell.appendChild(piece);
    return piece;
  }

  function placePieceInvisible(row, col, pieceType) {
    var cells = document.querySelectorAll('.connect4-cell');
    var targetCell = cells[row * COLS + col];
    var piece = document.createElement('div');
    piece.className = 'connect4-piece connect4-piece--' + pieceType + ' connect4-piece--blind2-invisible';
    targetCell.appendChild(piece);
    return piece;
  }

  function placePieceDirectly(row, col, pieceType) {
    var cells = document.querySelectorAll('.connect4-cell');
    var targetCell = cells[row * COLS + col];
    var piece = document.createElement('div');
    piece.className = 'connect4-piece connect4-piece--' + pieceType;
    targetCell.appendChild(piece);
    return piece;
  }

  function updateCurrentPlayerDisplay() {
    var playerDisplay = document.getElementById('current-player-color');
    if (obstaclePhase) {
      playerDisplay.textContent = '放置障碍';
      playerDisplay.style.color = '#8b6914';
    } else {
      playerDisplay.textContent = currentPlayer === 'red' ? '红色' : '蓝色';
      playerDisplay.style.color = currentPlayer === 'red' ? '#ff6b6b' : '#74b9ff';
    }
  }

  function updateObstaclePhase() {
    var obstaclePhaseElement = document.getElementById('obstacle-phase');
    if (gameMode === 'obstacle' && obstaclePhase) {
      obstaclePhaseElement.style.display = 'block';
      obstaclePhaseElement.textContent = '障碍放置阶段 (' + obstaclesPlaced + '/2)';
    } else {
      obstaclePhaseElement.style.display = 'none';
    }
  }

  function updateUndoButton() {
    var undoBtn = document.getElementById('undo-btn');
    if (gameMode === 'blind' || gameMode === 'blind2') {
      undoBtn.disabled = true;
    } else {
      undoBtn.disabled = moveHistory.length === 0;
    }
  }

  function updateGameStatus(message) {
    document.getElementById('game-status').textContent = message;
  }

  function showWinnerAnnouncement(message) {
    document.getElementById('winner-text').textContent = message;
    document.getElementById('winner-announcement').classList.add('show');
  }

  function hideWinnerAnnouncement() {
    document.getElementById('winner-announcement').classList.remove('show');
  }

  function resetGame() {
    initGame();
  }

  // Mode change listeners
  var modeRadios = document.querySelectorAll('input[name="game-mode"]');
  modeRadios.forEach(function(radio) {
    radio.addEventListener('change', function() {
      initGame();
    });
  });

  // Keyboard events
  document.addEventListener('keydown', function(event) {
    var key = event.key;
    if (key >= '1' && key <= '7') {
      var col = parseInt(key) - 1;
      dropPiece(col);
      event.preventDefault();
    }
  });

  // Expose for inline onclick handlers
  window.resetGame = resetGame;
  window.undoMove = undoMove;

  // Init
  initGame();
})();
