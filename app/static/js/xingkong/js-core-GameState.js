/**
 * 游戏状态管理类
 * 负责管理游戏的运行状态和数据
 */
class GameState {
    constructor() {
        this.reset();
    }

    /**
     * 重置游戏状态
     */
    reset() {
        // 游戏运行状态
        this.gameRunning = false;
        this.gamePaused = false;
        this.gameStartTime = 0;
        this.pausedTime = 0;
        this.totalPausedTime = 0; // 新增：总暂停时间

        // 游戏数据
        this.score = 0;
        this.kills = 0;
        this.crowns = 0;
        this.bossKills = 0;
        this.playerHealth = 120;
        this.player2Health = 120;
        this.currentDifficulty = 'normal';

        // 游戏模式
        this.isDualMode = false;
        this.isFunMode = false;

        // Boss相关
        this.lastBossDefeatedTime = 0;
        this.currentBoss = null;
        this.bossWarningActive = false;

        // 道具状态
        this.bombCount = 3;
        this.powerUpEndTime = 0;
        this.isPoweredUp = false;
        this.shieldEndTime = 0;
        this.isShielded = false;
        this.bombCooldownEndTime = 0;
        this.isBombOnCooldown = false;

        // 时间记录
        this.lastRandomPowerupTime = 0;
        this.lastBlackholeSpawn = 0;
        this.lastMeteorSpawn = 0;

        // 历史最高分
        if (!this.highScores) {
		this.highScores = {
            		easy: 0,
            	normal: 0,
            	hard: 0,
            	nightmare: 0,
            	fun: 0,
            	dual: 0
        	};
	}
    }

    /**
     * 开始游戏
     * @param {string} difficulty - 游戏难度
     */
    startGame(difficulty) {
        this.reset();
        this.currentDifficulty = difficulty;
        this.isDualMode = (difficulty === 'dual');
        this.isFunMode = (difficulty === 'fun');
        this.gameRunning = true;
        this.gameStartTime = Date.now();
        this.lastRandomPowerupTime = Date.now();
        this.lastBlackholeSpawn = Date.now();
        this.lastMeteorSpawn = Date.now();
    }

    /**
     * 暂停/继续游戏
     */
    togglePause() {
        if (!this.gameRunning) return;
        
        const now = Date.now();
        
        if (this.gamePaused) {
            // 恢复游戏：将当前暂停时间加入总暂停时间
            if (this.pausedTime > 0) {
                const pauseDuration = now - this.pausedTime;
                this.totalPausedTime += pauseDuration;
                this.adjustOtherTimesForPause(pauseDuration);
                this.pausedTime = 0;
            }
            this.gamePaused = false;
        } else {
            // 暂停游戏：记录暂停开始时间
            this.pausedTime = now;
            this.gamePaused = true;
        }
    }

    /**
     * 调整其他时间相关属性（不包括gameStartTime）
     * @param {number} pauseDuration - 暂停持续时间
     */
    adjustOtherTimesForPause(pauseDuration) {
        // 注意：不再调整 gameStartTime
        
        if (this.powerUpEndTime > 0) this.powerUpEndTime += pauseDuration;
        if (this.shieldEndTime > 0) this.shieldEndTime += pauseDuration;
        if (this.bombCooldownEndTime > 0) this.bombCooldownEndTime += pauseDuration;
        if (this.lastBossDefeatedTime > 0) this.lastBossDefeatedTime += pauseDuration;
        if (this.lastRandomPowerupTime > 0) this.lastRandomPowerupTime += pauseDuration;
        if (this.lastBlackholeSpawn > 0) this.lastBlackholeSpawn += pauseDuration;
        if (this.lastMeteorSpawn > 0) this.lastMeteorSpawn += pauseDuration;
    }

    /**
     * 结束游戏
     */
    endGame() {
        // 如果游戏在暂停状态下结束，先更新总暂停时间
        if (this.gamePaused && this.pausedTime > 0) {
            this.totalPausedTime += (Date.now() - this.pausedTime);
            this.pausedTime = 0;
        }
        
        this.gameRunning = false;
        this.gamePaused = false;
    }

    /**
     * 更新分数
     * @param {number} points - 增加的分数
     */
    addScore(points) {
        this.score += points;
        const newCrowns = Math.floor(this.score / 200000);
        if (newCrowns > this.crowns) {
            this.crowns = newCrowns;
        }
    }

    /**
     * 获取游戏时间（不包含暂停时间）
     * @returns {number} 游戏运行时间（秒）
     */
    getGameTime() {
        if (!this.gameStartTime) return 0;
        
        const now = Date.now();
        let totalPaused = this.totalPausedTime;
        
        // 如果当前正在暂停，加上当前暂停的时间
        if (this.gamePaused && this.pausedTime > 0) {
            totalPaused += (now - this.pausedTime);
        }
        
        const gameTime = now - this.gameStartTime - totalPaused;
        return Math.max(0, Math.floor(gameTime / 1000));
    }
}
