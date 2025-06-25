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
        this.speed = 2;
        this.size = 8;
        this.isMoving = false;
        this.trailLength = 300;
        this.shield = null;
    }

    update() {
        if (!this.isAlive) return;

        if (this.speedBoostEndTime && Date.now() > this.speedBoostEndTime) {
            this.speedMultiplier = 1;
            this.speedBoostEndTime = null;
        }
        const currentSpeed = this.speed * (this.speedMultiplier || 1);

        // 更新碰撞效果
        if (this.collisionEffect && this.collisionEffect.active) {
            const elapsed = Date.now() - this.collisionEffect.startTime;
            if (elapsed >= this.collisionEffect.duration) {
                this.collisionEffect.active = false;
            }
        }

        // 更新护盾效果
        if (this.shield) {
            this.shield.update(16); // 假设16ms的deltaTime
            if (!this.shield.isActive()) {
                this.shield = null;
            }
        }
        
        // 更新碰撞效果
        if (this.collisionEffect && this.collisionEffect.active) {
            const elapsed = Date.now() - this.collisionEffect.startTime;
            if (elapsed >= this.collisionEffect.duration) {
                this.collisionEffect.active = false;
            }
        }

        // 只有在移动时才更新位置和轨迹
        if (this.direction.x !== 0 || this.direction.y !== 0) {
            // 更新位置
            this.x += this.direction.x * currentSpeed;
            this.y += this.direction.y * currentSpeed;

            // 边界检查
            this.x = Math.max(this.size, Math.min(this.canvas.width - this.size, this.x));
            this.y = Math.max(this.size, Math.min(this.canvas.height - this.size, this.y));

            // 添加轨迹点
            this.trail.push({ x: this.x, y: this.y, timestamp: Date.now() });
            
            // 限制轨迹长度
            if (this.trail.length > this.trailLength) {
                this.trail.shift();
            }
        }
    }

    setDirection(dx, dy) {
        if (!this.isAlive) return;
        this.direction.x = dx;
        this.direction.y = dy;
        this.isMoving = (dx !== 0 || dy !== 0);
    }

    checkCollisionWithTrail(otherTrail) {
        if (!this.isAlive || otherTrail.length === 0) return false;

        for (let point of otherTrail) {
            const distance = Math.sqrt(
                Math.pow(this.x - point.x, 2) + Math.pow(this.y - point.y, 2)
            );
            if (distance < this.size + 3) {
                return true;
            }
        }
        return false;
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

    isPointInPolygon(point, polygon) {
        if (polygon.length < 3) return false;

        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            if (((polygon[i].y > point.y) !== (polygon[j].y > point.y)) &&
                (point.x < (polygon[j].x - polygon[i].x) * (point.y - polygon[i].y) / (polygon[j].y - polygon[i].y) + polygon[i].x)) {
                inside = !inside;
            }
        }
        return inside;
    }

    // 在 Player 类中添加以下方法

    applySpeedBoost(multiplier, duration) {
        this.speedMultiplier = multiplier;
        this.speedBoostEndTime = Date.now() + duration;
        console.log('speed:'+ this.speedMultiplier);
    }

    addLength(amount) {
        // 增加尾巴长度
        this.trailLength += amount;
        for (let i = 0; i < amount; i++) {
            if (this.trail.length > 0) {
                const lastPoint = this.trail[this.trail.length - 1];
                this.trail.push({x: lastPoint.x, y: lastPoint.y});
            }
        }
        console.log('length:'+ this.trailLength);
    }

    // 激活护盾
    activateShield(duration) {
        this.shield = new ShieldEffect(duration);
        console.log(`Player ${this.id} activated shield for ${duration}ms`);
        console.log('shield:'+ this.shield);
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
        // 计算碰撞后的反弹位置
        const playerCenterX = this.x;
        const playerCenterY = this.y;
        
        // 计算障碍物中心
        const obstacleCenterX = obstacle.x + obstacle.width / 2;
        const obstacleCenterY = obstacle.y + obstacle.height / 2;
        
        // 计算从障碍物中心到玩家的向量
        const deltaX = playerCenterX - obstacleCenterX;
        const deltaY = playerCenterY - obstacleCenterY;
        
        // 计算距离
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        
        if (distance > 0) {
            // 标准化向量
            const normalX = deltaX / distance;
            const normalY = deltaY / distance;
            
            // 计算玩家应该被推开的最小距离
            const pushDistance = 8; // 玩家半径 + 一点缓冲距离
            
            // 找到障碍物边缘最近的点
            const closestX = Math.max(obstacle.x, Math.min(playerCenterX, obstacle.x + obstacle.width));
            const closestY = Math.max(obstacle.y, Math.min(playerCenterY, obstacle.y + obstacle.height));
            
            // 计算推开方向
            const pushX = playerCenterX - closestX;
            const pushY = playerCenterY - closestY;
            const pushLength = Math.sqrt(pushX * pushX + pushY * pushY);
            
            if (pushLength > 0) {
                // 标准化推开向量
                const pushNormalX = pushX / pushLength;
                const pushNormalY = pushY / pushLength;
                
                // 将玩家推到障碍物外
                this.x = closestX + pushNormalX * pushDistance;
                this.y = closestY + pushNormalY * pushDistance;
            }
        }
        
        // 确保玩家不会超出画布边界
        this.x = Math.max(5, Math.min(this.canvas.width - 5, this.x));
        this.y = Math.max(5, Math.min(this.canvas.height - 5, this.y));
        
        // 可选：添加碰撞反馈效果
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
            startTime: Date.now()
        };
    }
    

    die() {
        this.isAlive = false;
        this.direction = { x: 0, y: 0 };
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
        this.speed = 2;
        this.trailLength = 300;
        this.speedMultiplier = 1;
        this.speedBoostEndTime = null;
        this.shield = null;
    }
}
