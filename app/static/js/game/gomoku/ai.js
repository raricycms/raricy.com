/**
 * Gomoku (五子棋) — AI Engine
 * Hybrid approach: immediate win/block detection + depth-limited Minimax
 * with Alpha-Beta pruning, powered by a pattern-based heuristic evaluator.
 *
 * Search parameters (from GomokuConstants):
 *   MAX_DEPTH        = 4   — search plies
 *   CANDIDATE_WIDTH  = 12  — top moves expanded per node
 *   DEFENSE_WEIGHT   = 1.05
 */
(function() {
  var C = window.GomokuConstants;
  var EMPTY = C.EMPTY;
  var BLACK = C.BLACK;
  var WHITE = C.WHITE;
  var SIZE = C.BOARD_SIZE;
  var DIRS = C.DIRECTIONS;
  var SCORE = C.SCORE;
  var INF = 1e9;

  /**
   * @param {GomokuBoard} board
   * @param {number} aiPlayer — BLACK or WHITE
   */
  function GomokuAI(board, aiPlayer) {
    this.board = board;
    this.aiPlayer = aiPlayer;
    this.humanPlayer = aiPlayer === BLACK ? WHITE : BLACK;
  }

  // ─── public API ──────────────────────────────────────────────

  /**
   * Return the best move as { row, col }.
   * Runs synchronously; call only when it's the AI's turn.
   */
  GomokuAI.prototype.getBestMove = function() {
    var candidates = this.board.getCandidateCells(2);

    // ── Fast path 1: can AI win immediately? ──
    for (var i = 0; i < candidates.length; i++) {
      var cr = candidates[i].row, cc = candidates[i].col;
      this.board.placeStone(cr, cc, this.aiPlayer);
      var wr = this.board.checkWinAt(cr, cc, this.aiPlayer);
      this.board.undo();
      if (wr.won) return { row: cr, col: cc };
    }

    // ── Fast path 2: must block human? ──
    for (var i = 0; i < candidates.length; i++) {
      var cr = candidates[i].row, cc = candidates[i].col;
      this.board.placeStone(cr, cc, this.humanPlayer);
      var wr = this.board.checkWinAt(cr, cc, this.humanPlayer);
      this.board.undo();
      if (wr.won) return { row: cr, col: cc };
    }

    // ── Move ordering: score each candidate for sorting ──
    var self = this;
    var scored = candidates.map(function(c) {
      var off = self._quickEval(c.row, c.col, self.aiPlayer);
      var def = self._quickEval(c.row, c.col, self.humanPlayer);
      return { row: c.row, col: c.col, score: off + def * C.DEFENSE_WEIGHT };
    });
    scored.sort(function(a, b) { return b.score - a.score; });

    // ── Minimax search over top candidates ──
    var bestScore = -INF;
    var bestMove = scored[0];
    var topN = Math.min(scored.length, C.CANDIDATE_WIDTH);

    for (var i = 0; i < topN; i++) {
      var r = scored[i].row, c = scored[i].col;
      this.board.placeStone(r, c, this.aiPlayer);

      var winCheck = this.board.checkWinAt(r, c, this.aiPlayer);
      var score;
      if (winCheck.won) {
        score = SCORE.FIVE;
      } else if (this.board.isFull()) {
        score = 0;
      } else {
        score = this._minimax(C.MAX_DEPTH - 1, -INF, INF, false);
      }

      this.board.undo();

      if (score > bestScore) {
        bestScore = score;
        bestMove = { row: r, col: c };
      }
    }

    return bestMove;
  };

  // ─── Minimax with Alpha-Beta ─────────────────────────────────

  /**
   * Recursive minimax search.
   * @param {number} depth — plies remaining
   * @param {number} alpha
   * @param {number} beta
   * @param {boolean} maximizing — true = AI's turn, false = human's turn
   * @returns {number} board evaluation from AI's perspective
   */
  GomokuAI.prototype._minimax = function(depth, alpha, beta, maximizing) {
    // Leaf node
    if (depth === 0) {
      return this._evaluateBoard();
    }

    var player = maximizing ? this.aiPlayer : this.humanPlayer;
    var candidates = this.board.getCandidateCells(2);

    // Quick-evaluate + sort for move ordering
    var self = this;
    var scored = candidates.map(function(c) {
      return {
        row: c.row, col: c.col,
        score: self._quickEval(c.row, c.col, player)
      };
    });
    scored.sort(function(a, b) { return b.score - a.score; });
    var limit = Math.min(scored.length, C.CANDIDATE_WIDTH);

    if (maximizing) {
      var best = -INF;
      for (var i = 0; i < limit; i++) {
        var r = scored[i].row, c = scored[i].col;
        this.board.placeStone(r, c, player);

        var winCheck = this.board.checkWinAt(r, c, player);
        var childScore;
        if (winCheck.won) {
          childScore = SCORE.FIVE;   // AI wins → very good
        } else if (this.board.isFull()) {
          childScore = 0;
        } else {
          childScore = this._minimax(depth - 1, alpha, beta, false);
        }

        this.board.undo();

        if (childScore > best) best = childScore;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;   // prune
      }
      return best;
    } else {
      var best = INF;
      for (var i = 0; i < limit; i++) {
        var r = scored[i].row, c = scored[i].col;
        this.board.placeStone(r, c, player);

        var winCheck = this.board.checkWinAt(r, c, player);
        var childScore;
        if (winCheck.won) {
          childScore = -SCORE.FIVE;  // human wins → very bad
        } else if (this.board.isFull()) {
          childScore = 0;
        } else {
          childScore = this._minimax(depth - 1, alpha, beta, true);
        }

        this.board.undo();

        if (childScore < best) best = childScore;
        if (best < beta) beta = best;
        if (alpha >= beta) break;   // prune
      }
      return best;
    }
  };

  // ─── Full-board heuristic evaluation ─────────────────────────

  /**
   * Evaluate the entire board from AI's perspective.
   *   positive = AI advantage, negative = human advantage.
   */
  GomokuAI.prototype._evaluateBoard = function() {
    var aiScore = 0;
    var humanScore = 0;
    var last = this.board.getLastMove();
    var lastPlayer = last ? last.player : null;

    // If the last move created a win, it was already caught in _minimax.
    // Here we evaluate the "quiet" board.

    // Scan all lines: rows, columns, diagonals
    aiScore += this._scanLines(this.aiPlayer);
    humanScore += this._scanLines(this.humanPlayer);

    // Center-proximity bonus (small, breaks ties toward center)
    var centerBonus = 0;
    var center = Math.floor(SIZE / 2);
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (this.board.grid[r][c] === this.aiPlayer) {
          centerBonus += Math.max(0, SIZE - Math.abs(r - center) - Math.abs(c - center));
        }
        if (this.board.grid[r][c] === this.humanPlayer) {
          centerBonus -= Math.max(0, SIZE - Math.abs(r - center) - Math.abs(c - center));
        }
      }
    }

    return aiScore - humanScore * C.DEFENSE_WEIGHT + centerBonus * SCORE.CENTER_WEIGHT;
  };

  /**
   * Scan every row, column, and diagonal on the board for patterns
   * belonging to `player`. Returns a summed score.
   */
  GomokuAI.prototype._scanLines = function(player) {
    var total = 0;

    // Rows
    for (var r = 0; r < SIZE; r++) {
      total += this._evalLine(r, 0, 0, 1, player);
    }
    // Columns
    for (var c = 0; c < SIZE; c++) {
      total += this._evalLine(0, c, 1, 0, player);
    }
    // Diagonals ↘ (top edge + left edge)
    for (var r = 0; r < SIZE; r++) {
      total += this._evalLine(r, 0, 1, 1, player);
    }
    for (var c = 1; c < SIZE; c++) {
      total += this._evalLine(0, c, 1, 1, player);
    }
    // Anti-diagonals ↙ (top edge + right edge)
    for (var r = 0; r < SIZE; r++) {
      total += this._evalLine(r, SIZE - 1, 1, -1, player);
    }
    for (var c = 0; c < SIZE - 1; c++) {
      total += this._evalLine(0, c, 1, -1, player);
    }

    return total;
  };

  /**
   * Walk along a line defined by (startR, startC, dr, dc) and sum
   * pattern scores for consecutive runs of `player` stones.
   */
  GomokuAI.prototype._evalLine = function(r, c, dr, dc, player) {
    var score = 0;

    while (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
      var cell = this.board.grid[r][c];

      if (cell === EMPTY) {
        r += dr; c += dc;
        continue;
      }

      if (cell !== player) {
        // Opponent stone — skip single cell, keep scanning
        r += dr; c += dc;
        continue;
      }

      // Start of a run of `player` stones
      var runR = r, runC = c;
      var count = 0;
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && this.board.grid[r][c] === player) {
        count++;
        r += dr; c += dc;
      }

      // Check open ends on both sides of the run
      var beforeR = runR - dr, beforeC = runC - dc;
      var afterR = r, afterC = c;
      var openBefore = this._inBounds(beforeR, beforeC) && this.board.grid[beforeR][beforeC] === EMPTY;
      var openAfter  = this._inBounds(afterR, afterC)   && this.board.grid[afterR][afterC]   === EMPTY;
      var openEnds = (openBefore ? 1 : 0) + (openAfter ? 1 : 0);

      score += this._classifyScore(count, openEnds);
      // r, c already point past the run — loop continues
    }

    return score;
  };

  // ─── Quick single-cell evaluation (for move ordering) ────────

  /**
   * Estimate the value of placing `player`'s stone at (row, col)
   * WITHOUT modifying the board. Fast; used for candidate sorting.
   */
  GomokuAI.prototype._quickEval = function(row, col, player) {
    var score = 0;
    for (var d = 0; d < DIRS.length; d++) {
      score += this._evalDirVirtual(row, col, DIRS[d][0], DIRS[d][1], player);
    }
    // Small center bonus
    var center = Math.floor(SIZE / 2);
    score += Math.max(0, SIZE - Math.abs(row - center) - Math.abs(col - center)) * SCORE.CENTER_WEIGHT;
    return score;
  };

  /**
   * Evaluate what pattern would form if `player` placed a stone at (row, col),
   * looking only in one direction (dr, dc).
   * The cell at (row, col) is currently EMPTY — we treat it as if it has player's stone.
   */
  GomokuAI.prototype._evalDirVirtual = function(row, col, dr, dc, player) {
    var count = 1;   // the virtual stone at (row, col)
    var openEnds = 0;
    var jumpBonus = 0;

    // Positive direction
    var r = row + dr, c = col + dc;
    while (this._inBounds(r, c) && this.board.grid[r][c] === player) {
      count++;
      r += dr; c += dc;
    }
    if (this._inBounds(r, c) && this.board.grid[r][c] === EMPTY) {
      openEnds++;
      // Jump check: after the gap, is there another same-color stone?
      var jr = r + dr, jc = c + dc;
      if (this._inBounds(jr, jc) && this.board.grid[jr][jc] === player) {
        while (this._inBounds(jr, jc) && this.board.grid[jr][jc] === player) {
          jumpBonus++;
          jr += dr; jc += dc;
        }
      }
    }

    // Negative direction
    r = row - dr; c = col - dc;
    while (this._inBounds(r, c) && this.board.grid[r][c] === player) {
      count++;
      r -= dr; c -= dc;
    }
    if (this._inBounds(r, c) && this.board.grid[r][c] === EMPTY) {
      openEnds++;
      var jr = r - dr, jc = c - dc;
      if (this._inBounds(jr, jc) && this.board.grid[jr][jc] === player) {
        while (this._inBounds(jr, jc) && this.board.grid[jr][jc] === player) {
          jumpBonus++;
          jr -= dr; jc -= dc;
        }
      }
    }

    count += Math.floor(jumpBonus * 0.8);
    return this._classifyScore(count, openEnds);
  };

  // ─── Pattern classification ──────────────────────────────────

  /**
   * Map (consecutiveCount, openEnds) to a score.
   */
  GomokuAI.prototype._classifyScore = function(count, openEnds) {
    if (count >= 5) return SCORE.FIVE;
    if (count === 4) {
      if (openEnds >= 2) return SCORE.OPEN_FOUR;
      if (openEnds === 1) return SCORE.CLOSED_FOUR;
      return 0;
    }
    if (count === 3) {
      if (openEnds >= 2) return SCORE.OPEN_THREE;
      if (openEnds === 1) return SCORE.CLOSED_THREE;
      return 0;
    }
    if (count === 2) {
      if (openEnds >= 2) return SCORE.OPEN_TWO;
      if (openEnds === 1) return SCORE.CLOSED_TWO;
      return 0;
    }
    if (count === 1) {
      if (openEnds >= 2) return SCORE.OPEN_ONE;
      return 0;
    }
    return 0;
  };

  // ─── Helpers ─────────────────────────────────────────────────

  GomokuAI.prototype._inBounds = function(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  };

  window.GomokuAI = GomokuAI;
})();
