class Player {
    constructor(id, x, y, color, controls, canvas) {
        this.canvas = canvas;
        this.id = id;
        this.x = x;
        this.y = y;
        this.startX = x;
        this.startY = y;
        this.color = color;
        this.controls = controls;
        this.trail = [];
        this.isAlive = true;
        this.territory = [];
        this.score = 0;
        this.direction = { x: 0, y: 0 };
        this.size = 8;
        this.isMoving = false;
        this.shield = null;
        this.lastUpdateTime = 0;
        this.collisionEffect = null;
        this.speedMultiplier = 1;
        this.speedBoostEndTime = null;
        this.lockTime = null; // 添加封锁时间属性
        this.locktime = 5000;
        
        // 夺旗模式回家倒计时相关属性
        this.homeTimeLimit = 15000; // 15秒时间限制
        this.homeStartTime = null; // 离家开始时间
        this.isAtHome = true; // 是否在初始位置
        this.homeCountdownPaused = false; // 回家倒计时是否暂停
    }

    fixedUpdate(deltaTime) {
        // 检查游戏是否处于暂停状态
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            return; // 如果游戏暂停，则不更新任何计时相关的逻辑
        }

        // 检查封锁时间
        if (this.lockTime && Date.now() < this.lockTime) {
            return; // 如果在封锁时间内，不允许更新
        }

        if (!this.isAlive) return;
        
        // 夺旗模式回家倒计时逻辑
        if (window.gameEngine && window.gameEngine.gameMode === 'capture') {
            const currentlyAtHome = this.checkIfAtHome();
            
            if (currentlyAtHome && !this.isAtHome) {
                // 回家了，重置倒计时
                this.resetHomeCountdown();
            } else if (!currentlyAtHome && this.isAtHome) {
                // 离家了，开始倒计时
                this.startHomeCountdown();
            }
            
            // 检查是否超时
            if (this.isHomeCountdownExpired()) {
                // 超时，减生命值并重置位置
                this.lives--;
                if (this.lives > 0) {
                    // 重置到初始位置
                    this.x = this.startX;
                    this.y = this.startY;
                    this.trail = [];
                    this.direction = { x: 0, y: 0 };
                    this.isMoving = false;
                    this.resetHomeCountdown();
                } else {
                    // 生命值为0，死亡
                    this.isAlive = false;
                }
            }
        }

        // 检查速度提升是否结束
        if (this.speedBoostEndTime && Date.now() > this.speedBoostEndTime) {
            this.speedMultiplier = 1;
            this.speedBoostEndTime = null;
        }
        const currentSpeed = this.speed * (this.speedMultiplier || 1);

        // 更新碰撞效果（使用传入的deltaTime）
        if (this.collisionEffect && this.collisionEffect.active) {
            this.collisionEffect.elapsed = (this.collisionEffect.elapsed || 0) + deltaTime;
            if (this.collisionEffect.elapsed >= this.collisionEffect.duration) {
                this.collisionEffect.active = false;
                this.collisionEffect.elapsed = 0;
            }
        }

        // 更新护盾效果（使用传入的deltaTime）
        if (this.shield) {
            this.shield.update(deltaTime);
            if (!this.shield.isActive()) {
                this.shield = null;
            }
        }

        if (this.trail.length === 0) {
            this.trail.push({ x: this.x, y: this.y, timestamp: Date.now() });
        }
        if (this.direction.x !== 0 || this.direction.y !== 0) {
            const deltaSeconds = deltaTime / 1000;
            const displacement = currentSpeed * deltaSeconds * 60;

            // 上一位置
            let prevX = this.x;
            let prevY = this.y;

            // 更新位置
            this.x += this.direction.x * displacement;
            this.y += this.direction.y * displacement;

            // 边界检查
            this.x = Math.max(this.size, Math.min(this.canvas.width - this.size, this.x));
            this.y = Math.max(this.size, Math.min(this.canvas.height - this.size, this.y));

            // 插值采样轨迹点
            const lastPos = this.trail[this.trail.length - 1] || { x: prevX, y: prevY };
            let dx = this.x - lastPos.x;
            let dy = this.y - lastPos.y;
            let dist = Math.sqrt(dx * dx + dy * dy);

            // 使用更平滑的轨迹点生成方式
            while (dist >= this.standardistant) {
                const ratio = this.standardistant / dist;
                const newX = lastPos.x + dx * ratio;
                const newY = lastPos.y + dy * ratio;
                
                // 添加控制点以实现更平滑的曲线
                if (this.trail.length > 1) {
                    const prevPoint = this.trail[this.trail.length - 2];
                    const controlX = prevPoint.x + (lastPos.x - prevPoint.x) * 1.5;
                    const controlY = prevPoint.y + (lastPos.y - prevPoint.y) * 1.5;
                    this.trail.push({ 
                        x: newX, 
                        y: newY, 
                        controlX: controlX, 
                        controlY: controlY, 
                        timestamp: Date.now() 
                    });
                } else {
                    this.trail.push({ x: newX, y: newY, timestamp: Date.now() });
                }

                // 更新lastPos为新点
                dx = this.x - newX;
                dy = this.y - newY;
                dist = Math.sqrt(dx * dx + dy * dy);
                lastPos.x = newX;
                lastPos.y = newY;

                // 限制轨迹长度
                if (this.trail.length > this.trailLength) {
                    this.trail.shift();
                }
            }
        }
    }


    setDirection(dx, dy) {
        // 检查封锁时间
        if (this.lockTime && Date.now() < this.lockTime) {
            return; // 如果在封锁时间内，不允许移动
        }

        if (!this.isAlive) return;
        this.direction.x = dx;
        this.direction.y = dy;
        this.isMoving = (dx !== 0 || dy !== 0);
    }

    checkCollisionWithTrail(otherTrail, otherPlayer = null) {
        if (!this.isAlive || otherTrail.length === 0) return false;

        // 如果提供了其他玩家对象，先检查头部碰撞
        if (otherPlayer && otherPlayer.isAlive) {
            const headDistance = Math.sqrt(
                Math.pow(this.x - otherPlayer.x, 2) + Math.pow(this.y - otherPlayer.y, 2)
            );
            if (headDistance < this.size + otherPlayer.size) {
                return 'head-collision'; // 返回头部碰撞标识
            }
        }

        // 检查与轨迹的碰撞
        for (let point of otherTrail) {
            const distance = Math.sqrt(
                Math.pow(this.x - point.x, 2) + Math.pow(this.y - point.y, 2)
            );
            if (distance < this.size) {
                return 'trail-collision'; // 返回轨迹碰撞标识
            }
        }

        return false; // 无碰撞
    }

    checkCollisionWithTerritory(territory) {
        if (!this.isAlive) return false;

        for (let area of territory) {
            if (this.isPointInPolygon({ x: this.x, y: this.y }, area)) {
                return true;
            }
        }
        return false;
    }

    // 非零缠绕射线法
    isPointInPolygon(point, polygon) {
        if (polygon.length < 3) {
            return false;
        }

        let windingNumber = 0;

        for (let i = 0; i < polygon.length; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length]; // 获取下一个点，循环到开头

            // 条件1: 边的起点在测试点水平线的下方，终点在上方或水平线上 (向上穿越)
            if (p1.y <= point.y) {
                if (p2.y > point.y) {
                    // 计算边的朝向（从左到右还是从右到左）
                    // 使用叉积来判断点在边的左侧还是右侧
                    const isLeft = (p2.x - p1.x) * (point.y - p1.y) - (point.x - p1.x) * (p2.y - p1.y);
                    if (isLeft > 0) { // 点在边的左侧，意味着边是向上穿越，缠绕数+1
                        windingNumber++;
                    }
                }
            }
            // 条件2: 边的起点在测试点水平线的上方，终点在下方或水平线上 (向下穿越)
            else { // p1.y > point.y
                if (p2.y <= point.y) {
                    // 计算边的朝向
                    const isLeft = (p2.x - p1.x) * (point.y - p1.y) - (point.x - p1.x) * (p2.y - p1.y);
                    if (isLeft < 0) { // 点在边的右侧，意味着边是向下穿越，缠绕数-1
                        windingNumber--;
                    }
                }
            }
        }

        // 如果缠绕数不为零，则点在多边形内部
        return windingNumber !== 0;
    }

    applySpeedBoost(multiplier, duration) {
        this.speedMultiplier = multiplier;
        this.speedBoostEndTime = Date.now() + duration;
    }

    addLength(amount) {
        // 增加尾巴长度
        this.trailLength += amount;
    }

    // 激活护盾
    activateShield(duration) {
        // 如果游戏处于暂停状态，需要补偿暂停时间
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            // 在暂停状态下激活护盾，需要调整开始时间以补偿暂停
            const shield = new ShieldEffect(duration);
            // 保存原始开始时间
            const originalStartTime = shield.startTime;
            // 调整开始时间为暂停开始时间，这样在恢复时计时会正确
            shield.startTime = window.gameEngine.itemManager.pauseStartTime - duration;
            this.shield = shield;
        } else {
            this.shield = new ShieldEffect(duration);
        }
    }

    // 检查是否有护盾保护
    hasShield() {
        return this.shield && this.shield.isActive();
    }

    // 获取护盾剩余时间
    getShieldTimeRemaining() {
        if (!this.hasShield()) return 0;
        return Math.ceil(this.shield.getRemainingTime() / 1000);
    }

    handleObstacleCollision(obstacle) {
        const playerCenterX = this.x;
        const playerCenterY = this.y;
        const playerRadius = 5;

        // 计算玩家与障碍物各边的距离
        const leftOverlap = (playerCenterX + playerRadius) - obstacle.x;
        const rightOverlap = (obstacle.x + obstacle.width) - (playerCenterX - playerRadius);
        const topOverlap = (playerCenterY + playerRadius) - obstacle.y;
        const bottomOverlap = (obstacle.y + obstacle.height) - (playerCenterY - playerRadius);

        // 找到最小的重叠距离，这就是最佳推出方向
        const minOverlap = Math.min(leftOverlap, rightOverlap, topOverlap, bottomOverlap);

        if (minOverlap > 0) {

            if (minOverlap === leftOverlap) {
                // 向左推出
                this.x = obstacle.x - playerRadius - 1;
            } else if (minOverlap === rightOverlap) {
                // 向右推出
                this.x = obstacle.x + obstacle.width + playerRadius + 1;
            } else if (minOverlap === topOverlap) {
                // 向上推出
                this.y = obstacle.y - playerRadius - 1;
            } else if (minOverlap === bottomOverlap) {
                // 向下推出
                this.y = obstacle.y + obstacle.height + playerRadius + 1;
            }
        }

        // 确保玩家不会超出画布边界
        this.x = Math.max(playerRadius, Math.min(this.canvas.width - playerRadius, this.x));
        this.y = Math.max(playerRadius, Math.min(this.canvas.height - playerRadius, this.y));

        this.addCollisionEffect();
    }

    handleBarrierCollision(barrier) {
        // 计算障碍物中心
        const barrierCenterX = barrier.x + barrier.width / 2;
        const barrierCenterY = barrier.y + barrier.height / 2;

        // 计算从障碍物中心到玩家的向量
        const deltaX = this.x - barrierCenterX;
        const deltaY = this.y - barrierCenterY;

        // 计算距离
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (distance > 0) {
            // 计算玩家应该被推开的最小距离
            const pushDistance = 2 * this.speed; // 碰撞反弹距离

            // 寻找初始弹射点
            const startdistance = Math.min(Math.abs(barrier.x - this.x), Math.abs(barrier.x + barrier.width - this.x));
            let startpoint = 0;
            let startline = 0;
            if (startdistance === Math.abs(barrier.x - this.x)) {
                startpoint = barrier.x;
                startline = 0;
            } else {
                startpoint = barrier.x + barrier.width;
                startline = 1;
            }

            // 计算推开方向
            if (barrier) {
                this.x = startpoint;
                if (startline === 0) {
                    // 将玩家推到障碍物外
                    this.x = startpoint - pushDistance;
                } else {
                    this.x = startpoint + pushDistance;
                }
            }
        }

        // 确保玩家不会超出画布边界
        this.x = Math.max(5, Math.min(this.canvas.width - 5, this.x));
        this.y = Math.max(5, Math.min(this.canvas.height - 5, this.y));

        this.addCollisionEffect();

    }

    canEnterEnemyTerritory() {
        return this.hasShield()
    }

    // 添加碰撞视觉反馈效果
    addCollisionEffect() {
        // 设置碰撞效果状态
        this.collisionEffect = {
            active: true,
            duration: 200, // 效果持续200毫秒
            startTime: Date.now(),
            glowColor: 'rgba(255, 0, 0, 0.7)'
        };
    }

    distant(x, y, trail) {
        if (trail.length === 0) {
            this.trail.push({ x: this.x, y: this.y, timestamp: Date.now() });
            return this.standardistant + 1;
        }
        const lastPoint = trail[trail.length - 1];
        return Math.sqrt(Math.pow(x - lastPoint.x, 2) + Math.pow(y - lastPoint.y, 2));
    }

    // 检查是否在初始位置（家）
    checkIfAtHome() {
        const homeRadius = 20; // 初始位置的有效半径
        const distance = Math.sqrt(
            Math.pow(this.x - this.startX, 2) + 
            Math.pow(this.y - this.startY, 2)
        );
        return distance <= homeRadius;
    }
    
    // 开始离家计时
    startHomeCountdown() {
        if (this.isAtHome && !this.homeStartTime) {
            this.homeStartTime = Date.now();
            this.isAtHome = false;
        }
    }
    
    // 回家重置时间
    resetHomeCountdown() {
        this.homeStartTime = null;
        this.isAtHome = true;
    }
    
    // 获取回家倒计时剩余时间
    getHomeCountdownRemaining() {
        if (!this.homeStartTime || this.isAtHome) {
            return 0;
        }
        
        const elapsed = Date.now() - this.homeStartTime;
        const remaining = Math.max(0, this.homeTimeLimit - elapsed);
        return Math.ceil(remaining / 1000); // 返回秒数
    }
    
    // 检查是否超时
    isHomeCountdownExpired() {
        if (!this.homeStartTime || this.isAtHome) {
            return false;
        }
        
        const elapsed = Date.now() - this.homeStartTime;
        return elapsed >= this.homeTimeLimit;
    }
    
    // 暂停回家倒计时
    pauseHomeCountdown() {
        if (this.homeStartTime && !this.homeCountdownPaused) {
            this.pausedHomeTime = Date.now() - this.homeStartTime;
            this.homeCountdownPaused = true;
        }
    }
    
    // 恢复回家倒计时
    resumeHomeCountdown() {
        if (this.homeCountdownPaused && this.pausedHomeTime) {
            this.homeStartTime = Date.now() - this.pausedHomeTime;
            this.pausedHomeTime = null;
            this.homeCountdownPaused = false;
        }
    }

    die() {
        this.lives--;
        if (this.lives > 0) {
            if (gameEngine.gameMode === 'infinite') {
                this.lives = 2;
                this.diereset(this.startX, this.startY);
            } else if (gameEngine.gameMode === 'fight' || gameEngine.gameMode === 'survival') {
                this.diereset(this.startX, this.startY);
            } else {
                this.isAlive = false;
            }
        } else {
            this.isAlive = false;
        }
    }

    diereset(x, y) {
        this.x = x;
        this.y = y;
        this.startX = x;
        this.startY = y;
        this.trail = [];
        this.isAlive = true;
        this.direction = { x: 0, y: 0 };
        this.isMoving = false;
        this.lastUpdateTime = 0;
        this.speedMultiplier = 1;
        this.speedBoostEndTime = null;
        this.shield = null;
        this.collisionEffect = null;
        this.pausedLockTime = null; // 重置暂停时的封锁时间

        // 在无限模式下添加5秒封锁时间
        if (window.gameEngine && window.gameEngine.gameMode === 'infinite') {
            this.lockTime = Date.now() + this.locktime; // 5秒封锁时间
            this.locktime += 2000
        }
    }

    reset(x, y) {
        this.x = x;
        this.y = y;
        this.startX = x;
        this.startY = y;
        this.trail = [];
        this.territory = [];
        this.score = 0;
        this.isAlive = true;
        this.direction = { x: 0, y: 0 };
        this.isMoving = false;
        this.speedMultiplier = 1;
        this.speedBoostEndTime = null;
        this.shield = null;
        this.collisionEffect = null;
        this.lastUpdateTime = 0;
        this.lockTime = null; // 重置封锁时间
        this.locktime = 5000;
        this.pausedLockTime = null; // 重置暂停时的封锁时间
        
        // 重置夺旗模式回家倒计时
        this.homeStartTime = null;
        this.isAtHome = true;
        this.homeCountdownPaused = false;
    }
}
