(function () {
    // ---- Constants ------------------------------------------------------------

    const SIZE = 4;
    const WIN_VALUE = 2048;

    // Tile colors — warm palette inspired by the original, but using softer tones
    const TILE_STYLES = {
        2:    { bg: '#eee4da', fg: '#776e65' },
        4:    { bg: '#ede0c8', fg: '#776e65' },
        8:    { bg: '#f2b179', fg: '#f9f6f2' },
        16:   { bg: '#f59563', fg: '#f9f6f2' },
        32:   { bg: '#f67c5f', fg: '#f9f6f2' },
        64:   { bg: '#f65e3b', fg: '#f9f6f2' },
        128:  { bg: '#edcf72', fg: '#f9f6f2' },
        256:  { bg: '#edcc61', fg: '#f9f6f2' },
        512:  { bg: '#edc850', fg: '#f9f6f2' },
        1024: { bg: '#edc53f', fg: '#f9f6f2' },
        2048: { bg: '#edc22e', fg: '#f9f6f2' },
    };

    // Super-tile fallback for > 2048
    const SUPER_TILE = { bg: '#3c3a32', fg: '#f9f6f2' };

    function tileStyle(value) {
        return TILE_STYLES[value] || SUPER_TILE;
    }

    // ---- DOM ------------------------------------------------------------------

    const boardEl = document.getElementById('board');
    const boardWrap = document.getElementById('board-wrap');
    const scoreEl = document.getElementById('score');
    const bestEl = document.getElementById('best');
    const btnNew = document.getElementById('btn-new');
    const btnUndo = document.getElementById('btn-undo');

    // ---- State ----------------------------------------------------------------

    let grid = [];        // grid[row][col] = value (0 means empty)
    let tileIds = [];     // tileIds[row][col] = unique id (0 means empty)
    let nextTileId = 1;   // auto-increment tile ID
    let mergedIds = null;   // Set of tile IDs that resulted from a merge this move
    let consumedMap = null; // {consumedId: survivedId} — tiles eaten in merges
    let score = 0;
    let best = 0;
    let over = false;
    let won = false;
    let keepPlaying = false;
    let history = [];     // [{grid, tileIds, score}] for undo
    let tileElements = {}; // id -> {el, r, c}  persistent tile DOM elements
    let cellElements = []; // [r][c] -> cell DOM element (created once)

    // ---- localStorage ---------------------------------------------------------

    const LS_KEY = 'game2048_best';

    function loadBest() {
        try {
            const v = parseInt(localStorage.getItem(LS_KEY), 10);
            return (v > 0) ? v : 0;
        } catch (e) {
            return 0;
        }
    }

    function saveBest(v) {
        try {
            localStorage.setItem(LS_KEY, v);
        } catch (e) { /* ignore */ }
    }

    // ---- Grid helpers ---------------------------------------------------------

    function emptyGrid() {
        const g = [];
        for (let r = 0; r < SIZE; r++) {
            g[r] = new Array(SIZE).fill(0);
        }
        return g;
    }

    function emptyIdGrid() {
        const g = [];
        for (let r = 0; r < SIZE; r++) {
            g[r] = new Array(SIZE).fill(0);
        }
        return g;
    }

    function cloneGrid(g) {
        return g.map(row => row.slice());
    }

    // ---- Persistent board & tile elements ---------------------------------------

    function initBoard() {
        boardEl.innerHTML = '';
        for (var r = 0; r < SIZE; r++) {
            cellElements[r] = [];
            for (var c = 0; c < SIZE; c++) {
                var cell = document.createElement('div');
                cell.className = 'game-2048-cell';
                cellElements[r][c] = cell;
                boardEl.appendChild(cell);
            }
        }
    }

    // ---- Tile element factory (two-layer: outer=position, inner=face) -----------

    function createTileElement(value, id) {
        var outer = document.createElement('div');
        outer.className = 'game-2048-tile';
        outer.dataset.tileId = id;

        var face = document.createElement('div');
        face.className = 'game-2048-tile__face';
        var st = tileStyle(value);
        face.textContent = value;
        face.style.background = st.bg;
        face.style.color = st.fg;
        _setTileFontSize(face, value);

        outer.appendChild(face);
        // Stash reference to the face so we can update/add classes later
        outer._face = face;
        return outer;
    }

    function updateTileContent(outer, value) {
        var face = outer._face;
        var st = tileStyle(value);
        face.textContent = value;
        face.style.background = st.bg;
        face.style.color = st.fg;
        _setTileFontSize(face, value);
    }

    function _setTileFontSize(el, value) {
        var len = String(value).length;
        if (len <= 2)        el.style.fontSize = '2rem';
        else if (len === 3)  el.style.fontSize = '1.6rem';
        else if (len === 4)  el.style.fontSize = '1.2rem';
        else                 el.style.fontSize = '0.95rem';
    }

    // ---- Cell-position helpers --------------------------------------------------

    // Read every cell's rect relative to the board (handles resize / mobile gap).
    function getCellPositions() {
        var boardRect = boardEl.getBoundingClientRect();
        var pos = [];
        for (var r = 0; r < SIZE; r++) {
            pos[r] = [];
            for (var c = 0; c < SIZE; c++) {
                var cr = cellElements[r][c].getBoundingClientRect();
                pos[r][c] = {
                    x: cr.left - boardRect.left,
                    y: cr.top  - boardRect.top,
                    w: cr.width,
                    h: cr.height
                };
            }
        }
        return pos;
    }

    // Position a tile outer-div at a specific cell.
    function placeTile(outer, cellPos) {
        outer.style.width  = cellPos.w + 'px';
        outer.style.height = cellPos.h + 'px';
        outer.style.transform = 'translate(' + cellPos.x + 'px, ' + cellPos.y + 'px)';
    }

    function availableCells(g) {
        const cells = [];
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (g[r][c] === 0) cells.push({ r, c });
            }
        }
        return cells;
    }

    function addRandomTile(g, idGrid) {
        const cells = availableCells(g);
        if (cells.length === 0) return false;
        const { r, c } = cells[Math.floor(Math.random() * cells.length)];
        g[r][c] = Math.random() < 0.9 ? 2 : 4;
        idGrid[r][c] = nextTileId++;
        return true;
    }

    // ---- Slide logic ----------------------------------------------------------

    // Slide a single line (values + ids) to the left.
    // Returns { values, ids, score, moved, merged, consumed }
    //   merged:   [survivingId, ...] — tiles that absorbed another
    //   consumed: [{consumedId, survivedId}, ...] — tiles eaten during merge
    function slideLineWithIds(values, ids) {
        // Remove zeros, keeping values and ids in sync
        let arr = [];
        let idArr = [];
        for (let i = 0; i < values.length; i++) {
            if (values[i] !== 0) {
                arr.push(values[i]);
                idArr.push(ids[i]);
            }
        }

        let scoreGain = 0;
        let moved = false;
        const merged = [];
        const consumed = [];

        // Merge
        for (let i = 0; i < arr.length - 1; i++) {
            if (arr[i] === arr[i + 1]) {
                arr[i] *= 2;
                scoreGain += arr[i];
                merged.push(idArr[i]);                        // surviving ID
                consumed.push({ consumedId: idArr[i + 1], survivedId: idArr[i] });
                arr[i + 1] = 0;
                idArr[i + 1] = 0;
                i++;
            }
        }

        // Remove zeros again after merge (sync)
        const newArr = [];
        const newIdArr = [];
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] !== 0) {
                newArr.push(arr[i]);
                newIdArr.push(idArr[i]);
            }
        }

        // Pad to SIZE
        while (newArr.length < SIZE) {
            newArr.push(0);
            newIdArr.push(0);
        }

        // Check if line changed
        for (let i = 0; i < SIZE; i++) {
            if (newArr[i] !== values[i]) {
                moved = true;
                break;
            }
        }

        return { values: newArr, ids: newIdArr, score: scoreGain, moved, merged, consumed };
    }

    // Slide the entire grid in a given direction
    function slide(g, idGrid, direction) {
        let totalScore = 0;
        let anyMoved = false;
        const newGrid = emptyGrid();
        const newIdGrid = emptyIdGrid();
        const allMerged = [];
        const allConsumed = [];

        function slideRow(r, reverse) {
            const row = g[r].slice();
            const idRow = idGrid[r].slice();
            if (reverse) { row.reverse(); idRow.reverse(); }
            const result = slideLineWithIds(row, idRow);
            if (reverse) { result.values.reverse(); result.ids.reverse(); }
            newGrid[r] = result.values;
            newIdGrid[r] = result.ids;
            totalScore += result.score;
            anyMoved = anyMoved || result.moved;
            allMerged.push(...result.merged);
            allConsumed.push(...result.consumed);
        }

        function slideCol(c, reverse) {
            const col = [];
            const idCol = [];
            for (let r = 0; r < SIZE; r++) { col.push(g[r][c]); idCol.push(idGrid[r][c]); }
            if (reverse) { col.reverse(); idCol.reverse(); }
            const result = slideLineWithIds(col, idCol);
            if (reverse) { result.values.reverse(); result.ids.reverse(); }
            for (let r = 0; r < SIZE; r++) { newGrid[r][c] = result.values[r]; newIdGrid[r][c] = result.ids[r]; }
            totalScore += result.score;
            anyMoved = anyMoved || result.moved;
            allMerged.push(...result.merged);
            allConsumed.push(...result.consumed);
        }

        if (direction === 'left') {
            for (let r = 0; r < SIZE; r++) slideRow(r, false);
        } else if (direction === 'right') {
            for (let r = 0; r < SIZE; r++) slideRow(r, true);
        } else if (direction === 'up') {
            for (let c = 0; c < SIZE; c++) slideCol(c, false);
        } else if (direction === 'down') {
            for (let c = 0; c < SIZE; c++) slideCol(c, true);
        }

        return { grid: newGrid, idGrid: newIdGrid, score: totalScore, moved: anyMoved, merged: allMerged, consumed: allConsumed };
    }

    // ---- Game-over check ------------------------------------------------------

    function canMove(g) {
        // Any empty cell?
        if (availableCells(g).length > 0) return true;

        // Any adjacent equal tiles (horizontal) ?
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE - 1; c++) {
                if (g[r][c] === g[r][c + 1]) return true;
            }
        }

        // Any adjacent equal tiles (vertical) ?
        for (let r = 0; r < SIZE - 1; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (g[r][c] === g[r + 1][c]) return true;
            }
        }

        return false;
    }

    function hasWon(g) {
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (g[r][c] >= WIN_VALUE) return true;
            }
        }
        return false;
    }

    // ---- Save state for undo --------------------------------------------------

    function pushHistory() {
        history.push({ grid: cloneGrid(grid), tileIds: cloneGrid(tileIds), score: score });
        // Keep only last 5 states
        if (history.length > 5) history.shift();
    }

    // ---- Main move handler ----------------------------------------------------

    function move(direction) {
        if (over && !keepPlaying) return;
        if (over && keepPlaying && !canMove(grid)) return;

        // Save state before move
        pushHistory();

        const result = slide(grid, tileIds, direction);
        if (!result.moved) {
            // Revert history push — move didn't change anything
            history.pop();
            return;
        }

        grid = result.grid;
        tileIds = result.idGrid;
        mergedIds = new Set(result.merged);
        // Map consumed tile ID → surviving tile ID (so we can animate them sliding
        // to the merge position before removal)
        consumedMap = {};
        result.consumed.forEach(function (c) {
            consumedMap[c.consumedId] = c.survivedId;
        });
        score += result.score;

        if (score > best) {
            best = score;
            saveBest(best);
        }

        // Spawn new tile
        addRandomTile(grid, tileIds);

        // Check win
        if (!won && !keepPlaying && hasWon(grid)) {
            won = true;
        }

        // Check game over
        if (!canMove(grid)) {
            over = true;
        }

        updateBestEl();
        syncTiles();
    }

    // ---- Sync tiles (direct positioning — no FLIP, no innerHTML) ----------------

    function syncTiles() {
        // Remove overlay if present
        var ov = boardWrap.querySelector('.game-2048-overlay');
        if (ov) ov.remove();

        // Get current cell rects (handles resize / mobile gap changes)
        var cellPos = getCellPositions();

        // ---- Sync tile elements to match grid state ------------------------------
        var seenIds = {};
        var newEls = [];

        for (var r = 0; r < SIZE; r++) {
            for (var c = 0; c < SIZE; c++) {
                var value = grid[r][c];
                if (value === 0) continue;
                var id = tileIds[r][c];
                seenIds[id] = true;

                var entry = tileElements[id];
                if (entry) {
                    // Existing tile — check movement BEFORE updating r,c
                    var cellChanged = (entry.r !== r || entry.c !== c);
                    // Update content + move to target cell
                    updateTileContent(entry.el, value);
                    // Directly set target position → CSS transition does the slide.
                    // If a previous transition was in-flight the browser smoothly
                    // re-targets — no snap, no flicker.
                    placeTile(entry.el, cellPos[r][c]);
                    entry.r = r;
                    entry.c = c;

                    if (mergedIds && mergedIds.has(id)) {
                        entry._mergeMoved = cellChanged;
                    }
                } else {
                    // Brand-new tile — create + position + appear animation
                    var el = createTileElement(value, id);
                    placeTile(el, cellPos[r][c]);
                    boardEl.appendChild(el);
                    tileElements[id] = { el: el, r: r, c: c };
                    newEls.push(el);
                }
            }
        }

        // ---- Animate consumed tiles to merge position, then remove ---------------
        if (consumedMap) {
            Object.keys(tileElements).forEach(function (id) {
                if (!seenIds[id] && consumedMap[id]) {
                    var survivedId = consumedMap[id];
                    var survivedEntry = tileElements[survivedId];
                    if (survivedEntry) {
                        var entry = tileElements[id];
                        // Slide consumed tile to the same cell as the surviving tile
                        placeTile(entry.el, cellPos[survivedEntry.r][survivedEntry.c]);
                        // Fade out in parallel with the slide
                        entry.el.style.opacity = '0';
                        entry.el.style.transition = 'transform 120ms ease, opacity 100ms ease';
                        // Clean up after animation
                        var el = entry.el;
                        var removeId = id;
                        setTimeout(function () {
                            el.remove();
                            delete tileElements[removeId];
                        }, 150);
                        seenIds[id] = true; // skip the removal loop below
                    }
                }
            });
        }

        // ---- Remove any remaining stale tiles ------------------------------------
        Object.keys(tileElements).forEach(function (id) {
            if (!seenIds[id]) {
                tileElements[id].el.remove();
                delete tileElements[id];
            }
        });

        consumedMap = null;

        // // ---- Merge pop (disabled) ------------------------------------------------
        // if (mergedIds) {
        //     mergedIds.forEach(function (id) {
        //         var entry = tileElements[id];
        //         if (entry) {
        //             var face = entry.el._face;
        //             face.classList.add('game-2048-tile__face--merged');
        //             if (!entry._mergeMoved) {
        //                 face.style.animationDelay = '0s';
        //             }
        //             entry._mergeMoved = undefined;
        //         }
        //     });
        //     mergedIds = null;
        // }
        mergedIds = null;

        // ---- New-tile appear (CSS animation-delay starts after slide) ------------
        newEls.forEach(function (el) {
            el._face.classList.add('game-2048-tile__face--new');
        });

        // Update score
        scoreEl.textContent = score;

        // Show overlay if won or over
        if (won && !keepPlaying) {
            showOverlay('你赢了！', true);
        } else if (over) {
            showOverlay('游戏结束', false);
        }
    }

    function showOverlay(text, isWin) {
        const overlay = document.createElement('div');
        overlay.className = 'game-2048-overlay';

        const textEl = document.createElement('div');
        textEl.className = 'game-2048-overlay__text';
        textEl.textContent = text;
        overlay.appendChild(textEl);

        const btn = document.createElement('button');
        btn.className = 'game-2048-overlay__btn';
        btn.type = 'button';

        if (isWin) {
            btn.textContent = '继续游戏';
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                keepPlaying = true;
                won = false;
                syncTiles();
            });
            overlay.appendChild(btn);
        } else {
            btn.textContent = '再来一局';
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                newGame();
            });
            overlay.appendChild(btn);
        }

        boardWrap.appendChild(overlay);
    }

    function updateBestEl() {
        bestEl.textContent = best;
    }

    // ---- New game -------------------------------------------------------------

    function newGame() {
        // Remove all existing tile DOM elements
        Object.keys(tileElements).forEach(function (id) {
            tileElements[id].el.remove();
        });
        tileElements = {};

        grid = emptyGrid();
        tileIds = emptyIdGrid();
        nextTileId = 1;
        mergedIds = null;
        consumedMap = null;
        addRandomTile(grid, tileIds);
        addRandomTile(grid, tileIds);
        score = 0;
        over = false;
        won = false;
        keepPlaying = false;
        history = [];
        updateBestEl();
        syncTiles();
    }

    function undo() {
        if (history.length === 0) return;

        const prev = history.pop();
        grid = prev.grid;
        tileIds = prev.tileIds;
        score = prev.score;
        mergedIds = null; // no animations on undo
        consumedMap = null;
        over = false;
        won = hasWon(grid);
        // If already won before undo, keep playing flag
        if (won && !canMove(grid)) {
            over = true;
        }
        updateBestEl();
        syncTiles();
    }

    // ---- Input handlers -------------------------------------------------------

    function handleKey(e) {
        const keyMap = {
            'ArrowLeft': 'left',
            'ArrowRight': 'right',
            'ArrowUp': 'up',
            'ArrowDown': 'down',
            'a': 'left',
            'd': 'right',
            'w': 'up',
            's': 'down',
        };

        const dir = keyMap[e.key];
        if (dir) {
            e.preventDefault();
            move(dir);
        }

        // Ctrl+Z for undo
        if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            undo();
        }
    }

    // ---- Touch / swipe support ------------------------------------------------

    let touchStartX = 0;
    let touchStartY = 0;
    const SWIPE_THRESHOLD = 30;

    function handleTouchStart(e) {
        if (e.touches.length !== 1) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }

    function handleTouchEnd(e) {
        if (e.changedTouches.length !== 1) return;
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        if (Math.max(absDx, absDy) < SWIPE_THRESHOLD) return;

        if (absDx > absDy) {
            move(dx > 0 ? 'right' : 'left');
        } else {
            move(dy > 0 ? 'down' : 'up');
        }
    }

    // ---- Init -----------------------------------------------------------------

    best = loadBest();
    window.addEventListener('keydown', handleKey);
    boardWrap.addEventListener('touchstart', handleTouchStart, { passive: true });
    boardWrap.addEventListener('touchend', handleTouchEnd, { passive: true });
    btnNew.addEventListener('click', newGame);
    btnUndo.addEventListener('click', undo);

    initBoard();
    updateBestEl();
    newGame();
})();
