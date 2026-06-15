/**
 * Gomoku (五子棋) — Canvas Renderer
 * Draws the board, grid lines, stones, star points, last-move marker,
 * and winning-line highlight. Handles pixel ↔ cell coordinate conversion.
 */
(function() {
  var C = window.GomokuConstants;
  var SIZE = C.BOARD_SIZE;
  var EMPTY = C.EMPTY;
  var BLACK = C.BLACK;
  var WHITE = C.WHITE;

  /** Light / dark palettes. */
  var LIGHT = {
    boardBg: '#DEB887',
    gridLine: '#333',
    starPoint: '#333',
    stoneBlackHi: '#666',
    stoneBlackLo: '#111',
    stoneWhiteHi: '#fff',
    stoneWhiteLo: '#bbb',
    lastMarker: '#e74c3c',
    winGlow: 'rgba(255, 215, 0, 0.55)'
  };
  var DARK = {
    boardBg: '#5D4037',
    gridLine: '#aaa',
    starPoint: '#aaa',
    stoneBlackHi: '#666',
    stoneBlackLo: '#111',
    stoneWhiteHi: '#fff',
    stoneWhiteLo: '#bbb',
    lastMarker: '#ff6b6b',
    winGlow: 'rgba(255, 215, 0, 0.45)'
  };

  /** Standard star-point positions on a 15×15 board. */
  var STAR_POINTS = [
    [3, 3], [3, 7], [3, 11],
    [7, 3], [7, 7], [7, 11],
    [11, 3], [11, 7], [11, 11]
  ];

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [opts]
   * @param {boolean} [opts.darkMode]
   * @param {Function} [opts.onCellClick] — called with {row, col}
   */
  function GomokuRenderer(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.darkMode = !!(opts && opts.darkMode);
    this.onCellClick = (opts && opts.onCellClick) || null;
    this.palette = this.darkMode ? DARK : LIGHT;

    // Sizing — computed in resize()
    this.cellSize = 0;
    this.margin = 0;
    this.logicalSize = 0;

    this._bindEvents();
    this.resize();
  }

  GomokuRenderer.prototype._bindEvents = function() {
    var self = this;
    this._clickHandler = function(e) {
      var cell = self.pixelToCell(e.clientX, e.clientY);
      if (cell && self.onCellClick) {
        self.onCellClick(cell.row, cell.col);
      }
    };
    this.canvas.addEventListener('click', this._clickHandler);

    this._resizeHandler = this._debounce(function() {
      self.resize();
    }, 150);
    window.addEventListener('resize', this._resizeHandler);
  };

  GomokuRenderer.prototype._debounce = function(fn, ms) {
    var timer = null;
    return function() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  };

  /** Recalculate canvas dimensions based on viewport width. */
  GomokuRenderer.prototype.resize = function() {
    var dpr = window.devicePixelRatio || 1;
    var containerWidth = this.canvas.parentElement
      ? this.canvas.parentElement.clientWidth - 32
      : Math.min(window.innerWidth - 32, 600);

    // Target: enough room for 15×15 grid with margins
    var maxLogical = Math.min(containerWidth, 640);
    this.cellSize = Math.floor(maxLogical / (SIZE + 1));       // +1 for margins
    if (this.cellSize < 16) this.cellSize = 16;                // lower bound for touch
    this.margin = this.cellSize;
    this.logicalSize = this.margin * 2 + this.cellSize * (SIZE - 1);

    this.canvas.width = Math.floor(this.logicalSize * dpr);
    this.canvas.height = Math.floor(this.logicalSize * dpr);
    this.canvas.style.width = this.logicalSize + 'px';
    this.canvas.style.height = this.logicalSize + 'px';
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  };

  /** Convert pixel (clientX, clientY) to board cell, or null. */
  GomokuRenderer.prototype.pixelToCell = function(clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    var scaleX = this.logicalSize / rect.width;
    var scaleY = this.logicalSize / rect.height;
    var x = (clientX - rect.left) * scaleX;
    var y = (clientY - rect.top) * scaleY;

    var col = Math.round((x - this.margin) / this.cellSize);
    var row = Math.round((y - this.margin) / this.cellSize);

    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return null;

    // Reject clicks too far from the intersection point
    var cx = this.margin + col * this.cellSize;
    var cy = this.margin + row * this.cellSize;
    var dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
    if (dist > this.cellSize * 0.45) return null;

    return { row: row, col: col };
  };

  /** Toggle theme and re-render. */
  GomokuRenderer.prototype.setDarkMode = function(on) {
    this.darkMode = !!on;
    this.palette = this.darkMode ? DARK : LIGHT;
  };

  /**
   * Full redraw of the entire board.
   * @param {GomokuBoard} board
   * @param {{row:number,col:number,player:number}|null} lastMove
   * @param {Array<[number,number]>|null} winningLine
   */
  GomokuRenderer.prototype.render = function(board, lastMove, winningLine) {
    var ctx = this.ctx;
    var P = this.palette;
    var size = this.logicalSize;

    // 1. Board background
    ctx.fillStyle = P.boardBg;
    ctx.fillRect(0, 0, size, size);

    // 2. Grid lines
    ctx.strokeStyle = P.gridLine;
    ctx.lineWidth = 1;
    for (var i = 0; i < SIZE; i++) {
      var pos = this.margin + i * this.cellSize;
      ctx.beginPath();
      ctx.moveTo(this.margin, pos);
      ctx.lineTo(this.margin + (SIZE - 1) * this.cellSize, pos);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pos, this.margin);
      ctx.lineTo(pos, this.margin + (SIZE - 1) * this.cellSize);
      ctx.stroke();
    }

    // 3. Star points
    ctx.fillStyle = P.starPoint;
    for (var s = 0; s < STAR_POINTS.length; s++) {
      var sp = STAR_POINTS[s];
      var sx = this.margin + sp[1] * this.cellSize;
      var sy = this.margin + sp[0] * this.cellSize;
      ctx.beginPath();
      ctx.arc(sx, sy, this.cellSize * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Build winning-line set for fast lookup
    var winSet = null;
    if (winningLine && winningLine.length > 0) {
      winSet = {};
      for (var w = 0; w < winningLine.length; w++) {
        winSet[winningLine[w][0] * SIZE + winningLine[w][1]] = true;
      }
    }

    // 4. Stones
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var cell = board.grid[r][c];
        if (cell === EMPTY) continue;

        var cx = this.margin + c * this.cellSize;
        var cy = this.margin + r * this.cellSize;
        var radius = this.cellSize * 0.44;

        // Win glow behind winning stones
        if (winSet && winSet[r * SIZE + c]) {
          ctx.beginPath();
          ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
          ctx.fillStyle = P.winGlow;
          ctx.fill();
        }

        // Stone gradient
        var grad = ctx.createRadialGradient(
          cx - radius * 0.3, cy - radius * 0.3, radius * 0.1,
          cx, cy, radius
        );
        if (cell === BLACK) {
          grad.addColorStop(0, P.stoneBlackHi);
          grad.addColorStop(1, P.stoneBlackLo);
        } else {
          grad.addColorStop(0, P.stoneWhiteHi);
          grad.addColorStop(1, P.stoneWhiteLo);
        }

        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Subtle outline for white stones
        if (cell === WHITE) {
          ctx.strokeStyle = '#999';
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    // 5. Last-move marker
    if (lastMove) {
      var mx = this.margin + lastMove.col * this.cellSize;
      var my = this.margin + lastMove.row * this.cellSize;
      ctx.beginPath();
      ctx.arc(mx, my, this.cellSize * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = P.lastMarker;
      ctx.fill();
    }
  };

  /** Clean up listeners. */
  GomokuRenderer.prototype.destroy = function() {
    this.canvas.removeEventListener('click', this._clickHandler);
    window.removeEventListener('resize', this._resizeHandler);
  };

  window.GomokuRenderer = GomokuRenderer;
})();
