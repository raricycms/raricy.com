/**
 * Gomoku (五子棋) — Board Model
 * Pure data layer: 15×15 grid, move validation, win detection, move history.
 */
(function() {
  var C = window.GomokuConstants;
  var EMPTY = C.EMPTY;
  var BLACK = C.BLACK;
  var WHITE = C.WHITE;
  var SIZE = C.BOARD_SIZE;
  var DIRS = C.DIRECTIONS;

  /**
   * @param {number} [size=15]
   */
  function GomokuBoard(size) {
    this.size = size || SIZE;
    this.grid = null;
    this.moveHistory = [];
    this.moveCount = 0;
    this.reset();
  }

  GomokuBoard.prototype.reset = function() {
    this.grid = [];
    for (var r = 0; r < this.size; r++) {
      this.grid[r] = new Array(this.size).fill(EMPTY);
    }
    this.moveHistory = [];
    this.moveCount = 0;
  };

  /** Check bounds + cell emptiness. */
  GomokuBoard.prototype.isValidMove = function(row, col) {
    return row >= 0 && row < this.size &&
           col >= 0 && col < this.size &&
           this.grid[row][col] === EMPTY;
  };

  /** Place a stone. Returns true on success. */
  GomokuBoard.prototype.placeStone = function(row, col, player) {
    if (!this.isValidMove(row, col)) return false;
    this.grid[row][col] = player;
    this.moveHistory.push({ row: row, col: col, player: player });
    this.moveCount++;
    return true;
  };

  /** Undo the last move. Returns the removed move or null. */
  GomokuBoard.prototype.undo = function() {
    if (this.moveHistory.length === 0) return null;
    var move = this.moveHistory.pop();
    this.grid[move.row][move.col] = EMPTY;
    this.moveCount--;
    return move;
  };

  /**
   * Check whether the last stone placed at (row, col) by `player`
   * created a winning line. Returns { won: boolean, line: [{row,col}] }.
   */
  GomokuBoard.prototype.checkWinAt = function(row, col, player) {
    for (var d = 0; d < DIRS.length; d++) {
      var dr = DIRS[d][0];
      var dc = DIRS[d][1];
      var line = [[row, col]];

      // Scan positive direction
      var r = row + dr, c = col + dc;
      while (r >= 0 && r < this.size && c >= 0 && c < this.size && this.grid[r][c] === player) {
        line.push([r, c]);
        r += dr; c += dc;
      }
      // Scan negative direction
      r = row - dr; c = col - dc;
      while (r >= 0 && r < this.size && c >= 0 && c < this.size && this.grid[r][c] === player) {
        line.unshift([r, c]);
        r -= dr; c -= dc;
      }

      if (line.length >= C.WIN_LENGTH) {
        return { won: true, line: line };
      }
    }
    return { won: false, line: [] };
  };

  /** Whether the board is completely full. */
  GomokuBoard.prototype.isFull = function() {
    return this.moveCount >= this.size * this.size;
  };

  /** Return the most recent move or null. */
  GomokuBoard.prototype.getLastMove = function() {
    if (this.moveHistory.length === 0) return null;
    return this.moveHistory[this.moveHistory.length - 1];
  };

  /** Return a copy of the full move history. */
  GomokuBoard.prototype.getHistory = function() {
    return this.moveHistory.slice();
  };

  /**
   * Get candidate empty cells within `range` steps of any stone.
   * On an empty board returns only the center cell.
   * @param {number} range — search radius (default 2)
   * @returns {Array<{row:number, col:number}>}
   */
  GomokuBoard.prototype.getCandidateCells = function(range) {
    if (range === undefined) range = 2;
    var seen = {};
    var hasStone = false;
    var self = this;

    function addCell(r, c) {
      if (r < 0 || r >= self.size || c < 0 || c >= self.size) return;
      if (self.grid[r][c] !== EMPTY) return;
      var key = r * self.size + c;
      if (seen[key]) return;
      seen[key] = true;
    }

    for (var r = 0; r < this.size; r++) {
      for (var c = 0; c < this.size; c++) {
        if (this.grid[r][c] !== EMPTY) {
          hasStone = true;
          for (var dr = -range; dr <= range; dr++) {
            for (var dc = -range; dc <= range; dc++) {
              addCell(r + dr, c + dc);
            }
          }
        }
      }
    }

    if (!hasStone) {
      var center = Math.floor(this.size / 2);
      return [{ row: center, col: center }];
    }

    var result = [];
    var keys = Object.keys(seen);
    for (var i = 0; i < keys.length; i++) {
      var key = parseInt(keys[i], 10);
      result.push({ row: Math.floor(key / this.size), col: key % this.size });
    }
    return result;
  };

  window.GomokuBoard = GomokuBoard;
})();
