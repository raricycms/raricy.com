/**
 * 特殊效果管理类
 * 负责管理趣味模式中的黑洞、陨石等特殊效果
 */
class SpecialEffectsManager {
    constructor() {
        this.blackholes = [];
        this.meteors = [];
    }

    /**
     * 生成黑洞
     */
    spawnBlackholes() {
        if (!gameState.isFunMode) return;
        
        const now = Date.now();
        const config = gameConfig.getDifficultyConfig(gameState.currentDifficulty);
        
        if (now - gameState.lastBlackholeSpawn > 1000) {
            if (Math.random() < config.blackholeSpawnRate) {
                const blackhole = {
                    x: Math.random() * (renderer.canvas.width - 200) + 100,
                    y: Math.random() * (renderer.canvas.height / 2) + 50,
                    radius: 100,          // 增大外圈影响范围
                    innerRadius: 35,      // 增大内圈吞噬范围
                    life: 15000,          // 15秒生命周期
                    createdTime: now
                };
                this.blackholes.push(blackhole);
            }
            gameState.lastBlackholeSpawn = now;
        }
    }

    /**
     * 更新黑洞状态
     */
    updateBlackholes() {
        if (!gameState.isFunMode) return;
        
        const now = Date.now();
        this.blackholes = this.blackholes.filter(blackhole => {
            return (now - blackhole.createdTime) < blackhole.life;
        });
    }

    /**
     * 生成陨石
     */
    spawnMeteors() {
        if (!gameState.isFunMode) return;
        
        const now = Date.now();
        const config = gameConfig.getDifficultyConfig(gameState.currentDifficulty);
        
        if (now - gameState.lastMeteorSpawn > 2000) {
            if (Math.random() < config.meteorSpawnRate) {
                const meteor = {
                    x: Math.random() * (renderer.canvas.width - 80) + 40,
                    y: -80,
                    width: 80,
                    height: 80,
                    speed: 3 + Math.random() * 2,
                    rotation: 0,
                    rotationSpeed: (Math.random() - 0.5) * 0.15  // 稍微减慢旋转速度
                };
                this.meteors.push(meteor);
            }
            gameState.lastMeteorSpawn = now;
        }
    }

    /**
     * 更新陨石状态
     */
    updateMeteors() {
        if (!gameState.isFunMode) return;
        
        this.meteors.forEach(meteor => {
            meteor.y += meteor.speed;
            meteor.rotation += meteor.rotationSpeed;
            
            // 检查陨石与敌机碰撞
            enemyManager.enemies = enemyManager.enemies.filter(enemy => {
                if (collisionManager.isColliding(meteor, enemy)) {
                    weaponManager.createExplosion(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2);
                    return false; // 移除敌机
                }
                return true;
            });
        });
        
        // 移除超出屏幕的陨石
        this.meteors = this.meteors.filter(meteor => meteor.y < renderer.canvas.height + meteor.height);
    }
}
