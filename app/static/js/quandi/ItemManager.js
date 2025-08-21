class ItemManager {
    isOverlappingWithFlags(x, y, radius) {
        if (!this.flagManager || !this.flagManager.flags) return false;
        for (const flag of this.flagManager.flags) {
            const dist = Math.sqrt(Math.pow(x - flag.x, 2) + Math.pow(y - flag.y, 2));
            if (dist < flag.size + radius) { // flag.size 是旗帜的半径
                return true;
            }
        }
        return false;
    }
    constructor(canvas, flagManager) {
        this.canvas = canvas;
        this.flagManager = flagManager;
        this.items = [];
        this.obstacles = [];
        this.initialBarriers = [];
        this.spawnTimer = 0;
        this.itemSpawnInterval = 2000; // 2秒生成一个道具
        this.obstacleSpawnInterval = 5000; // 5秒生成一个障碍物
        this.lastItemSpawn = 0;
        this.lastObstacleSpawn = 0;
        // 初始栏杆相关属性
        this.initialBarrierDuration = 12000; // 12秒
        this.initialBarrierStartTime = Date.now();
        this.initialBarriersCreated = false;
        this.pauseStartTime = null; // 用于记录暂停开始时间

        // 初始栏杆的创建将移至 init 方法中，以确保 flagManager 已被传入
    }

    init() {
        this.createInitialBarriers();
    }

    update(deltaTime, players, territory) {
        // 如果游戏处于暂停状态，则不更新生成计时器
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            return;
        }

        this.spawnTimer += deltaTime;

        // 检查初始栏杆是否应该消失，但在倒计时状态下不检查
        if (!(window.gameEngine && window.gameEngine.gameState === 'countdown')) {
            const currentTime = Date.now();
            if (currentTime - this.initialBarrierStartTime >= this.initialBarrierDuration) {
                if (this.initialBarriers.length > 0) {
                    this.initialBarriers = [];
                }
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
        const centerX = this.canvas.width * 0.35;
        const centerY = this.canvas.width * 0.65;
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
    }

    spawnRandomItem() {
        let x, y;
        let isValidPosition = false;
        let attempts = 0;
        const maxAttempts = 50;
        let itemForCheck;

        do {
            x = Math.random() * (this.canvas.width - 40) + 20;
            y = Math.random() * (this.canvas.height - 40) + 20;
            itemForCheck = { x: x, y: y };
            if (
                this.checkcollisionwithstartpoint(itemForCheck, 180, 300, 1020, 300, 150) === false &&
                this.isPositionBlockedBarrier(x) === false &&
                this.checkitemlastdistance(itemForCheck, this.items, 300) === false &&
                this.isOverlappingWithFlags(itemForCheck.x, itemForCheck.y, 0) === false // 检查与旗帜的重叠
            ) {
                isValidPosition = true;
            }
            attempts++;
        } while (!isValidPosition && attempts < maxAttempts);

        if (isValidPosition) {
            // 定义道具类型和对应的权重
            const itemWeights = [
                { type: 'speed', weight: 40 },   // 40% 概率
                { type: 'length', weight: 30 },  // 30% 概率
                { type: 'shield', weight: 30 }   // 30% 概率
            ];

            // 计算总权重
            const totalWeight = itemWeights.reduce((sum, item) => sum + item.weight, 0);

            // 生成随机数
            let random = Math.random() * totalWeight;

            // 根据权重选择道具类型
            let selectedType = 'speed'; // 默认值
            for (const item of itemWeights) {
                if (random < item.weight) {
                    selectedType = item.type;
                    break;
                }
                random -= item.weight;
            }

            const item = new PowerUpItem(x, y, selectedType);
            this.items.push(item);
        }
    }

    spawnRandomObstacle() {
        const clusterSize = Math.floor(Math.random() * 3) + 2; // 每个集群包含2到4个障碍物
        const orientation = Math.random() < 0.5 ? 'horizontal' : 'vertical'; // 集群方向：水平或垂直
        const spacing = 1;      // 集群内障碍物的间距
        const barrierWidth = 40;
        const barrierHeight = 40;
        const margin = 25;      // 不同集群之间的最小间距

        let attempts = 0;
        const maxAttempts = 30; // 增加尝试次数以应对更复杂的布局
        let clusterPlaced = false;

        while (!clusterPlaced && attempts < maxAttempts) {
            attempts++;
            let tempCluster = []; // 存储当前尝试的集群中所有障碍物的位置信息
            let clusterWidth, clusterHeight;

            // 根据方向计算整个集群的总宽度和高度
            if (orientation === 'horizontal') {
                clusterWidth = clusterSize * barrierWidth + (clusterSize - 1) * spacing;
                clusterHeight = barrierHeight;
            } else { // vertical
                clusterWidth = barrierWidth;
                clusterHeight = clusterSize * barrierHeight + (clusterSize - 1) * spacing;
            }

            // 确保集群不会在画布外生成
            if (clusterWidth >= this.canvas.width - 60 || clusterHeight >= this.canvas.height - 60) {
                continue; // 集群太大，跳过本次尝试
            }

            // 随机生成集群的起始（左上角）坐标
            const startX = Math.random() * (this.canvas.width - clusterWidth - 60) + 30;
            const startY = Math.random() * (this.canvas.height - clusterHeight - 60) + 30;

            // 构建临时集群，计算其中每个障碍物的位置
            for (let i = 0; i < clusterSize; i++) {
                let x, y;
                if (orientation === 'horizontal') {
                    x = startX + i * (barrierWidth + spacing);
                    y = startY;
                } else { // vertical
                    x = startX;
                    y = startY + i * (barrierHeight + spacing);
                }
                tempCluster.push({ x, y, width: barrierWidth, height: barrierHeight });
            }

            // 检查这个临时集群是否与任何现有对象重叠
            let isOverlapping = false;
            for (const newBarrier of tempCluster) {
                // 1. 检查是否与初始栏杆重叠
                if (this.isPositionBlockedBarrier(newBarrier.x)) {
                    isOverlapping = true;
                    break;
                }

                // 2. 检查是否与初始点重叠
                if (this.checkcollisionwithstartpoint(newBarrier, 180, 300, 1020, 300, 100)) {
                    isOverlapping = true;
                    break;
                }

                // 3. 检查是否与其他障碍物集群重叠（使用外边距来保证间距）
                for (const existingObstacle of this.obstacles) {
                    // AABB 碰撞检测算法（轴对齐包围盒）
                    if (newBarrier.x < existingObstacle.x + existingObstacle.width + margin &&
                        newBarrier.x + newBarrier.width + margin > existingObstacle.x &&
                        newBarrier.y < existingObstacle.y + existingObstacle.height + margin &&
                        newBarrier.y + newBarrier.height + margin > existingObstacle.y) {
                        isOverlapping = true;
                        break;
                    }
                }
                if (isOverlapping) break;

                // 4. 检查是否与旗帜重叠
                if (this.isOverlappingWithFlags(newBarrier.x, newBarrier.y, newBarrier.width / 2)) {
                    isOverlapping = true;
                    break;
                }
                if (isOverlapping) break;
            }

            // 如果没有重叠，则创建真实的障碍物对象并放置集群
            if (!isOverlapping) {
                for (const b of tempCluster) {
                    this.obstacles.push(new Barrier(b.x, b.y));
                }
                clusterPlaced = true;
            }
        }
    }


    // 检查位置是否被初始栏杆阻挡
    isPositionBlockedBarrier(x) {
        // 如果初始栏杆已消失，则不阻挡
        if (this.initialBarriers.length === 0) {
            return false;
        };

        const centerX = this.canvas.width * 0.35;
        const centerX2 = this.canvas.width * 0.65;
        const barrierarea = 50;

        // 检查是否在任一初始栏杆的X范围内
        const distanceP1 = Math.abs(x - centerX);
        const distanceP2 = Math.abs(x - centerX2);

        if (distanceP1 < barrierarea || distanceP2 < barrierarea) {
            return true;
        };
        return false;
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
            }
        }

        for (const barrier of this.initialBarriers) {
            if (barrier.checkCollision(player.x, player.y, 5)) {
                player.handleBarrierCollision(barrier);
            }
        }
        return null;
    }

    checkcollisionwithstartpoint(item, P1_startX, P1_startY, P2_startX, P2_startY, distance) {
        const distanceP1 = Math.sqrt(
            Math.pow(P1_startX - item.x, 2) +
            Math.pow(P1_startY - item.y, 2)
        );
        const distanceP2 = Math.sqrt(
            Math.pow(P2_startX - item.x, 2) +
            Math.pow(P2_startY - item.y, 2)
        );
        if (distanceP1 < distance || distanceP2 < distance) {
            return true;
        }
        return false;
    }

    checkitemlastdistance(item, items, distance) {
        if (items.length === 0) {
            return false;
        }
        const distance1 = Math.sqrt(
            Math.pow(items[items.length - 1].x - item.x, 2) +
            Math.pow(items[items.length - 1].y - item.y, 2)
        );
        if (distance1 < distance) {
            return true;
        }
        return false;
    }

        getInitialBarrierRemainingTime() {
        // 如果游戏引擎处于倒计时状态，返回完整的持续时间
        if (window.gameEngine && window.gameEngine.gameState === 'countdown') {
            return this.initialBarrierDuration;
        }
        
        // 如果游戏处于暂停状态，则不更新计时
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            return Math.max(0, this.initialBarrierDuration - (this.pauseStartTime - this.initialBarrierStartTime));
        }
        
        const currentTime = Date.now();
        const elapsed = currentTime - this.initialBarrierStartTime;
        return Math.max(0, this.initialBarrierDuration - elapsed);
    }

    hasInitialBarriers() {
        return this.initialBarriers.length > 0;
    }

    // 清理超时的道具和障碍物
    cleanup() {
        const currentTime = Date.now();

        // 清理超时道具（10秒后消失）
        this.items = this.items.filter(item =>
            currentTime - item.spawnTime < 10000
        );

        // 限制障碍物数量（最多10个集群，假设平均每个集群3个，限制到30个）
        if (this.obstacles.length > 30) {
            this.obstacles.splice(0, this.obstacles.length - 30);
        }
    }

    reset() {
        this.items = [];
        this.obstacles = [];
        this.initialBarriers = [];
        this.initialBarriersCreated = false;
        this.initialBarrierStartTime = Date.now();
        this.pauseStartTime = null; // 重置暂停开始时间
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
        this.addLength = 100;

        switch (type) {
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
        // 如果游戏处于暂停状态，则不更新计时
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            return;
        }
        
        // 脉冲动画效果
        this.pulseTimer += deltaTime;
        this.pulseScale = 1 + Math.sin(this.pulseTimer * 0.005) * 0.2;
    }

    applyEffect(player) {
        switch (this.type) {
            case 'speed':
                // 加速效果，持续5秒
                player.applySpeedBoost(1.5, 5000);
                break;
            case 'length':
                // 增加长度
                player.addLength(this.addLength);
                break;
            case 'shield':
                player.activateShield(this.duration);
                break;
        }
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
}

// 新增：初始栏杆类
class InitialBarrier {
    constructor(x, y, width, height) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.spawnTime = Date.now();
        this.duration = 12000; // 12秒，与ItemManager中的initialBarrierDuration保持一致
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
}

// 新增：护盾效果类
class ShieldEffect {
    constructor(duration) {
        this.duration = duration;
        this.startTime = Date.now();
        this.active = true;
        this.pulsePhase = 0;
        this.pauseStartTime = null; // 暂停开始时间
        this.pausedRemainingTime = null; // 暂停时的剩余时间
    }

    update(deltaTime) {
        // 如果游戏处于暂停状态，则不更新计时
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            return;
        }
        
        const currentTime = Date.now();
        // 如果有暂停时的剩余时间记录，使用它来计算已用时间
        let elapsed;
        if (this.pausedRemainingTime !== null) {
            elapsed = this.duration - this.pausedRemainingTime;
            // 清除暂停时的剩余时间记录，以便下次使用正常计算
            this.pausedRemainingTime = null;
        } else {
            elapsed = currentTime - this.startTime;
        }

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
        // 如果有暂停时的剩余时间记录，直接返回它
        if (this.pausedRemainingTime !== null) {
            return this.pausedRemainingTime;
        }
        const elapsed = Date.now() - this.startTime;
        const remaining = Math.max(0, this.duration - elapsed);
        return remaining;
    }
}