(function() {
  var superBoardElement = document.getElementById('super-board');
  var statusDisplay = document.getElementById('status-display');
  var restartButton = document.getElementById('restart-button');
  var undoButton = document.getElementById('undo-button');

  var winningConditions = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6],
    [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]
  ];

  var currentPlayer, gameActive, nextBoardIndex, miniBoardStates, superBoardState, gameHistory;

  function initializeGame() {
    currentPlayer = 'X';
    gameActive = true;
    nextBoardIndex = null;
    miniBoardStates = Array(9).fill(null).map(function() { return Array(9).fill(''); });
    superBoardState = Array(9).fill('');
    gameHistory = [];
    superBoardElement.innerHTML = '';
    for (var i = 0; i < 9; i++) {
      var miniBoard = document.createElement('div');
      miniBoard.classList.add('uttt-mini');
      miniBoard.dataset.boardIndex = i;
      for (var j = 0; j < 9; j++) {
        var cell = document.createElement('div');
        cell.classList.add('uttt-cell');
        cell.dataset.boardIndex = i;
        cell.dataset.cellIndex = j;
        cell.addEventListener('click', handleCellClick);
        miniBoard.appendChild(cell);
      }
      superBoardElement.appendChild(miniBoard);
    }
    updateStatus();
    updateBoardHighlights();
    updateUndoButton();
  }

  function saveState() {
    gameHistory.push({
      currentPlayer: currentPlayer,
      gameActive: gameActive,
      nextBoardIndex: nextBoardIndex,
      miniBoardStates: JSON.parse(JSON.stringify(miniBoardStates)),
      superBoardState: superBoardState.slice()
    });
  }

  function handleCellClick(event) {
    if (!gameActive) return;
    var clickedCell = event.target;
    var boardIndex = parseInt(clickedCell.dataset.boardIndex);
    var cellIndex = parseInt(clickedCell.dataset.cellIndex);

    // Reject if: cell occupied, board already won/tied, or wrong board when directed
    if (miniBoardStates[boardIndex][cellIndex] !== '' ||
        superBoardState[boardIndex] !== '' ||
        (nextBoardIndex !== null && boardIndex !== nextBoardIndex)) {
      return;
    }

    saveState();
    miniBoardStates[boardIndex][cellIndex] = currentPlayer;

    var miniWinner = checkWinner(miniBoardStates[boardIndex]);
    if (miniWinner && superBoardState[boardIndex] === '') {
      superBoardState[boardIndex] = miniWinner;
      if (checkWinner(superBoardState)) {
        gameActive = false;
      }
    }

    // Check if all boards are completed (tie on the super board)
    if (gameActive && superBoardState.every(function(s) { return s !== ''; })) {
      gameActive = false;
    }

    currentPlayer = currentPlayer === 'X' ? 'O' : 'X';

    // Set next board; if the cell points to a completed board, free choice
    nextBoardIndex = (superBoardState[cellIndex] !== '') ? null : cellIndex;

    syncUIWithState();
    updateStatus();
    updateBoardHighlights();
    updateUndoButton();
  }

  function undoMove() {
    if (gameHistory.length === 0) return;
    var lastState = gameHistory.pop();
    currentPlayer = lastState.currentPlayer;
    gameActive = lastState.gameActive;
    nextBoardIndex = lastState.nextBoardIndex;
    miniBoardStates = lastState.miniBoardStates;
    superBoardState = lastState.superBoardState;
    syncUIWithState();
    updateStatus();
    updateBoardHighlights();
    updateUndoButton();
  }

  function syncUIWithState() {
    for (var i = 0; i < 9; i++) {
      var miniBoardElement = superBoardElement.children[i];
      miniBoardElement.className = 'uttt-mini';
      if (superBoardState[i]) {
        if (superBoardState[i] === 'T') {
          miniBoardElement.classList.add('uttt-mini--tied');
        } else {
          miniBoardElement.classList.add('uttt-mini--won');
          miniBoardElement.classList.add(superBoardState[i] === 'X' ? 'uttt-mini--won-x' : 'uttt-mini--won-o');
          miniBoardElement.dataset.winner = superBoardState[i];
        }
      }
      for (var j = 0; j < 9; j++) {
        var cell = miniBoardElement.children[j];
        cell.textContent = miniBoardStates[i][j];
        cell.className = 'uttt-cell';
        if (miniBoardStates[i][j]) {
          cell.classList.add(miniBoardStates[i][j] === 'X' ? 'uttt-cell--x' : 'uttt-cell--o');
        }
      }
    }
  }

  function checkWinner(board) {
    for (var i = 0; i < winningConditions.length; i++) {
      var c = winningConditions[i];
      if (board[c[0]] && board[c[0]] === board[c[1]] && board[c[0]] === board[c[2]] && board[c[0]] !== 'T') {
        return board[c[0]];
      }
    }
    return board.includes('') ? null : 'T';
  }

  function updateStatus() {
    var superWinner = checkWinner(superBoardState);
    if (superWinner) {
      gameActive = false;
      statusDisplay.textContent = superWinner === 'T' ? '平局！' : '玩家 ' + superWinner + ' 获胜！';
      statusDisplay.style.color = superWinner === 'T' ? '#757575' : (superWinner === 'X' ? '#d32f2f' : '#1976d2');
      return;
    }
    // Check super-board tie (all boards completed)
    if (superBoardState.every(function(s) { return s !== ''; })) {
      gameActive = false;
      statusDisplay.textContent = '平局！';
      statusDisplay.style.color = '#757575';
      return;
    }
    statusDisplay.style.color = '#3f51b5';
    statusDisplay.textContent = '当前玩家: ' + currentPlayer + (nextBoardIndex === null ? ' (自由选择)' : '');
  }

  function updateBoardHighlights() {
    superBoardElement.classList.remove('uttt-board--free-play');
    var miniBoards = document.querySelectorAll('.uttt-mini');
    miniBoards.forEach(function(board) {
      board.classList.remove('uttt-mini--active', 'uttt-mini--playable');
    });

    if (!gameActive) return;

    // Fix: if nextBoardIndex points to a completed board, switch to free play
    if (nextBoardIndex !== null && superBoardState[nextBoardIndex] !== '') {
      nextBoardIndex = null;
    }

    if (nextBoardIndex === null) {
      superBoardElement.classList.add('uttt-board--free-play');
      miniBoards.forEach(function(board, index) {
        if (superBoardState[index] === '') {
          board.classList.add('uttt-mini--playable');
        }
      });
    } else {
      var targetBoard = document.querySelector('.uttt-mini[data-board-index="' + nextBoardIndex + '"]');
      if (targetBoard) {
        targetBoard.classList.add('uttt-mini--active');
      }
    }
  }

  function updateUndoButton() {
    undoButton.disabled = gameHistory.length === 0 || !gameActive;
  }

  restartButton.addEventListener('click', initializeGame);
  undoButton.addEventListener('click', undoMove);
  initializeGame();
})();
