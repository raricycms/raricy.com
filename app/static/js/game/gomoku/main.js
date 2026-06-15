/**
 * Gomoku (五子棋) — Game Controller
 * Entry point that wires Board, AI, Renderer, and DOM elements together.
 * Exposes window.GomokuGame.
 */
(function() {
  var C = window.GomokuConstants;
  var GomokuBoard = window.GomokuBoard;
  var GomokuAI = window.GomokuAI;
  var GomokuRenderer = window.GomokuRenderer;
  var BLACK = C.BLACK;
  var WHITE = C.WHITE;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts
   * @param {HTMLElement} opts.statusEl
   * @param {HTMLElement} opts.newGameBtn
   * @param {HTMLElement} opts.undoBtn
   * @param {NodeList}   opts.modeRadios — radio inputs for PvP / AI
   */
  function GomokuGame(canvas, opts) {
    this.canvas = canvas;
    this.statusEl = opts.statusEl;
    this.newGameBtn = opts.newGameBtn;
    this.undoBtn = opts.undoBtn;
    this.modeRadios = opts.modeRadios;

    this.board = new GomokuBoard();
    this.ai = null;
    this.renderer = null;
    this.currentPlayer = BLACK;
    this.gameOver = false;
    this.winningLine = null;
    this.lastMove = null;
    this.mode = 'pvp';
    this.isAiThinking = false;

    this._initRenderer();
    this._bindEvents();
    this.initGame();
  }

  // ─── Initialisation ──────────────────────────────────────────

  GomokuGame.prototype._initRenderer = function() {
    var self = this;
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.renderer = new GomokuRenderer(this.canvas, {
      darkMode: isDark,
      onCellClick: function(row, col) {
        self.handleCellClick(row, col);
      }
    });
  };

  GomokuGame.prototype._bindEvents = function() {
    var self = this;

    this.newGameBtn.addEventListener('click', function() { self.initGame(); });
    this.undoBtn.addEventListener('click', function() { self.undoMove(); });

    // Mode radio buttons
    for (var i = 0; i < this.modeRadios.length; i++) {
      this.modeRadios[i].addEventListener('change', function() {
        if (this.checked) {
          self.mode = this.value;
          self.initGame();
        }
      });
    }

    // Dark-mode toggle observer
    var themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', function() {
        setTimeout(function() {
          var dark = document.documentElement.getAttribute('data-theme') === 'dark';
          self.renderer.setDarkMode(dark);
          self._render();
        }, 50);
      });
    }
  };

  // ─── Game lifecycle ──────────────────────────────────────────

  GomokuGame.prototype.initGame = function() {
    this.board.reset();
    this.currentPlayer = BLACK;
    this.gameOver = false;
    this.winningLine = null;
    this.lastMove = null;
    this.isAiThinking = false;

    // Read current mode from radio
    for (var i = 0; i < this.modeRadios.length; i++) {
      if (this.modeRadios[i].checked) {
        this.mode = this.modeRadios[i].value;
      }
    }

    this._updateAI();

    this.undoBtn.disabled = true;
    this._render();
  };

  GomokuGame.prototype._updateAI = function() {
    if (this.mode === 'ai') {
      this.ai = new GomokuAI(this.board, WHITE);
    } else {
      this.ai = null;
    }
  };

  // ─── Input ───────────────────────────────────────────────────

  /**
   * Handle a cell click from the renderer.
   */
  GomokuGame.prototype.handleCellClick = function(row, col) {
    if (this.gameOver) return;
    if (this.isAiThinking) return;
    if (!this.board.isValidMove(row, col)) return;

    // In AI mode only the human (BLACK) can click
    if (this.mode === 'ai' && this.currentPlayer !== BLACK) return;

    this._placeAndCheck(row, col, this.currentPlayer);

    if (!this.gameOver) {
      this._switchTurn();
      this._maybeAiMove();
    }
  };

  /**
   * Place a stone, check win/draw, update lastMove.
   */
  GomokuGame.prototype._placeAndCheck = function(row, col, player) {
    this.board.placeStone(row, col, player);
    this.lastMove = { row: row, col: col, player: player };

    var wr = this.board.checkWinAt(row, col, player);
    if (wr.won) {
      this.gameOver = true;
      this.winningLine = wr.line;
    } else if (this.board.isFull()) {
      this.gameOver = true;
      this.winningLine = null;
    }

    this._render();
  };

  GomokuGame.prototype._switchTurn = function() {
    this.currentPlayer = this.currentPlayer === BLACK ? WHITE : BLACK;
  };

  GomokuGame.prototype._maybeAiMove = function() {
    if (this.mode !== 'ai') return;
    if (this.gameOver) return;
    if (this.currentPlayer !== WHITE) return;

    var self = this;
    this.isAiThinking = true;
    this._updateStatus();

    setTimeout(function() {
      if (!self.ai) return;

      var move = self.ai.getBestMove();
      self._placeAndCheck(move.row, move.col, WHITE);

      self.isAiThinking = false;

      if (!self.gameOver) {
        self._switchTurn();
      }
      self._render();
    }, 30);
  };

  // ─── Undo ────────────────────────────────────────────────────

  GomokuGame.prototype.undoMove = function() {
    if (this.isAiThinking) return;
    if (this.board.getHistory().length === 0) return;

    if (this.mode === 'ai') {
      // Undo two moves: AI's last + human's last
      this.board.undo();  // AI move
      this.board.undo();  // human move
      // currentPlayer stays BLACK (human always plays black in AI mode)
      this.currentPlayer = BLACK;
    } else {
      // Undo one move in PvP
      this.board.undo();
      this._switchTurn();
    }

    this.gameOver = false;
    this.winningLine = null;
    this.lastMove = this.board.getLastMove();
    this.undoBtn.disabled = this.board.getHistory().length === 0;
    this._render();
  };

  // ─── Rendering ───────────────────────────────────────────────

  GomokuGame.prototype._render = function() {
    this.renderer.render(this.board, this.lastMove, this.winningLine);
    this._updateStatus();
    this.undoBtn.disabled = this.board.getHistory().length === 0 || this.isAiThinking;
  };

  GomokuGame.prototype._updateStatus = function() {
    if (this.isAiThinking) {
      this.statusEl.textContent = 'AI 思考中…';
      this.statusEl.style.color = '';
      return;
    }

    if (this.gameOver) {
      if (this.winningLine && this.winningLine.length > 0 && this.lastMove) {
        var winner = this.lastMove.player === BLACK ? '黑方' : '白方';
        this.statusEl.textContent = winner + '获胜！';
        this.statusEl.style.color = this.lastMove.player === BLACK ? '#333' : '#888';
      } else {
        this.statusEl.textContent = '平局！';
        this.statusEl.style.color = '';
      }
      return;
    }

    var turn = this.currentPlayer === BLACK ? '黑方' : '白方';
    this.statusEl.textContent = turn + '落子';
    this.statusEl.style.color = '';
  };

  // ─── Cleanup ─────────────────────────────────────────────────

  GomokuGame.prototype.destroy = function() {
    if (this.renderer) this.renderer.destroy();
  };

  window.GomokuGame = GomokuGame;
})();
