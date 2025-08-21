class AIEnemy {
    constructor(x, y, gameWidth, gameHeight) {
        this.x = x;
        this.y = y;
        this.gameWidth = gameWidth;
        this.gameHeight = gameHeight;
        this.speed = 1.5;
        this.direction = Math.random() * Math.PI * 2;
        this.size = 8;
        this.color = '#FF0000';
        this.targetPlayer = null;
        this.lastDirectionChange = 0;
        this.detectionRadius = 150; // 检测玩家的半径
        this.wanderRadius = 100; // 漫游半径
        this.wanderAngle = 0;
        this.state = 'wander'; // wander, chase
        this.stateChangeTime = 0;
        this.maxSpeed = 2.5;
        this.minSpeed = 1.0;
        this.relaxMode = false; // 新增：relax模式标志
        this.relaxTimer = 0; // 新增：relax模式计时器
    }

    update(deltaTime, players) {
        this.stateChangeTime += deltaTime;

        // 更新relax模式计时器
        if (this.relaxMode) {
            this.relaxTimer += deltaTime;
            if (this.relaxTimer >= 5000) { // 5秒后退出relax模式
                this.relaxMode = false;
                this.relaxTimer = 0;
            }
        }

        // 如果在avoiding状态，持续移动一段时间
        if (this.state === 'avoiding') {
            // 在avoiding状态下移动0.3秒后恢复正常行为
            if (this.stateChangeTime > 300) {
                this.state = 'wander';
                this.stateChangeTime = 0;
            } else {
                // 在avoiding状态下保持当前方向移动，速度与物理帧频率无关
                const normalizedSpeed = this.speed * (deltaTime / 20); // 基于20ms的标准帧时间
                this.x += Math.cos(this.direction) * normalizedSpeed;
                this.y += Math.sin(this.direction) * normalizedSpeed;
            }
        } else {
            // 寻找最近的活着的玩家
            const nearestPlayer = this.findNearestPlayer(players);

            // 只有在非relax模式下才会追击玩家
            if (!this.relaxMode && nearestPlayer && this.getDistanceToPlayer(nearestPlayer) < this.detectionRadius) {
                this.state = 'chase';
                this.targetPlayer = nearestPlayer;
                this.chasePlayer(deltaTime);
            } else {
                this.state = 'wander';
                this.targetPlayer = null;
                this.wander(deltaTime);
            }
        }

        // 边界检查
        this.constrainToBounds();
    }

    findNearestPlayer(players) {
        let nearestPlayer = null;
        let nearestDistance = Infinity;

        players.forEach(player => {
            if (player.isAlive) {
                const distance = this.getDistanceToPlayer(player);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestPlayer = player;
                }
            }
        });

        return nearestPlayer;
    }

    getDistanceToPlayer(player) {
        return Math.sqrt(
            Math.pow(player.x - this.x, 2) +
            Math.pow(player.y - this.y, 2)
        );
    }

    chasePlayer(deltaTime) {
        if (!this.targetPlayer) return;

        const dx = this.targetPlayer.x - this.x;
        const dy = this.targetPlayer.y - this.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > 0) {
            // 动态调整速度，距离越近速度越快
            const speedMultiplier = Math.min(2.0, Math.max(1.0, this.detectionRadius / distance));
            const currentSpeed = this.speed * speedMultiplier;
            
            // 使移动速度与物理帧频率无关，保持恒定
            const normalizedSpeed = currentSpeed * (deltaTime / 20); // 基于20ms的标准帧时间

            this.x += (dx / distance) * normalizedSpeed;
            this.y += (dy / distance) * normalizedSpeed;
        }
    }

    wander(deltaTime) {
        // 简单的漫游行为
        if (this.stateChangeTime > 1000) { // 每2秒改变一次方向
            this.direction += (Math.random() - 0.5) * Math.PI / 2;
            this.stateChangeTime = 0;
        }

        // 使移动速度与物理帧频率无关，保持恒定
        const normalizedSpeed = this.speed * 0.5 * (deltaTime / 20); // 基于20ms的标准帧时间
        this.x += Math.cos(this.direction) * normalizedSpeed;
        this.y += Math.sin(this.direction) * normalizedSpeed;
    }

    constrainToBounds() {
        const margin = this.size;

        if (this.x < margin) {
            this.x = margin;
            this.direction = Math.PI - this.direction;
        } else if (this.x > this.gameWidth - margin) {
            this.x = this.gameWidth - margin;
            this.direction = Math.PI - this.direction;
        }

        if (this.y < margin) {
            this.y = margin;
            this.direction = -this.direction;
        } else if (this.y > this.gameHeight - margin) {
            this.y = this.gameHeight - margin;
            this.direction = -this.direction;
        }
    }

    checkCollisionWithPlayer(player) {
        if (!player.isAlive) return false;

        const distance = this.getDistanceToPlayer(player);
        return distance < (this.size + 5); // 5是玩家的大致半径
    }

    // 新增：进入relax模式
    enterRelaxMode() {
        this.relaxMode = true;
        this.relaxTimer = 0;
    }

    handleObstacleCollision(obstacle) {
        const enemyCenterX = this.x;
        const enemyCenterY = this.y;
        const enemyRadius = this.size;

        // 计算AI与障碍物各边的距离
        const leftOverlap = (enemyCenterX + enemyRadius) - obstacle.x;
        const rightOverlap = (obstacle.x + obstacle.width) - (enemyCenterX - enemyRadius);
        const topOverlap = (enemyCenterY + enemyRadius) - obstacle.y;
        const bottomOverlap = (obstacle.y + obstacle.height) - (enemyCenterY - enemyRadius);

        // 找到最小的重叠距离，这就是最佳推出方向
        const minOverlap = Math.min(leftOverlap, rightOverlap, topOverlap, bottomOverlap);

        if (minOverlap > 0) {
            if (minOverlap === leftOverlap) {
                // 向左推出
                this.x = obstacle.x - enemyRadius - 1;
            } else if (minOverlap === rightOverlap) {
                // 向右推出
                this.x = obstacle.x + obstacle.width + enemyRadius + 1;
            } else if (minOverlap === topOverlap) {
                // 向上推出
                this.y = obstacle.y - enemyRadius - 1;
            } else if (minOverlap === bottomOverlap) {
                // 向下推出
                this.y = obstacle.y + obstacle.height + enemyRadius + 1;
            }
        }

        // 确保AI不会超出画布边界
        this.x = Math.max(enemyRadius, Math.min(this.gameWidth - enemyRadius, this.x));
        this.y = Math.max(enemyRadius, Math.min(this.gameHeight - enemyRadius, this.y));

        // 反弹效果：改变方向并设置碰撞后状态
        this.direction += Math.PI; // 偏转180度以远离障碍物
        this.state = 'avoiding';
        this.stateChangeTime = 0; // 重置状态改变时间
    }

    handleBarrierCollision(barrier) {
        // 修改1：对初始栏杆的碰撞处理
        // 计算AI相对于栏杆的位置，确定反弹方向
        const barrierCenterX = barrier.x + barrier.width / 2;
        const deltaX = this.x - barrierCenterX;
        
        // 设置反弹方向为垂直于初始栏杆，平行于x轴
        if (deltaX < 0) {
            // AI在栏杆左侧，向左反弹
            this.direction = Math.PI; // 向左
            this.x = barrier.x - this.size - 2; // 推到栏杆左侧
        } else {
            // AI在栏杆右侧，向右反弹
            this.direction = 0; // 向右
            this.x = barrier.x + barrier.width + this.size + 2; // 推到栏杆右侧
        }

        // 确保AI不会超出画布边界
        this.x = Math.max(this.size, Math.min(this.gameWidth - this.size, this.x));
        this.y = Math.max(this.size, Math.min(this.gameHeight - this.size, this.y));

        // 设置碰撞后状态
        this.state = 'avoiding';
        this.stateChangeTime = 0; // 重置状态改变时间
    }

    render(ctx) {
        ctx.save();

        // 修改渲染逻辑：relax模式下不显示追击效果
        if (this.state === 'chase' && !this.relaxMode) {
            ctx.shadowBlur = 20;
            ctx.shadowColor = 'red';
        }

        // 绘制主体 - relax模式下改变颜色
        ctx.fillStyle = this.relaxMode ? '#1E90FF' : this.color; // relax模式下显示蓝色
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();

        // 绘制边框
        ctx.strokeStyle = this.relaxMode ? '#0000FF' : '#800000';
        ctx.lineWidth = 2;
        ctx.stroke();

        if (this.state === 'chase' && !this.relaxMode) {
            ctx.shadowBlur = 0; 
        }

        // 绘制眼睛
        ctx.fillStyle = '#FFF';
        ctx.beginPath();
        ctx.arc(this.x - 3, this.y - 2, 2, 0, Math.PI * 2);
        ctx.arc(this.x + 3, this.y - 2, 2, 0, Math.PI * 2);
        ctx.fill();

        // 绘制瞳孔
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(this.x - 3, this.y - 2, 1, 0, Math.PI * 2);
        ctx.arc(this.x + 3, this.y - 2, 1, 0, Math.PI * 2);
        ctx.fill();

        // 如果在追击状态且非relax模式，绘制警告标识
        if (this.state === 'chase' && !this.relaxMode) {
            ctx.fillStyle = '#FF0000';
            ctx.font = '12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('!', this.x, this.y - this.size - 5);
        }

        // 如果在relax模式，绘制relax标识
        if (this.relaxMode) {
            ctx.fillStyle = '#0000CD';
            ctx.font = '12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Z', this.x, this.y - this.size - 5);
        }

        ctx.restore();
    }
}

class SurvivalManager {
    constructor(gameWidth, gameHeight) {
        this.gameWidth = gameWidth;
        this.gameHeight = gameHeight;
        this.aiEnemies = [];
        this.spawnTimer = 0;
        this.difficultyMultiplier = 1.0;
        // 设置默认难度参数
        this.setDifficulty('medium');
    }

    init() {
        this.aiEnemies = [];
        this.spawnTimer = 0;
        this.createInitialEnemies();
    }

    createInitialEnemies() {
        for (let i = 0; i < this.enemyCount; i++) {
            this.spawnEnemy();
        }
    }

    spawnEnemy() {
        if (this.aiEnemies.length >= this.maxEnemies) return;

        // 在边缘随机生成敌人
        let x, y;
        const side = Math.floor(Math.random() * 4);

        switch (side) {
            case 0: // 上边
                x = Math.random() * this.gameWidth;
                y = 0;
                break;
            case 1: // 右边
                x = this.gameWidth;
                y = Math.random() * this.gameHeight;
                break;
            case 2: // 下边
                x = Math.random() * this.gameWidth;
                y = this.gameHeight;
                break;
            case 3: // 左边
                x = 0;
                y = Math.random() * this.gameHeight;
                break;
        }

        const enemy = new AIEnemy(x, y, this.gameWidth, this.gameHeight);
        enemy.speed *= this.difficultyMultiplier;
        this.aiEnemies.push(enemy);
    }

    update(deltaTime, players, territory) {
        // 检查游戏是否处于暂停状态
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            return; // 如果游戏暂停，则不更新任何计时相关的逻辑
        }
        
        // 更新生成计时器
        this.spawnTimer += deltaTime;
        if (this.spawnTimer >= this.spawnInterval) {
            this.spawnEnemy();
            this.spawnTimer = 0;
        }

        // 更新所有敌人
        this.aiEnemies.forEach(enemy => {
            // 检查AI与障碍物的碰撞（在所有状态下）
            if (window.gameEngine && window.gameEngine.itemManager) {
                const itemManager = window.gameEngine.itemManager;
                
                // 检查与障碍物的碰撞
                for (const obstacle of itemManager.obstacles) {
                    const distance = Math.sqrt(
                        Math.pow(enemy.x - (obstacle.x + obstacle.width/2), 2) +
                        Math.pow(enemy.y - (obstacle.y + obstacle.height/2), 2)
                    );
                    
                    if (distance < (enemy.size + Math.max(obstacle.width, obstacle.height)/2)) {
                        enemy.handleObstacleCollision(obstacle);
                        break;
                    }
                }
                
                // 检查与初始栏杆的碰撞
                for (const barrier of itemManager.initialBarriers) {
                    const distance = Math.sqrt(
                        Math.pow(enemy.x - (barrier.x + barrier.width/2), 2) +
                        Math.pow(enemy.y - (barrier.y + barrier.height/2), 2)
                    );
                    
                    if (distance < (enemy.size + Math.max(barrier.width, barrier.height)/2)) {
                        enemy.handleBarrierCollision(barrier);
                        break;
                    }
                }
            }
            
            // 更新敌人状态
            enemy.update(deltaTime, players);
        });

        // 检查AI与玩家的碰撞
        this.checkAICollisions(players);

        // 检查玩家之间的碰撞（生存模式特有的对战特性）
        this.checkPlayerCollisions(players, territory);

        // 清理死亡的敌人
        this.cleanup();
    }

    checkAICollisions(players) {
        this.aiEnemies.forEach(enemy => {
            players.forEach(player => {
                if (enemy.checkCollisionWithPlayer(player)) {
                    // 修改2：碰撞玩家后AI进入relax模式
                    enemy.enterRelaxMode();
                    
                    // 如果玩家有护盾，则不死亡
                    if (!player.hasShield()) {
                        player.die();
                        // 在生存模式下，玩家死亡后自动获得3秒护盾
                        if (window.gameEngine && window.gameEngine.gameMode === 'survival') {
                            player.activateShield(3000);
                        }
                    }
                }
            });
        });
    }

    // 新增：检查玩家之间的碰撞（类似对战模式）
    checkPlayerCollisions(players, territory) {
        for (let i = 0; i < players.length; i++) {
            const player = players[i];
            if (!player.isAlive) continue;

            // 检查与其他玩家轨迹的碰撞
            for (let j = 0; j < players.length; j++) {
                if (i === j) continue;
                const otherPlayer = players[j];

                const collisionType = player.checkCollisionWithTrail(otherPlayer.trail, otherPlayer);

                if (collisionType === 'head-collision') {
                    // 头部碰撞：两人同时死亡
                    player.die();
                    otherPlayer.die();
                    // 在生存模式下，玩家死亡后自动获得3秒护盾
                    if (window.gameEngine && window.gameEngine.gameMode === 'survival') {
                        player.activateShield(3000);
                        otherPlayer.activateShield(3000);
                    }
                    break;
                } else if (collisionType === 'trail-collision') {
                    // 轨迹碰撞：碰撞者死亡，被碰撞者杀死对手
                    otherPlayer.die();
                    // 在生存模式下，玩家死亡后自动获得3秒护盾
                    if (window.gameEngine && window.gameEngine.gameMode === 'survival') {
                        otherPlayer.activateShield(3000);
                    }
                    break;
                }

                // 检查与其他玩家领土的碰撞
                const otherTerritories = territory.getPlayerTerritories(otherPlayer.id);
                if (!player.canEnterEnemyTerritory()) {
                    if (player.checkCollisionWithTerritory(otherTerritories)) {
                        player.die();
                        // 在生存模式下，玩家死亡后自动获得3秒护盾
                        if (window.gameEngine && window.gameEngine.gameMode === 'survival') {
                            player.activateShield(3000);
                            console.log('领土碰撞');
                        }
                        break;
                    }
                }
            }
        }
    }

    cleanup() {
        // 移除超出边界太远的敌人
        this.aiEnemies = this.aiEnemies.filter(enemy => {
            const margin = 100;
            return enemy.x > -margin &&
                enemy.x < this.gameWidth + margin &&
                enemy.y > -margin &&
                enemy.y < this.gameHeight + margin;
        });
    }

    render(ctx) {
        this.aiEnemies.forEach(enemy => {
            enemy.render(ctx);
        });
    }

    setDifficulty(level) {
        const settings = {
            slow: { multiplier: 0.9, count: 2, maxEnemies: 6, interval: 30000 },
            medium: { multiplier: 1.2, count: 3, maxEnemies: 7, interval: 20000 },
            fast: { multiplier: 1.4, count: 4, maxEnemies: 8, interval: 15000 },
            ultra: { multiplier: 2.0, count: 5, maxEnemies: 10, interval: 10000 }
        };

        const setting = settings[level] || settings.medium;
        this.difficultyMultiplier = setting.multiplier;
        this.enemyCount = setting.count;
        this.maxEnemies = setting.maxEnemies;
        this.spawnInterval = setting.interval;

        // 更新现有敌人的速度
        this.aiEnemies.forEach(enemy => {
            enemy.speed = 1.5 * this.difficultyMultiplier;
        });
    }

    getEnemyCount() {
        return this.aiEnemies.length;
    }

    reset() {
        this.aiEnemies = [];
        this.spawnTimer = 0;
        this.createInitialEnemies();
    }
}
