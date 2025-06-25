/**
 * Boss管理类
 * 负责管理Boss的生成、行为和攻击模式
 */
class BossManager {
    constructor() {
        this.currentBoss = null;
    }

    /**
     * 检查是否应该生成Boss
     */
    checkBossSpawn() {
        if (gameState.currentBoss || gameState.bossWarningActive) return;

        const now = Date.now();
        
        if (!gameState.currentBoss && gameState.lastBossDefeatedTime > 0 && (now - gameState.lastBossDefeatedTime) >= 100000) {
            this.spawnBoss();
        }
        else if (!gameState.currentBoss && gameState.lastBossDefeatedTime === 0 && (now - gameState.gameStartTime) >= 100000) {
            this.spawnBoss();
        }
    }

    /**
     * 生成Boss
     */
    spawnBoss() {
        if (gameState.bossWarningActive) return;
        
        gameState.bossWarningActive = true;
        
        // 随机选择Boss类型
        const bossTypeNames = Object.keys(gameConfig.bossTypes);
        const randomBossType = bossTypeNames[Math.floor(Math.random() * bossTypeNames.length)];
        const selectedBossType = gameConfig.getBossConfig(randomBossType);
        
        this.showBossWarning(selectedBossType);
        
        setTimeout(() => {
            this.createBoss(randomBossType, selectedBossType);
        }, 1000);
    }

    /**
     * 显示Boss警告
     * @param {Object} selectedBossType - Boss类型配置
     */
    showBossWarning(selectedBossType) {
        // 清除可能存在的旧警告
        const existingWarnings = document.querySelectorAll('.boss-warning');
        existingWarnings.forEach(warning => {
            if (warning.parentNode) {
                warning.parentNode.removeChild(warning);
            }
        });
        
        const warning = document.createElement('div');
        warning.className = 'boss-warning';
        warning.innerHTML = `
            <div><i class="fas fa-${selectedBossType.icon}"></i> ${selectedBossType.name}</div>
            <div class="boss-subtitle">${selectedBossType.subtitle}</div>
        `;
        document.body.appendChild(warning);
        
        setTimeout(() => {
            if (warning.parentNode) {
                warning.parentNode.removeChild(warning);
            }
            gameState.bossWarningActive = false;
        }, 2000);
    }

    /**
     * 创建Boss
     * @param {string} randomBossType - Boss类型名称
     * @param {Object} selectedBossType - Boss类型配置
     */
    createBoss(randomBossType, selectedBossType) {
        const config = gameConfig.getDifficultyConfig(gameState.currentDifficulty);
        
        const fireRateMultiplier = 1 + (gameState.bossKills * 0.1);
        const adjustedFireRate = Math.max(50, config.bossFireRate / fireRateMultiplier);
        
        gameState.currentBoss = {
            x: renderer.canvas.width / 2 - 60,
            y: -120,
            width: 120,
            height: 120,
            speed: config.bossSpeed,
            health: config.bossHealth,
            maxHealth: config.bossHealth,
            lastShot: 0,
            shotPattern: 0,
            fireRate: adjustedFireRate,
            phase: 1,
            bulletDamage: config.bossBulletDamage,
            ramDamage: config.bossRamDamage,
            bossflag: 1,
            attackSpeedMultiplier: fireRateMultiplier,
            lastSpecialAttack: 0,
            type: randomBossType,
            bossData: selectedBossType
        };
        
        document.getElementById('bossHealthBar').style.display = 'block';
        
        // 清除普通敌机
        enemyManager.enemies = [];
        weaponManager.enemyBullets = [];
    }

    /**
     * 更新Boss状态
     */
    updateBoss() {
        if (!gameState.currentBoss) return;

        this.updateBossMovement();
        this.updateBossAttack();
        this.updateBossHealth();
        this.checkBossDefeat();
    }

    /**
     * 更新Boss移动
     */
    updateBossMovement() {
        const boss = gameState.currentBoss;
        
        boss.y += boss.speed;
        if (boss.y > 50) {
            boss.y = 50;
            
            // 高难度下Boss会左右移动
            if (gameState.currentDifficulty === 'nightmare' || gameState.currentDifficulty === 'fun' || gameState.currentDifficulty === 'dual') {
                boss.x += Math.sin(Date.now() * 0.002) * 2;
                boss.x = Math.max(0, Math.min(renderer.canvas.width - boss.width, boss.x));
            }
        }
    }

    /**
     * 更新Boss攻击
     */
    updateBossAttack() {
        const boss = gameState.currentBoss;
        const now = Date.now();
        
        let currentFireRate = boss.fireRate;
        
        const healthRatio = boss.health / boss.maxHealth;
        if (healthRatio < 0.5 && boss.bossflag == 1) {
            boss.bossflag = 0;
            currentFireRate *= 0.6;
            boss.bulletDamage = Math.floor(boss.bulletDamage * 1.5);
            boss.ramDamage = Math.floor(boss.ramDamage * 1.5);
        }
        
        if (now - boss.lastShot > currentFireRate) {
            this.bossShoot();
            boss.lastShot = now;
        }

        // Boss特殊攻击（仅在第二阶段）
        if (boss.phase === 2 && now - boss.lastSpecialAttack > 3000) {
            this.bossSpecialAttack();
            boss.lastSpecialAttack = now;
        }

        if (healthRatio < 0.5 && boss.phase === 1) {
            boss.phase = 2;
        }
    }

    /**
     * Boss射击
     */
    bossShoot() {
        const boss = gameState.currentBoss;
        const centerX = boss.x + boss.width / 2;
        const centerY = boss.y + boss.height;
        const config = gameConfig.getDifficultyConfig(gameState.currentDifficulty);

        let patterns = 3;
        if (gameState.currentDifficulty === 'hard' || gameState.currentDifficulty === 'fun' || gameState.currentDifficulty === 'dual') patterns = 4;
        if (gameState.currentDifficulty === 'nightmare') patterns = 6;
        if (boss.phase === 2) patterns += 2;

        switch (boss.shotPattern % patterns) {
            case 0:
                this.createTripleBullets(centerX, centerY, config);
                break;
            case 1:
                this.createFanBullets(centerX, centerY, config, boss.phase);
                break;
            case 2:
                this.createTargetedBullet(centerX, centerY, config);
                break;
            case 3:
                this.createCircleBullets(centerX, centerY, config, boss.phase);
                break;
            case 4:
                this.createSpiralBullets(centerX, centerY, config, boss.phase);
                break;
            case 5:
                this.createLineBullets(centerX, centerY, config);
                break;
            case 6:
                this.createMultiTargetedBullets(centerX, centerY, config, boss.phase);
                break;
            case 7:
                this.createRotatingBullets(centerX, centerY, config);
                break;
        }
        boss.shotPattern++;
    }

    /**
     * 创建三发子弹
     */
    createTripleBullets(centerX, centerY, config) {
        for (let i = -1; i <= 1; i++) {
            weaponManager.enemyBullets.push({
                x: centerX + i * 25 - 2,
                y: centerY,
                width: 4,
                height: 8,
                speed: config.enemyBulletSpeed,
                damage: gameState.currentBoss.bulletDamage,
                isBoss: true
            });
        }
    }

    /**
     * 创建扇形子弹
     */
    createFanBullets(centerX, centerY, config, phase) {
        const fanCount = phase === 2 ? 9 : (gameState.currentDifficulty === 'nightmare' ? 7 : 5);
        for (let i = -(fanCount-1)/2; i <= (fanCount-1)/2; i++) {
            const angle = i * 0.4;
            weaponManager.enemyBullets.push({
                x: centerX - 2,
                y: centerY,
                width: 4,
                height: 8,
                speed: config.enemyBulletSpeed - 1,
                vx: Math.sin(angle) * 3,
                vy: Math.cos(angle) * (config.enemyBulletSpeed - 1),
                damage: gameState.currentBoss.bulletDamage,
                isBoss: true
            });
        }
    }

    /**
     * 创建追踪子弹
     */
    createTargetedBullet(centerX, centerY, config) {
        // 在双人模式下，随机选择目标
        let targetPlayer = playerManager.player;
        if (gameState.isDualMode && Math.random() < 0.5) {
            targetPlayer = playerManager.player2;
        }
        
        const dx = targetPlayer.x + targetPlayer.width / 2 - centerX;
        const dy = targetPlayer.y + targetPlayer.height / 2 - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const speed = config.enemyBulletSpeed + 1;
        weaponManager.enemyBullets.push({
            x: centerX - 2,
            y: centerY,
            width: 6,
            height: 10,
            speed: speed,
            vx: (dx / distance) * speed,
            vy: (dy / distance) * speed,
            isTargeted: true,
            damage: gameState.currentBoss.bulletDamage,
            isBoss: true
        });
    }

    /**
     * 创建圆形子弹
     */
    createCircleBullets(centerX, centerY, config, phase) {
        const circleCount = phase === 2 ? 12 : 8;
        for (let i = 0; i < circleCount; i++) {
            const angle = (i / circleCount) * Math.PI * 2;
            weaponManager.enemyBullets.push({
                x: centerX - 2,
                y: centerY,
                width: 4,
                height: 8,
                speed: config.enemyBulletSpeed - 2,
                vx: Math.cos(angle) * (config.enemyBulletSpeed - 2),
                vy: Math.sin(angle) * (config.enemyBulletSpeed - 2),
                damage: gameState.currentBoss.bulletDamage,
                isBoss: true
            });
        }
    }

    /**
     * 创建螺旋子弹
     */
    createSpiralBullets(centerX, centerY, config, phase) {
        const spiralCount = phase === 2 ? 5 : 3;
        for (let i = 0; i < spiralCount; i++) {
            const angle = (Date.now() * 0.01 + i * Math.PI * 2 / spiralCount) % (Math.PI * 2);
            weaponManager.enemyBullets.push({
                x: centerX - 2,
                y: centerY,
                width: 4,
                height: 8,
                speed: config.enemyBulletSpeed,
                vx: Math.cos(angle) * config.enemyBulletSpeed,
                vy: Math.sin(angle) * config.enemyBulletSpeed,
                damage: gameState.currentBoss.bulletDamage,
                isBoss: true
            });
        }
    }

    /**
     * 创建直线子弹
     */
    createLineBullets(centerX, centerY, config) {
        for (let i = 0; i < renderer.canvas.width; i += 150) {
            weaponManager.enemyBullets.push({
                x: i,
                y: centerY,
                width: 4,
                height: 8,
                speed: config.enemyBulletSpeed + 3,
                damage: gameState.currentBoss.bulletDamage,
                isBoss: true
            });
        }
    }

    /**
     * 创建多重追踪子弹
     */
    createMultiTargetedBullets(centerX, centerY, config, phase) {
        const multiCount = phase === 2 ? 5 : 3;
        for (let j = 0; j < multiCount; j++) {
            // 在双人模式下，随机选择目标
            let targetPlayer = playerManager.player;
            if (gameState.isDualMode && Math.random() < 0.5) {
                targetPlayer = playerManager.player2;
            }
            
            const dx = targetPlayer.x + targetPlayer.width / 2 - centerX;
            const dy = targetPlayer.y + targetPlayer.height / 2 - centerY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const speed = config.enemyBulletSpeed + 1;
            const offsetAngle = (j - Math.floor(multiCount/2)) * 0.3;
            const finalAngle = Math.atan2(dy, dx) + offsetAngle;
            
            weaponManager.enemyBullets.push({
                x: centerX - 2,
                y: centerY,
                width: 5,
                height: 8,
                speed: speed,
                vx: Math.cos(finalAngle) * speed,
                vy: Math.sin(finalAngle) * speed,
                isTargeted: true,
                damage: gameState.currentBoss.bulletDamage,
                isBoss: true
            });
        }
    }

    /**
     * 创建旋转子弹
     */
    createRotatingBullets(centerX, centerY, config) {
        for (let i = 0; i < 4; i++) {
            const angle = (i * Math.PI / 2) + (Date.now() * 0.005);
            weaponManager.enemyBullets.push({
                x: centerX - 2,
                y: centerY,
                width: 4,
                height: 8,
                speed: config.enemyBulletSpeed,
                vx: Math.cos(angle) * config.enemyBulletSpeed,
                vy: Math.sin(angle) * config.enemyBulletSpeed,
                damage: gameState.currentBoss.bulletDamage,
                isBoss: true
            });
        }
    }

    /**
     * Boss特殊攻击
     */
    bossSpecialAttack() {
        const boss = gameState.currentBoss;
        if (!boss || boss.phase !== 2) return;

        const centerX = boss.x + boss.width / 2;
        const centerY = boss.y + boss.height;
        const config = gameConfig.getDifficultyConfig(gameState.currentDifficulty);

        switch (boss.type) {
            case 'destroyer':
                this.destroyerSpecialAttack(centerX, centerY, config, boss);
                break;
            case 'watcher':
                this.watcherSpecialAttack(centerX, centerY, config, boss);
                break;
            case 'spider':
                this.spiderSpecialAttack(centerX, centerY, config, boss);
                break;
            case 'crystal':
                this.crystalSpecialAttack(centerX, centerY, config, boss);
                break;
            case 'flame':
                this.flameSpecialAttack(centerX, centerY, config, boss);
                break;
        }
    }

    /**
     * 毁灭者特殊攻击
     */
    destroyerSpecialAttack(centerX, centerY, config, boss) {
        for (let i = 0; i < 5; i++) {
            setTimeout(() => {
                for (let j = -2; j <= 2; j++) {
                    weaponManager.enemyBullets.push({
                        x: centerX + j * 30 - 3,
                        y: centerY,
                        width: 6,
                        height: 12,
                        speed: config.enemyBulletSpeed + 2,
                        damage: boss.bulletDamage * 1.5,
                        isBoss: true,
                        isSpecial: true
                    });
                }
            }, i * 200);
        }
    }

    /**
     * 监视者特殊攻击
     */
    watcherSpecialAttack(centerX, centerY, config, boss) {
        const sweepCount = 12;
        for (let i = 0; i < sweepCount; i++) {
            const angle = (i / sweepCount) * Math.PI * 2;
            for (let j = 0; j < 8; j++) {
                setTimeout(() => {
                    weaponManager.enemyBullets.push({
                        x: centerX - 2,
                        y: centerY,
                        width: 4,
                        height: 8,
                        speed: config.enemyBulletSpeed,
                        vx: Math.cos(angle + j * 0.1) * (config.enemyBulletSpeed + 1),
                        vy: Math.sin(angle + j * 0.1) * (config.enemyBulletSpeed + 1),
                        damage: boss.bulletDamage,
                        isBoss: true,
                        isSpecial: true
                    });
                }, j * 250);
            }
        }
    }

    /**
     * 蛛网王特殊攻击
     */
    spiderSpecialAttack(centerX, centerY, config, boss) {
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const distance = 150;
            const trapX = centerX + Math.cos(angle) * distance;
            const trapY = centerY + Math.sin(angle) * distance;
            
            for (let j = 0; j < 6; j++) {
                setTimeout(() => {
                    const dx = centerX - trapX;
                    const dy = centerY - trapY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    
                    weaponManager.enemyBullets.push({
                        x: trapX - 2,
                        y: trapY - 2,
                        width: 4,
                        height: 8,
                        speed: config.enemyBulletSpeed,
                        vx: (dx / dist) * config.enemyBulletSpeed,
                        vy: (dy / dist) * config.enemyBulletSpeed,
                        damage: boss.bulletDamage,
                        isBoss: true,
                        isSpecial: true
                    });
                }, j * 100);
            }
        }
    }

    /**
     * 水晶核心特殊攻击
     */
    crystalSpecialAttack(centerX, centerY, config, boss) {
        const reflectCount = 16;
        for (let i = 0; i < reflectCount; i++) {
            const angle = (i / reflectCount) * Math.PI * 2;
            weaponManager.enemyBullets.push({
                x: centerX - 2,
                y: centerY,
                width: 5,
                height: 10,
                speed: config.enemyBulletSpeed - 1,
                vx: Math.cos(angle) * (config.enemyBulletSpeed - 1),
                vy: Math.sin(angle) * (config.enemyBulletSpeed - 1),
                damage: boss.bulletDamage,
                isBoss: true,
                isSpecial: true,
                bounces: 2
            });
        }
    }

    /**
     * 烈焰君主特殊攻击
     */
    flameSpecialAttack(centerX, centerY, config, boss) {
        for (let ring = 0; ring < 3; ring++) {
            const ringRadius = 80 + ring * 40;
            const flameCount = 8 + ring * 4;
            
            setTimeout(() => {
                for (let i = 0; i < flameCount; i++) {
                    const angle = (i / flameCount) * Math.PI * 2;
                    const startX = centerX + Math.cos(angle) * ringRadius;
                    const startY = centerY + Math.sin(angle) * ringRadius;
                    
                    weaponManager.enemyBullets.push({
                        x: startX - 3,
                        y: startY - 3,
                        width: 6,
                        height: 6,
                        speed: config.enemyBulletSpeed + ring,
                        vx: Math.cos(angle + Math.PI) * (config.enemyBulletSpeed + ring),
                        vy: Math.sin(angle + Math.PI) * (config.enemyBulletSpeed + ring),
                        damage: boss.bulletDamage,
                        isBoss: true,
                        isSpecial: true,
                        isFlame: true
                    });
                }
            }, ring * 300);
        }
    }

    /**
     * 更新Boss血条
     */
    updateBossHealth() {
        const boss = gameState.currentBoss;
        const healthPercent = (boss.health / boss.maxHealth) * 100;
        document.getElementById('bossHealthFill').style.width = healthPercent + '%';
    }

    /**
     * 检查Boss是否被击败
     */
    checkBossDefeat() {
        const boss = gameState.currentBoss;
        
        if (boss.health <= 0) {
            weaponManager.createExplosion(boss.x + boss.width / 2, boss.y + boss.height / 2);
            gameState.addScore(25000 * gameConfig.getDifficultyConfig(gameState.currentDifficulty).scoreMultiplier);
            gameState.kills += 20;
            gameState.bossKills++;
            
            gameState.lastBossDefeatedTime = Date.now();
            
            // 掉落道具
            this.dropBossRewards(boss);
            
            gameState.currentBoss = null;
            document.getElementById('bossHealthBar').style.display = 'none';
        }
    }

    /**
     * Boss掉落奖励
     * @param {Object} boss - Boss对象
     */
    dropBossRewards(boss) {
        powerupManager.spawnPowerup(boss.x + boss.width / 2, boss.y + boss.height / 2, 'health');
        powerupManager.spawnPowerup(boss.x + boss.width / 2 - 30, boss.y + boss.height / 2, 'power');
        powerupManager.spawnPowerup(boss.x + boss.width / 2 + 30, boss.y + boss.height / 2, 'bomb');
        powerupManager.spawnPowerup(boss.x + boss.width / 2, boss.y + boss.height / 2 + 30, 'shield');
        powerupManager.spawnPowerup(boss.x + boss.width / 2 - 15, boss.y + boss.height / 2 + 45, 'bomb');
    }
}
