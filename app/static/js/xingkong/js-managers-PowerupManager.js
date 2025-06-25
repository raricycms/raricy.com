/**
 * 道具管理类
 * 负责管理游戏中的各种道具
 */
class PowerupManager {
    constructor() {
        this.powerups = [];
    }

    /**
     * 生成道具
     * @param {number} x - X坐标
     * @param {number} y - Y坐标
     * @param {string} type - 道具类型
     */
    spawnPowerup(x, y, type = 'health') {
        this.powerups.push({
            x: x - 15,
            y: y,
            width: 30,
            height: 30,
            type: type
        });
    }

    /**
     * 生成随机道具
     */
    spawnRandomPowerup() {
        const now = Date.now();
        const config = gameConfig.getDifficultyConfig(gameState.currentDifficulty);
        
        if (now - gameState.lastRandomPowerupTime > 5000) {
            if (Math.random() < config.randomPowerupChance) {
                const powerupTypes = ['health', 'power', 'shield', 'bomb'];
                const randomType = powerupTypes[Math.floor(Math.random() * powerupTypes.length)];
                const x = Math.random() * (renderer.canvas.width - 60) + 30;
                const y = -30;
                
                this.spawnPowerup(x, y, randomType);
            }
            gameState.lastRandomPowerupTime = now;
        }
    }

    /**
     * 更新道具状态
     */
    updatePowerups() {
        this.powerups = this.powerups.filter(powerup => {
            powerup.y += 2;
            return powerup.y < renderer.canvas.height + powerup.height;
        });
    }

    /**
     * 更新火力增强状态
     */
    updatePowerUp() {
        if (gameState.isPoweredUp && Date.now() > gameState.powerUpEndTime) {
            gameState.isPoweredUp = false;
            document.getElementById('powerDisplay').style.display = 'none';
        }
        
        if (gameState.isPoweredUp) {
            const remainingTime = Math.ceil((gameState.powerUpEndTime - Date.now()) / 1000);
            document.getElementById('powerTime').textContent = remainingTime;
        }
    }

    /**
     * 更新护盾状态
     */
    updateShield() {
        if (gameState.isShielded && Date.now() > gameState.shieldEndTime) {
            gameState.isShielded = false;
            document.getElementById('shieldDisplay').style.display = 'none';
        }
        
        if (gameState.isShielded) {
            const remainingTime = Math.ceil((gameState.shieldEndTime - Date.now()) / 1000);
            document.getElementById('shieldTime').textContent = remainingTime;
        }
    }

    /**
     * 应用道具效果
     * @param {string} type - 道具类型
     */
    applyPowerupEffect(type) {
        switch (type) {
            case 'health':
                gameState.playerHealth = Math.min(120, gameState.playerHealth + 30);
                if (gameState.isDualMode) {
                    gameState.player2Health = Math.min(120, gameState.player2Health + 30);
                }
                break;
            case 'power':
                gameState.isPoweredUp = true;
                gameState.powerUpEndTime = Date.now() + 10000;
                document.getElementById('powerDisplay').style.display = 'block';
                break;
            case 'bomb':
                gameState.bombCount = Math.min(9, gameState.bombCount + 1);
                break;
            case 'shield':
                gameState.isShielded = true;
                gameState.shieldEndTime = Date.now() + 5000;
                document.getElementById('shieldDisplay').style.display = 'block';
                break;
        }
    }
}
