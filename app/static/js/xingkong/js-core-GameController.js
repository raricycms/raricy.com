/**
 * 游戏控制器类
 * 负责协调各个管理器，控制游戏流程
 */
class GameController {
    constructor() {
        this.backgroundOffset = 0;
    }

    /**
     * 开始游戏
     */
    startGame() {
        // 清除可能存在的Boss警告
        const existingWarnings = document.querySelectorAll('.boss-warning');
        existingWarnings.forEach(warning => {
            if (warning.parentNode) {
                warning.parentNode.removeChild(warning);
            }
        });
        
        // 隐藏所有界面
        document.getElementById('difficultyScreen').style.display = 'none';
        document.getElementById('introScreen').style.display = 'none';
        document.getElementById('gameOverScreen').style.display = 'none';
        document.getElementById('pauseScreen').style.display = 'none';
        
        // 启动游戏状态
        gameState.startGame(gameState.currentDifficulty);
        
        // 重置所有管理器
        weaponManager.bullets = [];
        weaponManager.enemyBullets = [];
        weaponManager.explosions = [];
        enemyManager.enemies = [];
        powerupManager.powerups = [];
        specialEffectsManager.blackholes = [];
        specialEffectsManager.meteors = [];
        
        // 初始化玩家位置
        playerManager.initializePositions();
        playerManager.adjustForDualMode(gameState.isDualMode);
        
        // 设置UI显示
        this.setupGameUI();
        
        // 开始游戏循环
        this.gameLoop();
    }

    /**
     * 设置游戏UI
     */
    setupGameUI() {
        document.getElementById('bossHealthBar').style.display = 'none';
        document.getElementById('powerDisplay').style.display = 'none';
        document.getElementById('shieldDisplay').style.display = 'none';
        document.getElementById('bombCooldown').style.display = 'none';
        document.getElementById('pauseIcon').className = 'fas fa-pause';
        
        // 显示/隐藏对应的血条
        if (gameState.isDualMode) {
            document.getElementById('healthBar').style.display = 'none';
            document.getElementById('healthBarDual').style.display = 'block';
        } else {
            document.getElementById('healthBar').style.display = 'block';
            document.getElementById('healthBarDual').style.display = 'none';
        }
    }

    /**
     * 游戏主循环
     */
    gameLoop() {
        if (!gameState.gameRunning) return;
        
        if (!gameState.gamePaused) {
            this.update();
        }
        renderer.draw();
        requestAnimationFrame(() => this.gameLoop());
    }

    /**
     * 更新游戏状态
     */
    update() {
        this.updateBackground();
        playerManager.updateMovement(gameState.isDualMode);
        playerManager.autoShoot(gameState.isDualMode, gameState.isPoweredUp);
        weaponManager.updateBullets();
        weaponManager.updateEnemyBullets();
        weaponManager.updateExplosions();
        weaponManager.updateBombCooldown();
        enemyManager.updateEnemies();
        enemyManager.spawnEnemies();
        bossManager.checkBossSpawn();
        bossManager.updateBoss();
        powerupManager.updatePowerups();
        powerupManager.updatePowerUp();
        powerupManager.updateShield();
        powerupManager.spawnRandomPowerup();
        
        if (gameState.isFunMode) {
            specialEffectsManager.updateBlackholes();
            specialEffectsManager.updateMeteors();
            specialEffectsManager.spawnBlackholes();
            specialEffectsManager.spawnMeteors();
        }
        
        collisionManager.checkCollisions();
        uiManager.updateGameUI();
        
        // 更新分数（时间加成）
        gameState.addScore(gameState.getGameTime() * 0.1 * gameConfig.getDifficultyConfig(gameState.currentDifficulty).scoreMultiplier);
    }

    /**
     * 更新背景滚动
     */
    updateBackground() {
        this.backgroundOffset += 2;
        if (this.backgroundOffset >= renderer.canvas.height) {
            this.backgroundOffset = 0;
        }
    }

    /**
     * 暂停/继续游戏
     */
    togglePause() {
        gameState.togglePause();
        
        if (gameState.gamePaused) {
            document.getElementById('pauseScreen').style.display = 'flex';
            document.getElementById('pauseIcon').className = 'fas fa-play';
        } else {
            document.getElementById('pauseScreen').style.display = 'none';
            document.getElementById('pauseIcon').className = 'fas fa-pause';
        }
    }

    /**
     * 从暂停界面退出到结算页面
     */
    quitToGameOver() {
        if (confirm('确定要退出当前游戏并查看结算吗？')) {
            gameState.endGame();
            document.getElementById('pauseScreen').style.display = 'none';
            this.gameOver();
        }
    }

    /**
     * 从暂停界面直接返回主菜单
     */
    quitToMenu() {
        if (confirm('确定要退出当前游戏并返回主菜单吗？当前进度将丢失。')) {
            gameState.endGame();
            document.getElementById('pauseScreen').style.display = 'none';
            uiManager.showDifficulty();
        }
    }

    /**
     * 游戏结束
     */
    gameOver() {
        gameState.endGame();
        uiManager.showGameOver();
    }
}
