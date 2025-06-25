/**
 * 敌机管理类
 * 负责管理敌机的生成、移动和行为
 */
class EnemyManager {
    constructor() {
        this.enemies = [];
    }

    /**
     * 生成敌机
     */
    spawnEnemies() {
        if (gameState.currentBoss) return;
        
        const config = gameConfig.getDifficultyConfig(gameState.currentDifficulty);
        
        if (this.enemies.length >= config.maxEnemies) return;
        
        // 检查Ball敌机数量限制
        const ballEnemies = this.enemies.filter(enemy => enemy.type === 'ball').length;
        
        if (Math.random() < config.enemySpawnRate) {
            let typeNames = Object.keys(gameConfig.enemyTypes);
            
            // 根据难度过滤敌机类型
            if (gameState.currentDifficulty === 'easy') {
                typeNames = typeNames.filter(type => type !== 'ball');
            } else if (ballEnemies >= config.maxBallEnemies) {
                typeNames = typeNames.filter(type => type !== 'ball');
            }
            
            const typeName = typeNames[Math.floor(Math.random() * typeNames.length)];
            const enemyType = gameConfig.getEnemyConfig(typeName);
            
            this.createEnemy(typeName, enemyType, config);
        }
    }

    /**
     * 创建敌机
     * @param {string} typeName - 敌机类型名称
     * @param {Object} enemyType - 敌机类型配置
     * @param {Object} config - 难度配置
     */
    createEnemy(typeName, enemyType, config) {
        const enemy = {
            x: Math.random() * (renderer.canvas.width - enemyType.width),
            y: -enemyType.height,
            width: enemyType.width,
            height: enemyType.height,
            speed: (Math.random() * (config.enemySpeed.max - config.enemySpeed.min) + config.enemySpeed.min) * (enemyType.speedMultiplier || 1),
            health: enemyType.health,
            maxHealth: enemyType.health,
            type: typeName,
            color: enemyType.color,
            secondaryColor: enemyType.secondaryColor,
            scoreValue: enemyType.score,
            fireRateMultiplier: enemyType.fireRateMultiplier || 1,
            bulletSpeedMultiplier: enemyType.bulletSpeedMultiplier || 1,
            movementType: enemyType.movementType,
            powerDropChance: enemyType.powerDropChance,
            shieldDropChance: enemyType.shieldDropChance,
            healthDropChance: enemyType.healthDropChance,
            bombDropChance: enemyType.bombDropChance,
            specialAttack: enemyType.specialAttack
        };
        
        this.enemies.push(enemy);
    }

    /**
     * 更新敌机状态
     */
    updateEnemies() {
        const config = gameConfig.getDifficultyConfig(gameState.currentDifficulty);
        
        this.enemies.forEach(enemy => {
            this.updateEnemyMovement(enemy);
            this.updateEnemyFiring(enemy, config);
        });
        
        // 移除超出屏幕的敌机
        this.enemies = this.enemies.filter(enemy => enemy.y < renderer.canvas.height + enemy.height);
    }

    /**
     * 更新敌机移动
     * @param {Object} enemy - 敌机对象
     */
    updateEnemyMovement(enemy) {
        switch (enemy.movementType) {
            case 'straight':
                enemy.y += enemy.speed;
                break;
            case 'hover':
                if (enemy.y < 100) {
                    enemy.y += enemy.speed;
                } else {
                    enemy.hoverTime = (enemy.hoverTime || 0) + 1;
                    if (enemy.hoverTime > 300) {
                        enemy.y += enemy.speed * 0.5;
                    }
                }
                break;
            case 'patrol':
                if (enemy.y < 80) {
                    enemy.y += enemy.speed;
                } else {
                    enemy.patrolDirection = enemy.patrolDirection || 1;
                    enemy.x += enemy.patrolDirection * 2;
                    if (enemy.x <= 0 || enemy.x >= renderer.canvas.width - enemy.width) {
                        enemy.patrolDirection *= -1;
                    }
                }
                break;
            case 'float':
                // Ball敌机的浮动移动
                if (enemy.y < 120) {
                    enemy.y += enemy.speed;
                } else {
                    enemy.floatTime = (enemy.floatTime || 0) + 1;
                    enemy.x += Math.sin(enemy.floatTime * 0.02) * 1.5;
                    enemy.y += Math.sin(enemy.floatTime * 0.01) * 0.5;
                    
                    // 保持在屏幕内
                    enemy.x = Math.max(0, Math.min(renderer.canvas.width - enemy.width, enemy.x));
                    enemy.y = Math.max(50, Math.min(renderer.canvas.height / 2, enemy.y));
                }
                break;
        }
    }

    /**
     * 更新敌机射击
     * @param {Object} enemy - 敌机对象
     * @param {Object} config - 难度配置
     */
    updateEnemyFiring(enemy, config) {
        const fireRate = config.enemyFireRate * (enemy.fireRateMultiplier || 1);
        if (Math.random() < fireRate) {
            const bulletSpeed = config.enemyBulletSpeed * (enemy.bulletSpeedMultiplier || 1);
            
            if (enemy.type === 'sniper' && enemy.y < 150) {
                this.createSniperBullet(enemy, bulletSpeed);
            } else if (enemy.type === 'ball' && enemy.specialAttack === 'radial_burst') {
                this.createRadialBurst(enemy, bulletSpeed);
            } else {
                this.createNormalBullet(enemy, bulletSpeed);
            }
        }
    }

    /**
     * 创建狙击手子弹
     * @param {Object} enemy - 敌机对象
     * @param {number} bulletSpeed - 子弹速度
     */
    createSniperBullet(enemy, bulletSpeed) {
        // 在双人模式下，随机选择目标
        let targetPlayer = playerManager.player;
        if (gameState.isDualMode && Math.random() < 0.5) {
            targetPlayer = playerManager.player2;
        }
        
        const dx = targetPlayer.x + targetPlayer.width / 2 - (enemy.x + enemy.width / 2);
        const dy = targetPlayer.y + targetPlayer.height / 2 - (enemy.y + enemy.height);
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        weaponManager.enemyBullets.push({
            x: enemy.x + enemy.width / 2 - 2,
            y: enemy.y + enemy.height,
            width: 4,
            height: 8,
            speed: bulletSpeed,
            vx: (dx / distance) * bulletSpeed,
            vy: (dy / distance) * bulletSpeed,
            isTargeted: true,
            isSniper: true
        });
    }

    /**
     * 创建圆形弹幕
     * @param {Object} enemy - 敌机对象
     * @param {number} bulletSpeed - 子弹速度
     */
    createRadialBurst(enemy, bulletSpeed) {
        const bulletCount = 8;
        for (let i = 0; i < bulletCount; i++) {
            const angle = (i / bulletCount) * Math.PI * 2;
            weaponManager.enemyBullets.push({
                x: enemy.x + enemy.width / 2 - 3,
                y: enemy.y + enemy.height / 2 - 3,
                width: 6,
                height: 6,
                speed: bulletSpeed * 0.8,
                vx: Math.cos(angle) * bulletSpeed * 0.8,
                vy: Math.sin(angle) * bulletSpeed * 0.8,
                isBall: true,
                isRadial: true
            });
        }
    }

    /**
     * 创建普通子弹
     * @param {Object} enemy - 敌机对象
     * @param {number} bulletSpeed - 子弹速度
     */
    createNormalBullet(enemy, bulletSpeed) {
        weaponManager.enemyBullets.push({
            x: enemy.x + enemy.width / 2 - 2,
            y: enemy.y + enemy.height,
            width: 4,
            height: 8,
            speed: bulletSpeed
        });
    }
}
