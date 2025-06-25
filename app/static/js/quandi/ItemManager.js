class ItemManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.items = [];
        this.obstacles = [];
        this.initialBarriers = [];
        this.spawnTimer = 0;
        this.itemSpawnInterval = 3000; // 3秒生成一个道具
        this.obstacleSpawnInterval = 5000; // 5秒生成一个障碍物
        this.lastItemSpawn = 0;
        this.lastObstacleSpawn = 0;
        // 初始栏杆相关属性
        this.initialBarrierDuration = 12000; // 10秒
        this.initialBarrierStartTime = Date.now();
        this.initialBarriersCreated = false;
                
        // 创建初始栏杆
        this.createInitialBarriers();
    }

    update(deltaTime) {
        this.spawnTimer += deltaTime;
       
        // 检查初始栏杆是否应该消失
        const currentTime = Date.now();
        if (currentTime - this.initialBarrierStartTime >= this.initialBarrierDuration) {
            if (this.initialBarriers.length > 0) {
                this.initialBarriers = [];
                console.log('Initial barriers removed');
            }
        }
        
        // 生成道具
        if (this.spawnTimer - this.lastItemSpawn > this.itemSpawnInterval) {
            this.spawnRandomItem();
            this.lastItemSpawn = this.spawnTimer;
        }
        
        // 生成障碍物
        if (this.spawnTimer - this.lastObstacleSpawn > this.obstacleSpawnInterval) {
            this.spawnRandomObstacle();
            this.lastObstacleSpawn = this.spawnTimer;
        }
        
        // 更新道具（如果有动画效果）
        this.items.forEach(item => {
            if (item.update) {
                item.update(deltaTime);
            }
        });


    }

    createInitialBarriers() {
        if (this.initialBarriersCreated) return;
        
        // 计算地图中间的X坐标
        const centerX = this.canvas.width * 0.4;
        const centerY = this.canvas.width * 0.6;
        const barrierWidth = 40;
        const barrierHeight = 40;
        
        // 计算栏杆的X位置（居中）
        const barrierX = centerX - barrierWidth / 2;
        const barrierY = centerY - barrierWidth / 2; 
        
        // 从上到下创建栏杆，无缝隙
        for (let y = 0; y < this.canvas.height; y += barrierHeight) {
            const barrier = new InitialBarrier(barrierX, y, barrierWidth, barrierHeight);
            const barrier2 = new InitialBarrier(barrierY, y, barrierWidth, barrierHeight);
            this.initialBarriers.push(barrier);
            this.initialBarriers.push(barrier2);
        }
        
        this.initialBarriersCreated = true;
    

        // 确保道具不会生成在初始栏杆位置
        let x, y;
        let attempts = 0;
        const maxAttempts = 10;
        
        do {
            x = Math.random() * (this.canvas.width - 40) + 20;
            y = Math.random() * (this.canvas.height - 40) + 20;
            attempts++;
        } while (this.isPositionBlocked(x, y) && attempts < maxAttempts);
        
        if (attempts < maxAttempts) {
            const itemTypes = ['speed', 'length'];
            const type = itemTypes[Math.floor(Math.random() * itemTypes.length)];
            const item = new PowerUpItem(x, y, type);
            this.items.push(item);
        }
    }

    spawnRandomItem() {
        // 确保道具不会生成在初始栏杆位置
        let x, y;
        let attempts = 0;
        const maxAttempts = 10;
        
        do {
            x = Math.random() * (this.canvas.width - 40) + 20;
            y = Math.random() * (this.canvas.height - 40) + 20;
            attempts++;
        } while (this.isPositionBlocked(x, y) && attempts < maxAttempts);
        
        if (attempts < maxAttempts) {
            const itemTypes = ['speed', 'length','shield'];
            const type = itemTypes[Math.floor(Math.random() * itemTypes.length)];
            const item = new PowerUpItem(x, y, type);
            this.items.push(item);
        }
    }

    spawnRandomObstacle() {
        // 确保障碍物不会生成在初始栏杆位置
        let x, y;
        let attempts = 0;
        const maxAttempts = 10;
        
        do {
            x = Math.random() * (this.canvas.width - 60) + 30;
            y = Math.random() * (this.canvas.height - 60) + 30;
            attempts++;
        } while (this.isPositionBlocked(x, y) && attempts < maxAttempts);
        
        if (attempts < maxAttempts) {
            const obstacle = new Barrier(x, y);
            this.obstacles.push(obstacle);
        }
    }

    // 检查位置是否被初始栏杆阻挡
    isPositionBlocked(x, y) {
        const centerX = this.canvas.width / 2;
        const barrierWidth = 40;
        const barrierLeft = centerX - barrierWidth / 2;
        const barrierRight = centerX + barrierWidth / 2;
        
        // 检查是否在初始栏杆的X范围内
        return x >= barrierLeft - 20 && x <= barrierRight + 20;
    }

    checkItemCollision(player) {
        for (let i = this.items.length - 1; i >= 0; i--) {
            const item = this.items[i];
            const distance = Math.sqrt(
                Math.pow(player.x - item.x, 2) + 
                Math.pow(player.y - item.y, 2)
            );
            
            if (distance < item.radius + 5) {
                // 应用道具效果
                item.applyEffect(player);
                // 移除道具
                this.items.splice(i, 1);
                return true;
            }
        }
        return false;
    }

    checkObstacleCollision(player) {
        for (const obstacle of this.obstacles) {
            if (obstacle.checkCollision(player.x, player.y, 5)) {
                // 立即处理碰撞
                player.handleObstacleCollision(obstacle);
                return obstacle;
            }
        }

        for (const barrier of this.initialBarriers) {
            if (barrier.checkCollision(player.x, player.y, 5)) {
                return barrier;
            }
        }
        return null;
    }

    render(renderer) {
        // 渲染道具
        this.items.forEach(item => {
            item.render(renderer);
        });
        
        // 渲染障碍物
        this.obstacles.forEach(obstacle => {
            obstacle.render(renderer);
        });

        // 渲染初始栏杆
        this.initialBarriers.forEach(barrier => {
            barrier.render(renderer);
        });
    }

    // 清理超时的道具和障碍物
    cleanup() {
        const currentTime = Date.now();
        
        // 清理超时道具（30秒后消失）
        this.items = this.items.filter(item => 
            currentTime - item.spawnTime < 10000
        );
        
        // 限制障碍物数量（最多10个）
        if (this.obstacles.length > 10) {
            this.obstacles.splice(0, this.obstacles.length - 10);
        }
    }

    reset() {
        this.items = [];
        this.obstacles = [];
        this.initialBarriers = [];
        this.initialBarriersCreated = false;
        this.initialBarrierStartTime = Date.now();
        this.createInitialBarriers();

    }
}

class PowerUpItem {
    constructor(x, y, type) {
        this.x = x;
        this.y = y;
        this.type = type; // 'speed' 或 'length'
        this.radius = 15;
        this.spawnTime = Date.now();
        this.pulseTimer = 0;
        this.pulseScale = 1;

        switch(type) {
            case 'speed':
                this.color = '#00ff00';
                this.effect = 'speed';
                this.duration = 5000;
                break;
            case 'length':
                this.color = '#ffff00';
                this.effect = 'length';
                this.duration = 8000;
                break;
            case 'shield':
                this.color = '#00ffff';
                this.effect = 'shield';
                this.duration = 10000;
                break;
        }
    }

    update(deltaTime) {
        // 脉冲动画效果
        this.pulseTimer += deltaTime;
        this.pulseScale = 1 + Math.sin(this.pulseTimer * 0.005) * 0.2;
    }

    applyEffect(player) {
        switch (this.type) {
            case 'speed':
                // 加速效果，持续5秒
                player.applySpeedBoost(1.5, 5000);
                console.log('speed item applied');
                break;
            case 'length':
                // 增加长度
                player.addLength(100);
                console.log('length item applied');
                break;
            case 'shield':
                player.activateShield(this.duration);
                console.log('shield item applied');
                break;
        }
    }

    render(renderer) {
        renderer.ctx.save();
        
        // 应用脉冲缩放
        renderer.ctx.translate(this.x, this.y);
        renderer.ctx.scale(this.pulseScale, this.pulseScale);
        
        // 绘制道具背景
        renderer.ctx.fillStyle = this.color;
        renderer.ctx.beginPath();
        renderer.ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        renderer.ctx.fill();
        
        // 绘制道具边框
        renderer.ctx.strokeStyle = '#FFFFFF';
        renderer.ctx.lineWidth = 2;
        renderer.ctx.stroke();
        
        // 绘制道具图标
        renderer.ctx.fillStyle = '#000000';
        renderer.ctx.font = '12px Arial';
        renderer.ctx.textAlign = 'center';
        renderer.ctx.textBaseline = 'middle';
        
        let symbol = '';
        switch(this.type) {
            case 'speed':
                symbol = '⚡';
                break;
            case 'length':
                symbol = '📏';
                break;
            case 'shield':
                symbol = '🛡️';
                break;
        }

        renderer.ctx.fillText(symbol,0,0);
        
        renderer.ctx.restore();
    }
}

class Barrier {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.width = 40;
        this.height = 40;
        this.spawnTime = Date.now();
    }

    checkCollision(playerX, playerY, playerRadius) {
        // 检查圆形玩家与矩形障碍物的碰撞
        const closestX = Math.max(this.x, Math.min(playerX, this.x + this.width));
        const closestY = Math.max(this.y, Math.min(playerY, this.y + this.height));
        
        const distance = Math.sqrt(
            Math.pow(playerX - closestX, 2) + 
            Math.pow(playerY - closestY, 2)
        );
        
        return distance < playerRadius;
    }

    render(renderer) {
        renderer.ctx.save();
        
        // 绘制栏杆主体
        renderer.ctx.fillStyle = '#8B4513';
        renderer.ctx.fillRect(this.x, this.y, this.width, this.height);
        
        // 绘制栏杆纹理
        renderer.ctx.strokeStyle = '#654321';
        renderer.ctx.lineWidth = 2;
        
        // 垂直线条
        for (let i = 1; i < 4; i++) {
            const lineX = this.x + (this.width / 4) * i;
            renderer.ctx.beginPath();
            renderer.ctx.moveTo(lineX, this.y);
            renderer.ctx.lineTo(lineX, this.y + this.height);
            renderer.ctx.stroke();
        }
        
        // 水平线条
        for (let i = 1; i < 3; i++) {
            const lineY = this.y + (this.height / 3) * i;
            renderer.ctx.beginPath();
            renderer.ctx.moveTo(this.x, lineY);
            renderer.ctx.lineTo(this.x + this.width, lineY);
            renderer.ctx.stroke();
        }
        
        // 边框
        renderer.ctx.strokeStyle = '#000000';
        renderer.ctx.lineWidth = 1;
        renderer.ctx.strokeRect(this.x, this.y, this.width, this.height);
        
        renderer.ctx.restore();
    }
}

// 新增：初始栏杆类
class InitialBarrier {
    constructor(x, y, width, height) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.spawnTime = Date.now();
    }

    checkCollision(playerX, playerY, playerRadius) {
        // 检查圆形玩家与矩形障碍物的碰撞
        const closestX = Math.max(this.x, Math.min(playerX, this.x + this.width));
        const closestY = Math.max(this.y, Math.min(playerY, this.y + this.height));
        
        const distance = Math.sqrt(
            Math.pow(playerX - closestX, 2) + 
            Math.pow(playerY - closestY, 2)
        );
        
        return distance < playerRadius;
    }

    render(renderer) {
        renderer.ctx.save();
        
        // 绘制初始栏杆（使用不同的颜色以区分）
        renderer.ctx.fillStyle = '#A0522D'; // 稍微不同的棕色
        renderer.ctx.fillRect(this.x, this.y, this.width, this.height);
        
        // 绘制栏杆纹理
        renderer.ctx.strokeStyle = '#8B4513';
        renderer.ctx.lineWidth = 2;
        
        // 垂直线条
        for (let i = 1; i < 4; i++) {
            const lineX = this.x + (this.width / 4) * i;
            renderer.ctx.beginPath();
            renderer.ctx.moveTo(lineX, this.y);
            renderer.ctx.lineTo(lineX, this.y + this.height);
            renderer.ctx.stroke();
        }
        
        // 水平线条
        for (let i = 1; i < 3; i++) {
            const lineY = this.y + (this.height / 3) * i;
            renderer.ctx.beginPath();
            renderer.ctx.moveTo(this.x, lineY);
            renderer.ctx.lineTo(this.x + this.width, lineY);
            renderer.ctx.stroke();
        }
        
        // 边框
        renderer.ctx.strokeStyle = '#000000';
        renderer.ctx.lineWidth = 1;
        renderer.ctx.strokeRect(this.x, this.y, this.width, this.height);
        
        // 添加发光效果表示这是临时的
        renderer.ctx.shadowColor = '#FFD700';
        renderer.ctx.shadowBlur = 5;
        renderer.ctx.strokeStyle = '#FFD700';
        renderer.ctx.lineWidth = 1;
        renderer.ctx.strokeRect(this.x - 1, this.y - 1, this.width + 2, this.height + 2);
        
        renderer.ctx.restore();
    }
}

// 新增：护盾效果类
class ShieldEffect {
    constructor(duration) {
        this.duration = duration;
        this.startTime = Date.now();
        this.active = true;
        this.pulsePhase = 0;
    }

    update(deltaTime) {
        const elapsed = Date.now() - this.startTime;
        
        if (elapsed >= this.duration) {
            this.active = false;
            return;
        }
        
        this.pulsePhase += deltaTime * 0.01;
    }

    isActive() {
        return this.active;
    }

    getRemainingTime() {
        const elapsed = Date.now() - this.startTime;
        return Math.max(0, this.duration - elapsed);
    }

    render(renderer, playerX, playerY) {
        if (!this.active) return;
        
        renderer.ctx.save();
        
        // 护盾视觉效果
        const pulse = Math.sin(this.pulsePhase) * 0.3 + 0.7;
        const shieldRadius = 15 * pulse;
        
        // 护盾圆环
        renderer.ctx.strokeStyle = `rgba(0, 255, 255, ${pulse})`;
        renderer.ctx.lineWidth = 3;
        renderer.ctx.beginPath();
        renderer.ctx.arc(playerX, playerY, shieldRadius, 0, Math.PI * 2);
        renderer.ctx.stroke();
        
        // 内层护盾
        renderer.ctx.strokeStyle = `rgba(255, 255, 255, ${pulse * 0.5})`;
        renderer.ctx.lineWidth = 1;
        renderer.ctx.beginPath();
        renderer.ctx.arc(playerX, playerY, shieldRadius - 3, 0, Math.PI * 2);
        renderer.ctx.stroke();
        
        // 护盾粒子效果
        for (let i = 0; i < 8; i++) {
            const angle = (this.pulsePhase + i * Math.PI / 4) % (Math.PI * 2);
            const particleX = playerX + Math.cos(angle) * shieldRadius;
            const particleY = playerY + Math.sin(angle) * shieldRadius;
            
            renderer.ctx.fillStyle = `rgba(0, 255, 255, ${pulse})`;
            renderer.ctx.beginPath();
            renderer.ctx.arc(particleX, particleY, 2, 0, Math.PI * 2);
            renderer.ctx.fill();
        }
        
        renderer.ctx.restore();
    }
}