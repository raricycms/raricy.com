/**
 * 星空战机游戏主程序
 * 初始化所有管理器并启动游戏
 */

// 全局管理器实例
let gameConfig;
let gameState;
let playerManager;
let weaponManager;
let enemyManager;
let bossManager;
let powerupManager;
let specialEffectsManager;
let collisionManager;
let uiManager;
let gameController;
let renderer;

/**
 * 初始化游戏
 */
function initGame() {
    console.log('正在初始化星空战机游戏...');
    
    try {
        // 创建所有管理器实例
        gameConfig = new GameConfig();
        gameState = new GameState();
        renderer = new Renderer();
        playerManager = new PlayerManager(renderer.canvas);
        weaponManager = new WeaponManager();
        enemyManager = new EnemyManager();
        bossManager = new BossManager();
        powerupManager = new PowerupManager();
        specialEffectsManager = new SpecialEffectsManager();
        collisionManager = new CollisionManager();
        uiManager = new UIManager();
        gameController = new GameController();
        
        // 创建星空背景
        createStars();
      
        console.log('星空战机游戏初始化完成！');
        console.log('管理器状态：');
        console.log('- 游戏配置管理器：已加载');
        console.log('- 游戏状态管理器：已初始化');
        console.log('- 渲染器：已就绪');
        console.log('- 玩家管理器：已绑定控制');
        console.log('- 武器管理器：已就绪');
        console.log('- 敌机管理器：已就绪');
        console.log('- Boss管理器：已就绪');
        console.log('- 道具管理器：已就绪');
        console.log('- 特效管理器：已就绪');
        console.log('- 碰撞管理器：已就绪');
        console.log('- UI管理器：已加载历史记录');
        console.log('- 游戏控制器：已就绪');
        
    } catch (error) {
        console.error('游戏初始化失败：', error);
        alert('游戏初始化失败，请刷新页面重试。');
    }
}

/**
 * 创建星空背景
 */
function createStars() {
    const starsContainer = document.getElementById('stars');
    if (!starsContainer) {
        console.warn('未找到星空容器元素');
        return;
    }
    
    starsContainer.innerHTML = '';
    
    // 创建100颗随机星星
    for (let i = 0; i < 100; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        star.style.left = Math.random() * 100 + '%';
        star.style.top = Math.random() * 100 + '%';
        star.style.width = Math.random() * 2 + 1 + 'px';
        star.style.height = star.style.width;
        star.style.animationDelay = Math.random() * 2 + 's';
        starsContainer.appendChild(star);
    }
    
    console.log('星空背景已创建：100颗星星');
}

/**
 * 检查浏览器兼容性
 */
function checkBrowserCompatibility() {
    // 检查Canvas支持
    const canvas = document.createElement('canvas');
    if (!canvas.getContext) {
        alert('您的浏览器不支持Canvas，无法运行游戏。请使用现代浏览器。');
        return false;
    }
    
    // 检查localStorage支持
    try {
        localStorage.setItem('test', 'test');
        localStorage.removeItem('test');
    } catch (e) {
        console.warn('localStorage不可用，无法保存游戏记录');
    }
    
    // 检查requestAnimationFrame支持
    if (!window.requestAnimationFrame) {
        window.requestAnimationFrame = window.webkitRequestAnimationFrame || 
                                     window.mozRequestAnimationFrame || 
                                     window.oRequestAnimationFrame || 
                                     window.msRequestAnimationFrame || 
                                     function(callback) {
                                         window.setTimeout(callback, 1000 / 60);
                                     };
    }
    
    return true;
}

/**
 * 处理页面加载错误
 */
function handleLoadError(error) {
    console.error('页面加载错误：', error);
    
    // 显示错误信息
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(255, 0, 0, 0.9);
        color: white;
        padding: 20px;
        border-radius: 10px;
        text-align: center;
        z-index: 9999;
        font-family: Arial, sans-serif;
    `;
    errorDiv.innerHTML = `
        <h3>游戏加载失败</h3>
        <p>请检查网络连接并刷新页面重试</p>
        <button onclick="location.reload()" style="
            background: white;
            color: red;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            margin-top: 10px;
        ">刷新页面</button>
    `;
    document.body.appendChild(errorDiv);
}

/**
 * 页面加载完成事件处理
 */
window.addEventListener('load', function() {
    console.log('页面加载完成，开始初始化游戏...');
    
    // 检查浏览器兼容性
    if (!checkBrowserCompatibility()) {
        return;
    }
    
    // 延迟初始化，确保所有资源加载完成
    setTimeout(() => {
        try {
            initGame();
        } catch (error) {
            handleLoadError(error);
        }
    }, 100);
});

/**
 * 页面卸载前的清理工作
 */
window.addEventListener('beforeunload', function() {
    console.log('页面即将卸载，执行清理工作...');
    
    // 如果游戏正在运行，保存当前状态
    if (gameState && gameState.gameRunning) {
        console.log('游戏正在运行，保存状态...');
        // 这里可以添加保存游戏状态的逻辑
    }
});

/**
 * 处理页面可见性变化（用户切换标签页时暂停游戏）
 */
document.addEventListener('visibilitychange', function() {
    if (gameState && gameState.gameRunning && !gameState.gamePaused) {
        if (document.hidden) {
            // 页面隐藏时自动暂停
            console.log('页面隐藏，自动暂停游戏');
            gameController.togglePause();
        }
    }
});

/**
 * 全局错误处理
 */
window.addEventListener('error', function(event) {
    console.error('全局错误：', event.error);
    
    // 如果是游戏运行时的错误，尝试恢复
    if (gameState && gameState.gameRunning) {
        console.log('尝试恢复游戏状态...');
        try {
            gameController.togglePause();
        } catch (e) {
            console.error('无法恢复游戏状态：', e);
        }
    }
});

/**
 * 调试模式（开发时使用）
 */
if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    console.log('检测到本地开发环境，启用调试模式');
    
    // 添加调试信息到全局作用域
    window.gameDebug = {
        getGameState: () => gameState,
        getGameConfig: () => gameConfig,
        getAllManagers: () => ({
            gameConfig,
            gameState,
            playerManager,
            weaponManager,
            enemyManager,
            bossManager,
            powerupManager,
            specialEffectsManager,
            collisionManager,
            uiManager,
            gameController,
            renderer
        }),
        forceGameOver: () => gameController.gameOver(),
        addScore: (points) => gameState.addScore(points),
        spawnBoss: () => bossManager.spawnBoss(),
        clearHighScores: () => {
            localStorage.removeItem('starFighterHighScores');
            gameState.highScores = {
                easy: 0, normal: 0, hard: 0, 
                nightmare: 0, fun: 0, dual: 0
            };
            uiManager.updateHighScoreDisplay();
            console.log('历史最高分已清除');
        }
    };
    
    console.log('调试工具已加载到 window.gameDebug');
}

// 导出主要函数供HTML调用
window.initGame = initGame;
window.createStars = createStars;

console.log('星空战机主程序已加载完成');
