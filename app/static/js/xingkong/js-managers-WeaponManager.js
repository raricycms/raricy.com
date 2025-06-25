/**
 * 武器系统管理类
 * 负责管理子弹、炸弹等武器相关功能
 */
class WeaponManager {
    constructor() {
        this.bullets = [];
        this.enemyBullets = [];
        this.explosions = [];
    }

    /**
     * 使用炸弹
     */
    useBomb() {
        if (gameState.bombCount > 0 && !gameState.isBombOnCooldown) {
            gameState.bombCount--;
            gameState.isBombOnCooldown = true;
            gameState.bombCooldownEndTime = Date.now() + 5000;
            
            // 禁用炸弹按钮
            const bombBtn = document.getElementById('bombBtn');
            bombBtn.disabled = true;
            
            // 显示冷却时间
            document.getElementById('bombCooldown').style.display = 'block';
            
            // 创建炸弹爆炸效果
            this.createBombExplosion();
            
            // 清除敌机和子弹
            this.clearEnemiesAndBullets();
            
            // 对Boss造成伤害
            if (gameState.currentBoss) {
                gameState.currentBoss.health -= 60;
                this.createExplosion(
                    gameState.currentBoss.x + gameState.currentBoss.width / 2,
                    gameState.currentBoss.y + gameState.currentBoss.height / 2
                );
            }
        }
    }

    /**
     * 创建炸弹爆炸效果
     */
    createBombExplosion() {
        const bombExplosion = document.createElement('div');
        bombExplosion.className = 'bomb-explosion';
        bombExplosion.style.left = '50%';
        bombExplosion.style.top = '50%';
        bombExplosion.style.width = '100px';
        bombExplosion.style.height = '100px';
        bombExplosion.style.marginLeft = '-50px';
        bombExplosion.style.marginTop = '-50px';
        document.body.appendChild(bombExplosion);
        
        setTimeout(() => {
            document.body.removeChild(bombExplosion);
        }, 500);
    }

    /**
     * 清除敌机和子弹
     */
    clearEnemiesAndBullets() {
        enemyManager.enemies.forEach(enemy => {
            this.createExplosion(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2);
            gameState.addScore(enemy.scoreValue * gameConfig.getDifficultyConfig(gameState.currentDifficulty).scoreMultiplier * 0.5);
            gameState.kills++;
        });
        enemyManager.enemies = [];
        this.enemyBullets = [];
    }

    /**
     * 更新炸弹冷却
     */
    updateBombCooldown() {
        if (gameState.isBombOnCooldown) {
            const now = Date.now();
            if (now >= gameState.bombCooldownEndTime) {
                gameState.isBombOnCooldown = false;
                document.getElementById('bombCooldown').style.display = 'none';
                document.getElementById('bombBtn').disabled = false;
            } else {
                const remainingTime = Math.ceil((gameState.bombCooldownEndTime - now) / 1000);
                document.getElementById('cooldownTime').textContent = remainingTime;
            }
        }
    }

    /**
     * 更新子弹位置
     */
    updateBullets() {
        this.bullets = this.bullets.filter(bullet => {
            // 趣味模式：检查子弹与黑洞的交互
            if (gameState.isFunMode) {
                if (!this.applyBlackholeEffect(bullet)) {
                    return false; // 子弹被黑洞吞噬
                }
            }
            
            // 更新子弹位置
            bullet.y -= bullet.speed;
            
            return bullet.y > -bullet.height;
        });
    }

    /**
     * 更新敌机子弹
     */
    updateEnemyBullets() {
        this.enemyBullets = this.enemyBullets.filter(bullet => {
            // 趣味模式：检查敌机子弹与黑洞的交互
            if (gameState.isFunMode) {
                if (!this.applyBlackholeEffect(bullet)) {
                    return false; // 子弹被黑洞吞噬
                }
            }
            
            // 更新子弹位置
            if (bullet.vx !== undefined) {
                bullet.x += bullet.vx;
                bullet.y += bullet.vy;
            } else {
                bullet.y += bullet.speed;
            }
            
            return bullet.y < renderer.canvas.height + bullet.height && 
                   bullet.x > -bullet.width && 
                   bullet.x < renderer.canvas.width + bullet.width;
        });
    }

    /**
     * 应用黑洞效果到子弹
     * @param {Object} bullet - 子弹对象
     * @returns {boolean} 子弹是否继续存在
     */
    applyBlackholeEffect(bullet) {
        for (let blackhole of specialEffectsManager.blackholes) {
            const dx = bullet.x + bullet.width/2 - blackhole.x;
            const dy = bullet.y + bullet.height/2 - blackhole.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // 黑洞内圈：直接吞噬子弹，无爆炸效果
            if (distance < blackhole.innerRadius) {
                return false; // 子弹消失
            }
            
            // 黑洞外圈：匀减速效果
            if (distance < blackhole.radius) {
                // 计算减速强度：距离黑洞中心越近，减速越强
                const distanceFromInner = distance - blackhole.innerRadius;
                const outerRingWidth = blackhole.radius - blackhole.innerRadius;
                const distanceRatio = distanceFromInner / outerRingWidth;
                
                // 减速因子：内圈边缘0.92，外圈边缘0.98
                const decelerationFactor = 0.92 + (distanceRatio * 0.06);
                
                // 应用减速效果
                if (bullet.vx !== undefined) {
                    // 有方向的子弹
                    bullet.vx *= decelerationFactor;
                    bullet.vy *= decelerationFactor;
                    
                    // 确保速度不会过低（保持最小速度）
                    const currentSpeed = Math.sqrt(bullet.vx * bullet.vx + bullet.vy * bullet.vy);
                    const minSpeed = 0.5; // 最小速度
                    if (currentSpeed < minSpeed && currentSpeed > 0) {
                        const speedRatio = minSpeed / currentSpeed;
                        bullet.vx *= speedRatio;
                        bullet.vy *= speedRatio;
                    }
                } else {
                    // 直线运动的子弹
                    bullet.speed *= decelerationFactor;
                    
                    // 确保速度不会过低
                    const minSpeed = 0.5;
                    if (bullet.speed < minSpeed) {
                        bullet.speed = minSpeed;
                    }
                }
            }
            // 注意：离开黑洞影响范围后，不恢复原始速度
        }
        
        return true; // 子弹继续存在
    }

    /**
     * 创建爆炸效果
     * @param {number} x - X坐标
     * @param {number} y - Y坐标
     */
    createExplosion(x, y) {
        this.explosions.push({
            x: x,
            y: y,
            radius: 5,
            life: 20,
            opacity: 1
        });
    }

    /**
     * 更新爆炸效果
     */
    updateExplosions() {
        this.explosions = this.explosions.filter(explosion => {
            explosion.life--;
            explosion.radius += 2;
            explosion.opacity -= 0.05;
            return explosion.life > 0;
        });
    }
}
