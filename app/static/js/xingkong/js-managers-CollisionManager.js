/**
 * 碰撞检测管理类
 * 负责处理游戏中的各种碰撞检测
 */
class CollisionManager {
    /**
     * 检查两个矩形是否碰撞
     * @param {Object} rect1 - 第一个矩形
     * @param {Object} rect2 - 第二个矩形
     * @returns {boolean} 是否碰撞
     */
    isColliding(rect1, rect2) {
        return rect1.x < rect2.x + rect2.width &&
               rect1.x + rect1.width > rect2.x &&
               rect1.y < rect2.y + rect2.height &&
               rect1.y + rect1.height > rect2.y;
    }

    /**
     * 检查所有碰撞
     */
    checkCollisions() {
        this.checkBulletEnemyCollisions();
        this.checkBulletBossCollisions();
        this.checkEnemyBulletPlayerCollisions();
        this.checkEnemyPlayerCollisions();
        this.checkBossPlayerCollisions();
        this.checkMeteorPlayerCollisions();
        this.checkPowerupPlayerCollisions();
    }

    /**
     * 检查玩家子弹与敌机的碰撞
     */
    checkBulletEnemyCollisions() {
        weaponManager.bullets.forEach((bullet, bulletIndex) => {
            enemyManager.enemies.forEach((enemy, enemyIndex) => {
                if (this.isColliding(bullet, enemy)) {
                    weaponManager.bullets.splice(bulletIndex, 1);
                    enemy.health -= bullet.damage;
                    
                    if (enemy.health <= 0) {
                        this.handleEnemyDestroyed(enemy, enemyIndex);
                    } else {
                        weaponManager.createExplosion(bullet.x, bullet.y);
                    }
                }
            });
        });
    }

    /**
     * 处理敌机被摧毁
     * @param {Object} enemy - 敌机对象
     * @param {number} enemyIndex - 敌机索引
     */
    handleEnemyDestroyed(enemy, enemyIndex) {
        weaponManager.createExplosion(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2);
        
        // 掉落道具
        this.dropEnemyPowerups(enemy);
        
        enemyManager.enemies.splice(enemyIndex, 1);
        gameState.addScore(enemy.scoreValue * gameConfig.getDifficultyConfig(gameState.currentDifficulty).scoreMultiplier);
        gameState.kills++;
    }

    /**
     * 敌机掉落道具
     * @param {Object} enemy - 敌机对象
     */
    dropEnemyPowerups(enemy) {
        if (Math.random() < enemy.powerDropChance) {
            powerupManager.spawnPowerup(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, 'power');
        }
        if (Math.random() < enemy.shieldDropChance) {
            powerupManager.spawnPowerup(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, 'shield');
        }
        if (Math.random() < enemy.healthDropChance) {
            powerupManager.spawnPowerup(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, 'health');
        }
        if (Math.random() < enemy.bombDropChance) {
            powerupManager.spawnPowerup(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, 'bomb');
        }
    }

    /**
     * 检查玩家子弹与Boss的碰撞
     */
    checkBulletBossCollisions() {
        if (!gameState.currentBoss) return;
        
        weaponManager.bullets.forEach((bullet, bulletIndex) => {
            if (this.isColliding(bullet, gameState.currentBoss)) {
                weaponManager.bullets.splice(bulletIndex, 1);
                gameState.currentBoss.health -= bullet.damage;
                weaponManager.createExplosion(bullet.x, bullet.y);
            }
        });
    }

    /**
     * 检查敌机子弹与玩家的碰撞
     */
    checkEnemyBulletPlayerCollisions() {
        if (gameState.isShielded) return;
        
        weaponManager.enemyBullets.forEach((bullet, bulletIndex) => {
            // 检查与玩家1的碰撞
            if (this.isColliding(bullet, playerManager.player)) {
                weaponManager.enemyBullets.splice(bulletIndex, 1);
                this.damagePlayer(bullet, 1);
            }
            
            // 检查与玩家2的碰撞（仅在双人模式下）
            if (gameState.isDualMode && this.isColliding(bullet, playerManager.player2)) {
                weaponManager.enemyBullets.splice(bulletIndex, 1);
                this.damagePlayer(bullet, 2);
            }
        });
    }

    /**
     * 对玩家造成伤害
     * @param {Object} bullet - 子弹对象
     * @param {number} playerNum - 玩家编号
     */
    damagePlayer(bullet, playerNum) {
        let damage = 20;
        
        if (bullet.isTargeted || bullet.isSniper) {
            damage = 25;
        }
        if (bullet.isBoss) {
            damage = bullet.damage || 20;
        }
        if (bullet.isBall) {
            damage = 15;
        }
        
        if (playerNum === 1) {
            gameState.playerHealth -= damage;
            if (gameState.playerHealth <= 0) {
                gameController.gameOver();
            }
        } else {
            gameState.player2Health -= damage;
            if (gameState.player2Health <= 0) {
                gameController.gameOver();
            }
        }
    }

    /**
     * 检查敌机与玩家的碰撞
     */
    checkEnemyPlayerCollisions() {
        enemyManager.enemies.forEach((enemy, enemyIndex) => {
            // 检查与玩家1的碰撞
            if (this.isColliding(enemy, playerManager.player)) {
                this.handleEnemyPlayerCollision(enemy, enemyIndex, 1);
            }
            
            // 检查与玩家2的碰撞（仅在双人模式下）
            if (gameState.isDualMode && this.isColliding(enemy, playerManager.player2)) {
                this.handleEnemyPlayerCollision(enemy, enemyIndex, 2);
            }
        });
    }

    /**
     * 处理敌机与玩家的碰撞
     * @param {Object} enemy - 敌机对象
     * @param {number} enemyIndex - 敌机索引
     * @param {number} playerNum - 玩家编号
     */
    handleEnemyPlayerCollision(enemy, enemyIndex, playerNum) {
        weaponManager.createExplosion(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2);
        enemyManager.enemies.splice(enemyIndex, 1);
        
        if (!gameState.isShielded) {
            if (playerNum === 1) {
                gameState.playerHealth -= 60;
                if (gameState.playerHealth <= 0) {
                    gameController.gameOver();
                }
            } else {
                gameState.player2Health -= 60;
                if (gameState.player2Health <= 0) {
                    gameController.gameOver();
                }
            }
        }
    }

    /**
     * 检查Boss与玩家的碰撞
     */
    checkBossPlayerCollisions() {
        if (!gameState.currentBoss || gameState.isShielded) return;
        
        if (this.isColliding(gameState.currentBoss, playerManager.player)) {
            gameState.playerHealth -= gameState.currentBoss.ramDamage;
            if (gameState.playerHealth <= 0) {
                gameController.gameOver();
            }
        }
        
        if (gameState.isDualMode && this.isColliding(gameState.currentBoss, playerManager.player2)) {
            gameState.player2Health -= gameState.currentBoss.ramDamage;
            if (gameState.player2Health <= 0) {
                gameController.gameOver();
            }
        }
    }

    /**
     * 检查陨石与玩家的碰撞（趣味模式）
     */
    checkMeteorPlayerCollisions() {
        if (!gameState.isFunMode) return;
        
        specialEffectsManager.meteors.forEach(meteor => {
            if (this.isColliding(meteor, playerManager.player)) {
                gameController.gameOver(); // 直接死亡
            }
            
            if (gameState.isDualMode && this.isColliding(meteor, playerManager.player2)) {
                gameController.gameOver(); // 直接死亡
            }
        });
    }

    /**
     * 检查道具与玩家的碰撞
     */
    checkPowerupPlayerCollisions() {
        powerupManager.powerups.forEach((powerup, powerupIndex) => {
            let collected = false;
            
            // 检查与玩家1的碰撞
            if (this.isColliding(powerup, playerManager.player)) {
                collected = true;
            }
            
            // 检查与玩家2的碰撞（仅在双人模式下）
            if (gameState.isDualMode && this.isColliding(powerup, playerManager.player2)) {
                collected = true;
            }
            
            if (collected) {
                powerupManager.powerups.splice(powerupIndex, 1);
                powerupManager.applyPowerupEffect(powerup.type);
            }
        });
    }
}
