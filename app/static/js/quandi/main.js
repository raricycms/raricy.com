// 全局变量
let gameEngine;
let inputHandler;
let selectedColor = '#E6194B';


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
    // 颜色选择
    document.querySelectorAll('.color-option').forEach(option => {
        option.addEventListener('click', function() {
            document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
            this.classList.add('selected');
            selectedColor = this.dataset.color;
        });
    });

    // 难度选择
    document.getElementById('difficultySelect').addEventListener('change', function() {
        gameEngine.setDifficulty(this.value);
    });

    // 游戏模式选择
    document.getElementById('gamemodeSelect').addEventListener('change', function() {
        gameEngine.setgamemode(this.value);
    });

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
    gameEngine.endGame();
    hideOverlays();
    if (gameEngine) {
        gameEngine.gameState = 'menu';
    }
}

function showRules() {
    showPage('rulesPage');
}

function startGame() {
    showPage('gamePage');
    
    // 设置玩家颜色
    gameEngine.setPlayerColor(1, selectedColor);
    
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
        gameEngine.restart();
    }
}

function hideOverlays() {
    document.querySelectorAll('.overlay').forEach(overlay => {
        overlay.classList.remove('active');
    });
}

// 键盘事件处理
document.addEventListener('keydown', function(e) {
    // ESC键和空格键的处理已经移到InputHandler.js中
    // 这里不再重复处理
});

// 防止页面滚动
document.addEventListener('keydown', function(e) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
    }
});

// 窗口大小改变时调整画布
window.addEventListener('resize', function() {
    // 可以在这里添加响应式调整逻辑
});
