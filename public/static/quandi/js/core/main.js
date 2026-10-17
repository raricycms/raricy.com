// 全局变量
let gameEngine;
let inputHandler;


// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    initGame();
    setupEventListeners();
});

function initGame() {
    const canvas = document.getElementById('gameCanvas');
    // 在初始化游戏引擎的地方添加
    gameEngine = new GameEngine();
    window.gameEngine = gameEngine; // 将游戏引擎实例暴露给全局
    gameEngine.init(canvas);
    inputHandler = new InputHandler(gameEngine);
}

function setupEventListeners() {
    // 双玩家颜色选择
    if (typeof colorManager !== 'undefined') {
        colorManager.setupColorSelection();
    }

    // 难度选择
    document.getElementById('difficultySelect').addEventListener('change', function() {
        gameEngine.setDifficulty(this.value);
    });

    // 游戏模式选择
    document.getElementById('gamemodeSelect').addEventListener('change', function() {
        gameEngine.setgamemode(this.value);
    });

    // 颜色选择页面按钮
    const colorSelectionBtn = document.getElementById('colorSelectionBtn');
    if (colorSelectionBtn) {
        colorSelectionBtn.addEventListener('click', showColorSelection);
    }

    const saveColorBtn = document.getElementById('saveColorBtn');
    if (saveColorBtn) {
        saveColorBtn.addEventListener('click', saveColorSelection);
    }

    const backFromColorBtn = document.getElementById('backFromColorBtn');
    if (backFromColorBtn) {
        backFromColorBtn.addEventListener('click', showMainMenu);
    }
}

// 页面导航函数
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(pageId).classList.add('active');
}

function showMainMenu() {
    showPage('mainMenu');
    if (networkManager) {
        if (networkManager.isConnected) networkManager.leaveRoom();
        networkManager.disconnect();
    }
    hideOverlays();
    if (gameEngine) {
        // 联机模式：直接判负并断开游戏
        if (gameEngine.networkMode === 'online' && gameEngine.gameState !== 'menu') {
            // 游戏中发送弃权消息给服务器
            if (networkManager && networkManager.isConnected &&
                gameEngine.gameState !== 'gameOver') {
                networkManager.forfeit();
            }
            // 清理联机资源
            if (networkManager) {
                networkManager.leaveRoom();
            }
            cleanupOnlineGame();
            // 停止旧引擎的渲染循环
            gameEngine.stopGameLoop = true;
        }
        gameEngine.gameState = 'menu';
        gameEngine.stopGameLoop = true;
        inputHandler?.clear();
    }
    // 重置联机状态
    currentRoom = null;
    isRoomHost = false;
    isReady = false;
}

// 清理联机游戏资源
function cleanupOnlineGame() {
    const canvas = document.getElementById('gameCanvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

function showRules() {
    showPage('rulesPage');
}

function showColorSelection() {
    showPage('colorSelectionPage');
    // 重新设置颜色选择器的事件监听器
    setTimeout(() => {
        if (typeof colorManager !== 'undefined') {
            colorManager.setupColorSelection();
        }
    }, 100);
}

function saveColorSelection() {
    showMainMenu();
}

function startGame() {
    showPage('gamePage');

    const canvas = document.getElementById('gameCanvas');

    if (gameEngine) gameEngine.stopGameLoop = true;
    inputHandler?.destroy();
    gameEngine = new GameEngine();
    window.gameEngine = gameEngine;
    gameEngine.init(canvas);
    inputHandler = new InputHandler(gameEngine);

    // 设置玩家颜色
    if (typeof colorManager !== 'undefined') {
        gameEngine.setPlayerColor(1, colorManager.getPlayerColor(1));
        gameEngine.setPlayerColor(2, colorManager.getPlayerColor(2));
    }

    // 重新设置难度和游戏模式，确保应用用户的选择
    gameEngine.setDifficulty(document.getElementById('difficultySelect').value);
    gameEngine.setgamemode(document.getElementById('gamemodeSelect').value);

    // 开始游戏
    gameEngine.start();
}

// 游戏控制函数
function pauseGame() {
    if (gameEngine && gameEngine.gameState === 'playing') {
        gameEngine.pause();
        document.getElementById('pauseMenu').classList.add('active');
    }
}

function resumeGame() {
    if (gameEngine && gameEngine.gameState === 'paused') {
        gameEngine.resume();
        hideOverlays();
    }
}

function restartGame() {
    hideOverlays();
    if (gameEngine) {
        // 联机模式下不支持直接重启
        if (gameEngine.networkMode === 'online') {
            // 游戏进行中点击重新开始视为弃权
            if (networkManager && networkManager.isConnected &&
                gameEngine.gameState !== 'menu' && gameEngine.gameState !== 'gameOver') {
                networkManager.forfeit();
            }
            gameEngine.stopGameLoop = true;
            gameEngine.gameState = 'menu';
            cleanupOnlineGame();
            showPage('roomWaiting');
            return;
        }
        startGame();
    }
}

function hideOverlays() {
    document.querySelectorAll('.overlay').forEach(overlay => {
        overlay.classList.remove('active');
    });
}

// 键盘事件处理
document.addEventListener('keydown', function(e) {
});

// 防止页面滚动（仅在非输入框时）
document.addEventListener('keydown', function(e) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        const tag = e.target.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
            e.preventDefault();
        }
    }
});

// 窗口大小改变时调整画布
window.addEventListener('resize', function() {
});

// ═══════════════════════════════════════════════════════════════
// 联机模式
// ═══════════════════════════════════════════════════════════════

let networkManager = null;
let currentRoom = null;
let isRoomHost = false;
let isReady = false;

function showOnlineLobby() {
    showPage('onlineLobby');
    if (!networkManager) { networkManager = new NetworkManager(); setupNetworkCallbacks(); }
    if (!networkManager.isConnected) networkManager.connect();
}

function setupNetworkCallbacks() {
    networkManager.on('connected', (data) => {
        document.getElementById('serverStatus').textContent = '已连接';
        document.getElementById('serverStatus').className = 'status-connected';
        siteNotice('');
        document.getElementById('lobbyPing').textContent = '...ms';
    });

    networkManager.on('disconnected', () => {
        document.getElementById('serverStatus').textContent = '已断开';
        document.getElementById('serverStatus').className = 'status-disconnected';
        if (gameEngine?.networkMode === 'online' && gameEngine.gameState !== 'menu') {
            gameEngine.stopGameLoop = true;
            gameEngine.gameState = 'menu';
            inputHandler?.clear();
            hideOverlays();
            showPage('onlineLobby');
        }
        currentRoom = null;
    });

    networkManager.on('roomUpdate', (room) => {
        currentRoom = room;
        isRoomHost = room.hostPlayerId === networkManager.playerId;
        updateRoomWaitingUI(room);
        if (gameEngine.gameState !== 'playing' && gameEngine.gameState !== 'countdown' && gameEngine.gameState !== 'gameOver') showPage('roomWaiting');
    });

    networkManager.on('roomLeft', () => { currentRoom = null; if (!document.getElementById('mainMenu').classList.contains('active')) showPage('onlineLobby'); });
    networkManager.on('playerJoin', (player) => {
        console.log('玩家加入:', player);
    });

    networkManager.on('playerLeave', (data) => {
        console.log('玩家离开:', data);
    });

    networkManager.on('gameStart', (data) => {
        startOnlineGameSession(data);
    });

    networkManager.on('gameState', (state) => {
        // State is buffered and consumed by GameEngine.updateOnline()
    });

    networkManager.on('gameEvent', (event) => {
        console.log('游戏事件:', event);
    });

    networkManager.on('gameEnd', (result) => {
        // 只有仍在联机游戏中才显示结束画面（防止已离开的玩家看到）
        if (!gameEngine || gameEngine.networkMode !== 'online' || gameEngine.stopGameLoop) return;
        showOnlineGameOver(result);
    });

    networkManager.on('error', (error) => {
        siteNotice(error.message);
        if (!currentRoom) showPage('onlineLobby');
    });
}

// 创建房间
function createOnlineRoom() {
    if (!networkManager || !networkManager.isConnected) {
        siteNotice('请先连接服务器');
        return;
    }


    const mode = document.getElementById('onlineModeSelect').value;
    const difficulty = document.getElementById('onlineDifficultySelect').value;
    const maxPlayers = parseInt(document.getElementById('onlineMaxPlayers').value);

    networkManager.createRoom({ mode, difficulty, maxPlayers, isPrivate: true });
    isReady = false;
    _updateReadyButtonUI();
    document.getElementById('readyBtn').style.display = 'inline-block';
    document.getElementById('startGameBtn').style.display = 'none';
}

// 加入房间
function joinOnlineRoom() {
    if (!networkManager || !networkManager.isConnected) {
        siteNotice('请先连接服务器');
        return;
    }


    const codeInput = document.getElementById('roomCodeInput');
    const code = codeInput.value.trim().toUpperCase();
    if (!code || code.length < 4) {
        siteNotice('请输入有效的房间码');
        return;
    }

    networkManager.joinRoom(code);
    isReady = false;
    _updateReadyButtonUI();
    document.getElementById('readyBtn').style.display = 'inline-block';
    document.getElementById('startGameBtn').style.display = 'none';
}

// 更新房间等待 UI
function updateRoomWaitingUI(room) {
    if (!room) return;

    document.getElementById('displayRoomCode').textContent = room.roomCode;
    document.getElementById('displayRoomMode').textContent =
        { explore: '探索', fight: '对战', infinite: '无限',
          survival: '生存', capture: '夺旗', daynight: '昼夜' }[room.gameConfig.mode] || room.gameConfig.mode;
    document.getElementById('displayRoomDifficulty').textContent =
        { slow: '慢速', medium: '中速', fast: '快速', ultra: '闪电' }[room.gameConfig.difficulty] || room.gameConfig.difficulty;
    document.getElementById('roomPing').textContent = networkManager.getPing() + 'ms';

    // 不把账号名拼进 HTML；身份文本始终由 textContent 写入。
    const slots = document.getElementById('playerSlots');
    slots.replaceChildren();
    for (let i = 0; i < 2; i++) {
        const player = room.players.find(p => p.slotIndex === i);
        const row = document.createElement('div');
        row.className = player ? 'player-slot occupied' : 'player-slot empty';
        const color = document.createElement('div');
        color.className = 'slot-color';
        color.style.backgroundColor = i === 0 ? '#E6194B' : '#0047AB';
        const name = document.createElement('span');
        name.textContent = player ? player.name + (player.isHost ? ' (房主)' : '') + (player.playerId === networkManager.playerId ? ' (你)' : '') : '等待中…';
        const state = document.createElement('span');
        state.className = 'slot-status';
        state.textContent = player?.isReady ? '已准备' : '等待中';
        row.append(color, name, state); slots.append(row);
    }

    // 从服务器状态同步本地就绪标记，确保按钮与实际状态一致
    const myPlayer = room.players.find(p => p.playerId === networkManager.playerId);
    if (myPlayer) {
        isReady = myPlayer.isReady;
        _updateReadyButtonUI();
    }

    // 显示/隐藏房主按钮
    if (isRoomHost) {
        document.getElementById('startGameBtn').style.display = 'inline-block';
    } else {
        document.getElementById('startGameBtn').style.display = 'none';
    }
}

// 准备/取消准备
function toggleReady() {
    if (!networkManager || !currentRoom) return;
    // 从服务器状态获取当前实际就绪状态
    const myPlayer = currentRoom.players.find(p => p.playerId === networkManager.playerId);
    if (!myPlayer) return;
    const newReady = !myPlayer.isReady;
    networkManager.setReady(newReady);
    // 乐观更新本地 isReady 并刷新 UI（服务器回 ROOM_UPDATE 后会再次同步）
    isReady = newReady;
    _updateReadyButtonUI();
}

// 根据当前 isReady 状态刷新按钮文案与样式
function _updateReadyButtonUI() {
    const btn = document.getElementById('readyBtn');
    if (!btn) return;
    btn.textContent = isReady ? '取消准备' : '准备';
    btn.className = isReady ? 'btn secondary' : 'btn primary';
}

// 房主开始游戏
function startOnlineGame() {
    if (!isRoomHost) return;
    networkManager.startGame();
}

// 离开房间
function leaveOnlineRoom() {
    networkManager.leaveRoom();
    currentRoom = null;
    isRoomHost = false;
    isReady = false;
    showPage('onlineLobby');
}

// 复制房间码
function copyRoomCode() {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('displayRoomCode'));
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    siteNotice('已选中房间码，按 Ctrl+C 复制。');
}

// 游戏开始 — 初始化联机游戏
function startOnlineGameSession(data) {
    showPage('gamePage');

    // 隐藏上一局的结束菜单
    const gameOverMenu = document.getElementById('gameOverMenu');
    if (gameOverMenu) gameOverMenu.classList.remove('active');

    // 停止旧游戏引擎的渲染循环
    if (gameEngine) {
        gameEngine.stopGameLoop = true;
        gameEngine.gameState = 'menu';
    }

    // 清理旧的 InputHandler（移除事件监听器）
    if (inputHandler) {
        inputHandler.destroy();
    }

    // 清空网络状态缓冲区，避免上一局残留状态污染新游戏
    if (networkManager) {
        networkManager.stateBuffer = [];
    }

    const canvas = document.getElementById('gameCanvas');

    // 清空主画布
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 重新初始化 GameEngine 为联机模式
    gameEngine = new GameEngine();
    window.gameEngine = gameEngine;

    gameEngine.setDifficulty(data.gameConfig.difficulty);

    gameEngine.initOnline(canvas, networkManager, networkManager.playerId);
    // 设置服务器权威的游戏模式（而非 initOnline 的默认值）
    gameEngine.gameMode = data.gameConfig.mode;
    gameEngine.setupOnlinePlayers(data);

    // 设置联机模式按键绑定，并同步全局引用
    gameEngine.inputHandler.setLocalBindings(Config.KEY_BINDINGS.player1);
    inputHandler = gameEngine.inputHandler;

    // 设置游戏状态为倒计时（服务器驱动，客户端静待同步）
    gameEngine.gameState = 'countdown';
    gameEngine.countdownActive = false;  // 联机模式不计时显示
    gameEngine.countdown = data.countdown || 3;
    gameEngine.difficulty = data.gameConfig.difficulty;
    gameEngine.maxGameTime = Config.DIFFICULTY_LEVELS[data.gameConfig.difficulty].maxTime;

    // 开始游戏循环
    gameEngine.currentTime = performance.now();
    gameEngine.lastUpdate = gameEngine.currentTime;
    gameEngine.accumulator = 0;
    gameEngine.frameCount = 0;
    gameEngine.gameTime = 0;
    gameEngine.territoryChanged = true;
    gameEngine.staticNeedsUpdate = true;
    gameEngine.dynamicNeedsUpdate = true;

    gameEngine.gameLoop();
}

// 联机游戏结束
function showOnlineGameOver(result) {
    const gameOverMenu = document.getElementById('gameOverMenu');
    const gameOverTitle = document.getElementById('gameOverTitle');
    const gameOverMessage = document.getElementById('gameOverMessage');

    // 停止游戏循环
    if (gameEngine) {
        gameEngine.stopGameLoop = true;
    }

    // 最后一次更新 UI（在循环停止后显示正确的生命/分数）
    if (gameEngine && gameEngine.uiUpdater) {
        gameEngine.uiUpdater.updateUI();
    }

    if (result.winner.isDraw) {
        gameOverTitle.textContent = '平局!';
    } else if (result.winner.id === networkManager.playerId) {
        gameOverTitle.textContent = '你赢了! 🏆';
    } else {
        gameOverTitle.textContent = '你输了';
    }

    // 从服务器结果同步最终生命值到UI
    const scores = result.scores || [];
    scores.forEach(s => {
        const isMe = s.id === networkManager.playerId;
        const playerSlot = isMe ? 1 : 2;
        const livesEl = document.getElementById(`player${playerSlot}Lives`);
        const livesCountEl = document.getElementById(`player${playerSlot}LivesCount`);
        if (livesEl && livesCountEl) {
            livesCountEl.textContent = s.lives;
            if (s.lives <= 1) {
                livesCountEl.className = 'lives-count critical';
            } else if (s.lives <= 2) {
                livesCountEl.className = 'lives-count warning';
            } else {
                livesCountEl.className = 'lives-count normal';
            }
        }
    });

    let msg = '最终分数:\n';
    scores.forEach(s => {
        const isMe = s.id === networkManager.playerId;
        const forfeitText = s.forfeit ? '(弃权)' : '';
        msg += `${isMe ? '你' : '对手'}: ${Math.round(s.score)}% ${s.isAlive ? '(存活)' : '(死亡)'}${forfeitText}\n`;
    });
    gameOverMessage.textContent = msg;

    gameOverMenu.classList.add('active');
    if (gameEngine) {
        gameEngine.gameState = 'gameOver';
    }
}
