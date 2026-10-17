// Adapted from yao1145/quandiyundong @ b1050bd177fa9764afd039f2ec6e68af55137436.
// 原作者授权及本地修改说明见 public/static/quandi/NOTICE.txt。
/**
 * ServerEngine — 服务端权威游戏引擎
 * 从客户端 GameEngine 提取纯游戏逻辑，去除 DOM/Canvas 依赖
 * 通过 setInterval 驱动，接收网络输入，输出状态快照
 */

import SERVER_CONFIG from './config.js';
import { TerritoryGrid } from '../../../../shared/quandi/territory-grid';
import { ServerSurvivalManager } from './ServerSurvivalManager.js';
import { ServerFlagManager } from './ServerFlagManager.js';
import ServerDayNightManager from './ServerDayNightManager.js';

const ANTI_CHEAT = SERVER_CONFIG.ANTI_CHEAT;

const CONFIG = {
    CANVAS_WIDTH: 1200,
    CANVAS_HEIGHT: 600,

    DIFFICULTY: {
        slow: { speed: 2.5, maxTime: 120000, Length: 400 },
        medium: { speed: 3.5, maxTime: 100000, Length: 350 },
        fast: { speed: 4, maxTime: 80000, Length: 300 },
        ultra: { speed: 6, maxTime: 80000, Length: 250 }
    },

    LIVES: {
        explore: 1, fight: 3, infinite: 2, survival: 3, capture: 1, daynight: 3
    },

    PLAYER_DEFAULTS: {
        size: 8,
        locktime: 5000,
        addlocktime: 2000,
        homeTimeLimit: 15000,
        standarddistance: 2,
        pushdistance: 6,
        deathshieldtime: 3000
    },

    SPAWN_POINTS: [
        { x: 0.15, y: 0.5 },
        { x: 0.85, y: 0.5 },
        { x: 0.5, y: 0.15 },
        { x: 0.5, y: 0.85 }
    ],

    ITEM: {
        itemSpawnInterval: 2000,
        obstacleSpawnInterval: 5000,
        initialBarrierDuration: 12000,
        itemTimeout: 10000,
        maxObstacles: 30,
        powerUp: {
            radius: 15,
            speed: { color: '#00ff00', duration: 5000, weight: 40 },
            length: { color: '#ffff00', duration: 8000, addLength: 100, weight: 30 },
            shield: { color: '#00ffff', duration: 10000, weight: 30 }
        },
        barrier: { width: 40, height: 40 }
    }
};

// ─── ServerPlayer ────────────────────────────────────────────
class ServerPlayer {
    constructor(id, startX, startY, color, slotIndex, name) {
        this.id = id;
        this.name = name || '玩家';
        this.startX = startX;
        this.startY = startY;
        this.x = startX;
        this.y = startY;
        this.color = color;
        this.slotIndex = slotIndex;
        this.size = CONFIG.PLAYER_DEFAULTS.size;
        this.speed = 3.5;
        this.trailLength = 350;
        this.standarddistance = CONFIG.PLAYER_DEFAULTS.standarddistance;

        this.trail = [];
        this.isAlive = true;
        this.lives = 3;
        this.score = 0;
        this.direction = { x: 0, y: 0 };
        this.isMoving = false;
        this.shield = null;
        this.speedMultiplier = 1;
        this.speedBoostEndTime = null;
        this.lockTime = null;
        this.locktime = CONFIG.PLAYER_DEFAULTS.locktime;
        this.homeStartTime = null;
        this.isAtHome = true;
        this.homeTimeLimit = CONFIG.PLAYER_DEFAULTS.homeTimeLimit;
        this.lastDeathReason = '';
        this.lastInputAt = 0;
        this.lastProcessedSeq = 0;      // 服务器最后处理的输入序号（用于客户端和解）
        this.lastValidX = startX;       // 上次有效位置（用于反作弊回滚）
        this.lastValidY = startY;
        // 反作弊
        this.violationCount = 0;
        this.violationResetTime = Date.now();
        this.inputCount = 0;
        this.inputWindowStart = Date.now();
    }

    setDirection(dx, dy, inputSeq) {
        if (this.lockTime && Date.now() < this.lockTime) return;
        if (!this.isAlive) return;
        // 值域校验：方向分量必须在 [-1, 1] 范围内
        if (dx > 1 || dx < -1 || dy > 1 || dy < -1) return;
        // 归一化方向向量：避免斜向（如 {1,1}）速度是直向的 √2 倍，使 8 方向移动速度一致
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
            dx /= len;
            dy /= len;
        }
        this.direction.x = dx;
        this.direction.y = dy;
        this.isMoving = (len > 0);
        if (inputSeq !== undefined) {
            this.lastProcessedSeq = inputSeq;
        }
    }

    fixedUpdate(deltaTime) {
        if (this.lockTime && Date.now() < this.lockTime) return;
        if (!this.isAlive) return;

        // Speed boost expiry
        if (this.speedBoostEndTime && Date.now() > this.speedBoostEndTime) {
            this.speedMultiplier = 1;
            this.speedBoostEndTime = null;
        }

        // Shield update
        if (this.shield) {
            this.shield.remaining -= deltaTime;
            if (this.shield.remaining <= 0) {
                this.shield = null;
            }
        }

        const currentSpeed = this.speed * (this.speedMultiplier || 1);
        const preX = this.x;
        const preY = this.y;

        if (this.trail.length === 0) {
            this.trail.push({ x: this.x, y: this.y, timestamp: Date.now() });
        }

        if (this.direction.x !== 0 || this.direction.y !== 0) {
            const deltaSeconds = deltaTime / 1000;
            const displacement = currentSpeed * deltaSeconds * 60;

            const prevX = this.x;
            const prevY = this.y;

            this.x += this.direction.x * displacement;
            this.y += this.direction.y * displacement;

            // Boundary clamp
            this.x = Math.max(this.size, Math.min(CONFIG.CANVAS_WIDTH - this.size, this.x));
            this.y = Math.max(this.size, Math.min(CONFIG.CANVAS_HEIGHT - this.size, this.y));

            // Trail interpolation
            const lastPos = this.trail[this.trail.length - 1] || { x: prevX, y: prevY };
            let dx = this.x - lastPos.x;
            let dy = this.y - lastPos.y;
            let dist = Math.sqrt(dx * dx + dy * dy);

            while (dist >= this.standarddistance) {
                const ratio = this.standarddistance / dist;
                const newX = lastPos.x + dx * ratio;
                const newY = lastPos.y + dy * ratio;
                this.trail.push({ x: newX, y: newY, timestamp: Date.now() });

                dx = this.x - newX;
                dy = this.y - newY;
                dist = Math.sqrt(dx * dx + dy * dy);
                lastPos.x = newX;
                lastPos.y = newY;

                if (this.trail.length > this.trailLength) {
                    this.trail.shift();
                }
            }

            // ─── 反作弊：速度校验 ─────────────────────────
            if (ANTI_CHEAT.ENABLE_SPEED_CHECK && (this.direction.x !== 0 || this.direction.y !== 0)) {
                const dirMag = Math.sqrt(this.direction.x * this.direction.x + this.direction.y * this.direction.y);
                const maxDisplacement = displacement * dirMag * ANTI_CHEAT.SPEED_TOLERANCE + 0.1; // 0.1px 浮点容差
                const actualDisplacement = Math.sqrt(
                    (this.x - preX) ** 2 + (this.y - preY) ** 2
                );
                if (actualDisplacement > maxDisplacement) {
                    // 回滚到上个有效位置
                    this.x = this.lastValidX;
                    this.y = this.lastValidY;
                    return { violated: true, reason: 'speed', displacement: actualDisplacement, max: maxDisplacement };
                }
            }

            // 记录有效位置
            this.lastValidX = this.x;
            this.lastValidY = this.y;
        }

        // ─── 反作弊：边界校验 ─────────────────────────────
        if (ANTI_CHEAT.ENABLE_BOUNDARY_CHECK) {
            if (this.x < 0 || this.x > CONFIG.CANVAS_WIDTH || this.y < 0 || this.y > CONFIG.CANVAS_HEIGHT) {
                this.x = Math.max(this.size, Math.min(CONFIG.CANVAS_WIDTH - this.size, this.x));
                this.y = Math.max(this.size, Math.min(CONFIG.CANVAS_HEIGHT - this.size, this.y));
                return { violated: true, reason: 'boundary' };
            }
        }

        // Home countdown for capture mode
        // (simplified for Phase 1 — full implementation in Phase 2)

        // 同步 x/y 到轨迹最前端
        if (this.trail.length > 0) {
            const front = this.trail[this.trail.length - 1];
            this.x = front.x;
            this.y = front.y;
        }

        return null; // 无违例
    }

    die(reason, gameMode) {
        this.lastDeathReason = reason;
        this.lives--;
        if (this.lives > 0) {
            if (gameMode === 'infinite') {
                this.lives = 2;
                this.diereset(this.startX, this.startY, gameMode);
            } else if (gameMode === 'fight' || gameMode === 'survival' || gameMode === 'daynight') {
                this.diereset(this.startX, this.startY, gameMode);
            } else {
                this.isAlive = false;
            }
        } else {
            this.isAlive = false;
        }
        return { died: true, lives: this.lives, isAlive: this.isAlive };
    }

    diereset(x, y, gameMode) {
        this.x = x;
        this.y = y;
        this.trail = [];
        this.isAlive = true;
        this.direction = { x: 0, y: 0 };
        this.isMoving = false;
        this.shield = null;
        this.speedMultiplier = 1;
        this.speedBoostEndTime = null;

        // 在无限模式下添加封锁时间
        if (gameMode === 'infinite') {
            this.lockTime = Date.now() + this.locktime;
            this.locktime += CONFIG.PLAYER_DEFAULTS.addlocktime;
        }
    }

    applySpeedBoost(multiplier, duration) {
        this.speedMultiplier = multiplier;
        this.speedBoostEndTime = Date.now() + duration;
    }

    addLength(amount) {
        this.trailLength = Math.min(1000, this.trailLength + amount);
    }

    activateShield(duration) {
        this.shield = { remaining: duration, active: true };
    }

    hasShield() {
        return this.shield && this.shield.active && this.shield.remaining > 0;
    }

    canEnterEnemyTerritory() {
        return this.hasShield();
    }

    checkIfAtHome() {
        const dist = Math.sqrt(Math.pow(this.x - this.startX, 2) + Math.pow(this.y - this.startY, 2));
        return dist <= 20;
    }

    // 夺旗模式：开始离家倒计时
    startHomeCountdown() {
        if (this.isAtHome && !this.homeStartTime) {
            this.homeStartTime = Date.now();
            this.isAtHome = false;
        }
    }

    // 夺旗模式：重置回家倒计时
    resetHomeCountdown() {
        this.homeStartTime = null;
        this.isAtHome = true;
    }

    // 夺旗模式：检查是否超时未回家
    isHomeCountdownExpired() {
        if (!this.homeStartTime || this.isAtHome) return false;
        return Date.now() - this.homeStartTime >= this.homeTimeLimit;
    }

    // 夺旗模式：获取回家剩余秒数
    getHomeCountdownRemaining() {
        if (!this.homeStartTime || this.isAtHome) return 0;
        const elapsed = Date.now() - this.homeStartTime;
        return Math.max(0, Math.ceil((this.homeTimeLimit - elapsed) / 1000));
    }

    serialize() {
        // 发送完整轨迹（最后 400 点），确保客户端能正确渲染
        // 每 3 tick (~50ms) 广播一次，400 点覆盖约 3-4 秒移动
        const trailSlice = this.trail.slice(-400);

        return {
            id: this.id,
            name: this.name,
            x: Math.round(this.x * 100) / 100,
            y: Math.round(this.y * 100) / 100,
            color: this.color,
            slotIndex: this.slotIndex,
            direction: { x: this.direction.x, y: this.direction.y },
            isAlive: this.isAlive,
            lives: this.lives,
            score: Math.round(this.score * 10) / 10,
            trail: trailSlice,                    // 完整轨迹切片（客户端直接替换）
            trailMaxLength: this.trailLength,      // 最大轨迹长度
            hasShield: this.hasShield(),
            shieldRemaining: this.shield ? Math.ceil(this.shield.remaining / 1000) : 0,
            speedActive: this.speedMultiplier > 1,
            speedRemaining: this.speedBoostEndTime ? Math.max(0, Math.ceil((this.speedBoostEndTime - Date.now()) / 1000)) : 0,
            lockTime: this.lockTime ? Math.max(0, Math.ceil((this.lockTime - Date.now()) / 1000)) : 0,
            homeTimeRemaining: this.getHomeCountdownRemaining ? this.getHomeCountdownRemaining() : 0,
            lastProcessedInputSeq: this.lastProcessedSeq || 0
        };
    }
}

// ─── ServerTerritory ─────────────────────────────────────────
class ServerTerritory {
    constructor() {
        this.areas = new Map();
        this.scoreGrid = new TerritoryGrid();
        this.vertexCount = 0; // playerId → polygon[]
        this.maxArea = CONFIG.CANVAS_WIDTH * CONFIG.CANVAS_HEIGHT * 0.95;
    }

    calculateSignedArea(polygon) {
        let area = 0;
        for (let i = 0; i < polygon.length; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length];
            area += (p1.x * p2.y - p2.x * p1.y);
        }
        return area / 2;
    }

    detectEnclosure(player) {
        if (player.trail.length < 20) return null;

        const startArea = { x: player.startX, y: player.startY };
        // 使用轨迹最前端（最后一个采样点）判断闭合，而非 player.x/y
        const currentPos = player.trail[player.trail.length - 1];
        const distanceToStart = Math.sqrt(
            Math.pow(startArea.x - currentPos.x, 2) + Math.pow(startArea.y - currentPos.y, 2)
        );

        if (distanceToStart < 20) {
            const area = [...player.trail, startArea];
            const windingorder = this.calculateSignedArea(area);
            let clockwisearea = area;
            if (windingorder > 0) {
                clockwisearea = [...area].reverse();
            }
            this.addTerritory(player.id, clockwisearea);
            player.trail = [];
            return area;
        }
        return null;
    }

    addTerritory(playerId, area) {
        if (!this.areas.has(playerId)) {
            this.areas.set(playerId, []);
        }
        // 闭合点常与首点重复；先去重，避免把同一个转角的两个副本一起删掉。
        area = area.filter((p, i) => i === 0 || p.x !== area[i - 1].x || p.y !== area[i - 1].y);
        if (area.length > 1 && area[0].x === area[area.length - 1].x && area[0].y === area[area.length - 1].y) area.pop();
        // 只移除同向直线中间点，保留转折与折返的形状。
        area = area.filter((p, i) => {
            const a = area[(i + area.length - 1) % area.length], b = area[(i + 1) % area.length];
            return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 0.00001
                || (p.x - a.x) * (b.x - p.x) + (p.y - a.y) * (b.y - p.y) < 0;
        });
        if (area.length < 3) return;
        if (this.areas.get(playerId).length >= 128 || this.vertexCount + area.length > 8192) {
            throw new Error('territory_limit');
        }
        this.vertexCount += area.length;
        this.areas.get(playerId).push(area);
        this.scoreGrid.add(playerId, area);
    }

    getPlayerTerritories(playerId) {
        return this.areas.get(playerId) || [];
    }

    // Simplified score calculation for server (grid-based sampling)
    // Uses a coarse grid instead of canvas pixel sampling
    calculateScore(playerId) { return this.scoreGrid.score(playerId); }

    _isPointInPolygon(point, polygon) {
        let windingNumber = 0;
        for (let i = 0; i < polygon.length; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length];
            if (p1.y <= point.y) {
                if (p2.y > point.y) {
                    const isLeft = (p2.x - p1.x) * (point.y - p1.y) - (point.x - p1.x) * (p2.y - p1.y);
                    if (isLeft > 0) windingNumber++;
                }
            } else {
                if (p2.y <= point.y) {
                    const isLeft = (p2.x - p1.x) * (point.y - p1.y) - (point.x - p1.x) * (p2.y - p1.y);
                    if (isLeft < 0) windingNumber--;
                }
            }
        }
        return windingNumber !== 0;
    }

    serialize() {
        const result = {};
        for (const [playerId, territories] of this.areas) {
            result[playerId] = territories.map(t =>
                t.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
            );
        }
        return result;
    }

    reset() {
        this.areas.clear();
        this.scoreGrid.clear();
        this.vertexCount = 0;
    }
}

// ─── ServerItemManager ───────────────────────────────────────
class ServerItemManager {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.items = [];
        this.obstacles = [];
        this.initialBarriers = [];
        this.spawnTimer = 0;
        this.lastItemSpawn = 0;
        this.lastObstacleSpawn = 0;
        this.initialBarrierStartTime = Date.now();
        this.initialBarriersCreated = false;
        this._createInitialBarriers();
    }

    _createInitialBarriers() {
        if (this.initialBarriersCreated) return;
        const barrierWidth = 40, barrierHeight = 40;
        const centerX1 = this.width * 0.35;
        const centerX2 = this.width * 0.65;

        for (let y = 0; y < this.height; y += barrierHeight) {
            this.initialBarriers.push({
                x: centerX1 - barrierWidth / 2, y, width: barrierWidth, height: barrierHeight
            });
            this.initialBarriers.push({
                x: centerX2 - barrierWidth / 2, y, width: barrierWidth, height: barrierHeight
            });
        }
        this.initialBarriersCreated = true;
    }

    update(deltaTime) {
        this.spawnTimer += deltaTime;

        // Remove initial barriers after duration
        if (Date.now() - this.initialBarrierStartTime >= CONFIG.ITEM.initialBarrierDuration) {
            this.initialBarriers = [];
        }

        // Spawn items
        if (this.spawnTimer - this.lastItemSpawn > CONFIG.ITEM.itemSpawnInterval) {
            this._spawnRandomItem();
            this.lastItemSpawn = this.spawnTimer;
        }

        // Spawn obstacles
        if (this.spawnTimer - this.lastObstacleSpawn > CONFIG.ITEM.obstacleSpawnInterval) {
            this._spawnRandomObstacle();
            this.lastObstacleSpawn = this.spawnTimer;
        }
    }

    _spawnRandomItem() {
        let attempts = 0;
        while (attempts < 50) {
            const x = Math.random() * (this.width - 40) + 20;
            const y = Math.random() * (this.height - 40) + 20;

            // Check distance from spawn points
            const distP1 = Math.sqrt(Math.pow(180 - x, 2) + Math.pow(300 - y, 2));
            const distP2 = Math.sqrt(Math.pow(1020 - x, 2) + Math.pow(300 - y, 2));
            if (distP1 < 150 || distP2 < 150) { attempts++; continue; }

            // Check barrier overlap
            const blocked = this.initialBarriers.some(b =>
                Math.abs(x - (b.x + b.width / 2)) < 60
            );
            if (blocked) { attempts++; continue; }

            const types = ['speed', 'length', 'shield'];
            const weights = [40, 30, 30];
            const totalW = weights.reduce((a, b) => a + b, 0);
            let r = Math.random() * totalW;
            let type = types[0];
            for (let i = 0; i < types.length; i++) {
                if (r < weights[i]) { type = types[i]; break; }
                r -= weights[i];
            }

            this.items.push({
                id: `item_${Date.now()}_${Math.random()}`,
                x, y, type,
                radius: CONFIG.ITEM.powerUp.radius,
                spawnTime: Date.now()
            });
            return;
        }
    }

    _spawnRandomObstacle() {
        const clusterSize = Math.floor(Math.random() * 3) + 2;
        const barrierWidth = 40, barrierHeight = 40;
        let attempts = 0;
        while (attempts < 30) {
            const startX = Math.random() * (this.width - 200) + 30;
            const startY = Math.random() * (this.height - 200) + 30;
            const orientation = Math.random() < 0.5 ? 'horizontal' : 'vertical';

            let valid = true;
            const cluster = [];
            for (let i = 0; i < clusterSize; i++) {
                const bx = orientation === 'horizontal' ? startX + i * (barrierWidth + 1) : startX;
                const by = orientation === 'vertical' ? startY + i * (barrierHeight + 1) : startY;

                const distP1 = Math.sqrt(Math.pow(180 - bx, 2) + Math.pow(300 - by, 2));
                const distP2 = Math.sqrt(Math.pow(1020 - bx, 2) + Math.pow(300 - by, 2));
                if (distP1 < 100 || distP2 < 100) { valid = false; break; }

                const blocked = this.initialBarriers.some(b =>
                    bx < b.x + b.width + 25 && bx + barrierWidth + 25 > b.x &&
                    by < b.y + b.height + 25 && by + barrierHeight + 25 > b.y
                );
                if (blocked) { valid = false; break; }

                cluster.push({ x: bx, y: by, width: barrierWidth, height: barrierHeight });
            }

            if (valid && cluster.length > 0) {
                for (const b of cluster) {
                    this.obstacles.push(b);
                }
                return;
            }
            attempts++;
        }
    }

    checkItemCollision(player) {
        for (let i = this.items.length - 1; i >= 0; i--) {
            const item = this.items[i];
            const dist = Math.sqrt(Math.pow(player.x - item.x, 2) + Math.pow(player.y - item.y, 2));
            if (dist < item.radius + 5) {
                this._applyItem(item, player);
                this.items.splice(i, 1);
                return { collected: true, type: item.type };
            }
        }
        return null;
    }

    _applyItem(item, player) {
        switch (item.type) {
            case 'speed':
                player.applySpeedBoost(1.5, CONFIG.ITEM.powerUp.speed.duration);
                break;
            case 'length':
                player.addLength(CONFIG.ITEM.powerUp.length.addLength);
                break;
            case 'shield':
                player.activateShield(CONFIG.ITEM.powerUp.shield.duration);
                break;
        }
    }

    checkObstacleCollision(player) {
        const allObstacles = [...this.obstacles, ...this.initialBarriers];
        for (const obs of allObstacles) {
            const closestX = Math.max(obs.x, Math.min(player.x, obs.x + obs.width));
            const closestY = Math.max(obs.y, Math.min(player.y, obs.y + obs.height));
            const dist = Math.sqrt(Math.pow(player.x - closestX, 2) + Math.pow(player.y - closestY, 2));
            if (dist < CONFIG.PLAYER_DEFAULTS.pushdistance) {
                // Push player out — need enough distance to prevent immediate re-entry
                // Player moves ~speed*60*16/1000 pixels per tick. Push at least 3 ticks worth.
                const centerX = obs.x + obs.width / 2;
                const centerY = obs.y + obs.height / 2;
                const dx = player.x - centerX;
                const dy = player.y - centerY;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                const safeDist = Math.max(obs.width, obs.height) / 2 + player.speed * 3 + CONFIG.PLAYER_DEFAULTS.pushdistance + 2;
                player.x = centerX + (dx / len) * safeDist;
                player.y = centerY + (dy / len) * safeDist;
                player.x = Math.max(player.size, Math.min(this.width - player.size, player.x));
                player.y = Math.max(player.size, Math.min(this.height - player.size, player.y));
            }
        }
    }

    cleanup() {
        const now = Date.now();
        this.items = this.items.filter(i => now - i.spawnTime < CONFIG.ITEM.itemTimeout);
        if (this.obstacles.length > CONFIG.ITEM.maxObstacles) {
            this.obstacles.splice(0, this.obstacles.length - CONFIG.ITEM.maxObstacles);
        }
    }

    serialize() {
        return {
            items: this.items.map(i => ({
                id: i.id, type: i.type, x: Math.round(i.x), y: Math.round(i.y)
            })),
            obstacles: this.obstacles.map(o => ({
                x: Math.round(o.x), y: Math.round(o.y), w: o.width, h: o.height
            })),
            initialBarriers: this.initialBarriers.length > 0 ? this.initialBarriers.map(b => ({
                x: Math.round(b.x), y: Math.round(b.y), w: b.width, h: b.height
            })) : []
        };
    }

    reset() {
        this.items = [];
        this.obstacles = [];
        this.initialBarriers = [];
        this.initialBarriersCreated = false;
        this.initialBarrierStartTime = Date.now();
        this._createInitialBarriers();
    }
}

// ─── ServerEngine ────────────────────────────────────────────
class ServerEngine {
    constructor(room) {
        this.room = room;
        this.width = CONFIG.CANVAS_WIDTH;
        this.height = CONFIG.CANVAS_HEIGHT;
        this.gameMode = room.gameConfig.mode;
        this.difficulty = room.gameConfig.difficulty;

        // Players
        this.players = [];
        this.playerMap = new Map(); // playerId → ServerPlayer

        // Game state
        this.gameTime = 0;
        this.maxGameTime = CONFIG.DIFFICULTY[this.difficulty].maxTime;
        this.gameState = 'countdown'; // countdown → playing → finished
        this.countdown = 3;
        this.frameCount = 0;
        this.timer = 0;

        // Territory & Items
        this.territory = new ServerTerritory();
        this.itemManager = new ServerItemManager(this.width, this.height);

        // Mode managers
        this.survivalManager = null;
        this.flagManager = null;
        this.dayNightManager = null;

        if (this.gameMode === 'survival') {
            this.survivalManager = new ServerSurvivalManager(this.width, this.height);
            this.survivalManager.init(this.difficulty);
        } else if (this.gameMode === 'capture') {
            this.flagManager = new ServerFlagManager(this.width, this.height);

        } else if (this.gameMode === 'daynight') {
            this.dayNightManager = new ServerDayNightManager();
        }

        // Input queue
        this.inputQueue = new Map(); // playerId → { direction, isMoving }

        // Callbacks
        this.onStateSnapshot = null;
        this.onGameEvent = null;
        this.onGameEnd = null;

        // Tick
        this.tickInterval = null;
        this.lastTick = 0;
        this.broadcastTimer = 0;

        // Delta 压缩状态
        this.lastBroadcastState = null;
        this._lastTerrHash = '';
        this._lastItemHash = '';
        this._lastModeHash = '';

        // Difficulty config
        const diff = CONFIG.DIFFICULTY[this.difficulty];
        this.playerSpeed = diff.speed;
        this.playerTrailLength = diff.Length;
        this.lives = CONFIG.LIVES[this.gameMode] || 3;

        // Initialize players from room
        const roomPlayers = room.getPlayers();
        roomPlayers.forEach((rp, idx) => {
            const spawn = CONFIG.SPAWN_POINTS[idx] || CONFIG.SPAWN_POINTS[0];
            const player = new ServerPlayer(
                rp.playerId,
                spawn.x * this.width,
                spawn.y * this.height,
                rp.color,
                idx,
                rp.name
            );
            player.speed = this.playerSpeed;
            player.trailLength = this.playerTrailLength;
            player.lives = this.lives;
            this.players.push(player);
            this.playerMap.set(rp.playerId, player);
        });
        this.flagManager?.init(this.players);
    }

    start(onSnapshot, onEvent, onEnd, onError) {
        this.onStateSnapshot = onSnapshot;
        this.onGameEvent = onEvent;
        this.onGameEnd = onEnd;

        this.lastTick = Date.now();
        this.broadcastTimer = 0;

        // Start game loop: use a slightly longer interval to ensure reliable accumulator
        this.tickInterval = setInterval(() => {
            try { this.tick(); }
            catch { this.stop(); onError(); }
        }, 16);
        this.tickInterval.unref?.();
        this.broadcastState(); // ~60Hz, but use integer for reliable scheduling
    }

    stop() {
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
    }

    onPlayerInput(playerId, data) {
        const player = this.playerMap.get(playerId);
        if (!player) return;
        player.lastInputAt = Date.now();
        this.inputQueue.set(playerId, {
            direction: data.direction || { x: 0, y: 0 },
            isMoving: data.isMoving || false,
            seq: data.seq || 0
        });
    }

    tick() {
        const now = Date.now();
        const frameTime = Math.min(now - this.lastTick, 250);
        this.lastTick = now;

        // ─── Countdown phase ──────────────────────────────
        if (this.gameState === 'countdown') {
            this.countdown -= frameTime / 1000;
            if (this.countdown <= 0) {
                this.gameState = 'playing';
                this.itemManager.initialBarrierStartTime = Date.now();
                // Send first state immediately so client syncs
                this.broadcastState();
            }
            return;
        }

        if (this.gameState !== 'playing') return;

        // ─── Playing phase ────────────────────────────────
        // Run one physics update per tick (fixed 16ms step)
        this.fixedUpdate(16);
        this.frameCount++;

        // Broadcast state at ~20Hz (every 3 ticks)
        this.broadcastTimer++;
        if (this.broadcastTimer >= 3) {
            this.broadcastTimer = 0;
            this.broadcastState();
        }
    }

    fixedUpdate(deltaTime) {
        this.timer++;
        this.gameTime += deltaTime;

        // Time limit check (except infinite mode)
        if (this.gameMode !== 'infinite' && this.gameTime >= this.maxGameTime) {
            this.endGame();
            return;
        }

        // Apply inputs
        for (const [playerId, input] of this.inputQueue) {
            const player = this.playerMap.get(playerId);
            if (!player) continue;

            // ─── 反作弊：输入频率限制 (L1) ─────────────
            const now = Date.now();
            if (ANTI_CHEAT.ENABLE_INPUT_VALIDATION) {
                if (!player.inputWindowStart || now - player.inputWindowStart > 1000) {
                    player.inputWindowStart = now;
                    player.inputCount = 0;
                }
                player.inputCount++;
                if (player.inputCount > ANTI_CHEAT.MAX_INPUT_RATE) {
                    continue; // 丢弃多余输入
                }
            }

            // ─── 反作弊：状态校验 (L2) ─────────────────
            if (!player.isAlive) continue;
            if (player.lockTime && now < player.lockTime) continue;

            player.setDirection(input.direction.x, input.direction.y, input.seq);
        }
        this.inputQueue.clear();

        // 没收到持续输入就停止，切后台、失焦与网络静默都不会持续跑动。
        for (const player of this.players) {
            if (Date.now() - player.lastInputAt > 300) {
                player.direction = { x: 0, y: 0 };
                player.isMoving = false;
            }
        }
        // Mode-specific updates
        if (this.gameMode === 'survival' && this.survivalManager) {
            this.survivalManager.update(deltaTime, this.players, this.territory,
                this.itemManager.obstacles, this.itemManager.initialBarriers);
        } else if (this.gameMode === 'daynight' && this.dayNightManager) {
            this.dayNightManager.update(deltaTime);
        }

        // Item manager update
        this.itemManager.update(deltaTime);

        // Player updates
        for (const player of this.players) {
            const violation = player.fixedUpdate(deltaTime);

            // ─── 反作弊：违例处理 ──────────────────────
            if (violation && violation.violated) {
                // 重置违例计数窗口
                if (Date.now() - player.violationResetTime > ANTI_CHEAT.VIOLATION_WINDOW) {
                    player.violationCount = 0;
                    player.violationResetTime = Date.now();
                }
                player.violationCount++;
                console.warn(`[反作弊] ${player.id.slice(0, 8)} ${violation.reason} (${player.violationCount}/${ANTI_CHEAT.MAX_VIOLATIONS})`);
                if (player.violationCount >= ANTI_CHEAT.MAX_VIOLATIONS) {
                    this.kickPlayer(player.id, violation.reason);
                    continue;
                }
            }

            // Check item collisions
            const itemResult = this.itemManager.checkItemCollision(player);
            if (itemResult) {
                this.onGameEvent?.({
                    type: 'ITEM_COLLECTED',
                    playerId: player.id,
                    itemType: itemResult.type
                });
            }

            // Check obstacle collisions
            this.itemManager.checkObstacleCollision(player);
        }

        // Collision detection
        this.checkCollisions();

        // 夺旗模式：回家倒计时（与客户端 Player.fixedUpdate 一致）
        if (this.gameMode === 'capture') {
            for (const player of this.players) {
                if (!player.isAlive) continue;
                const currentlyAtHome = player.checkIfAtHome();
                if (currentlyAtHome && !player.isAtHome) {
                    player.resetHomeCountdown();
                } else if (!currentlyAtHome && player.isAtHome) {
                    player.startHomeCountdown();
                }
                if (player.isHomeCountdownExpired()) {
                    player.lives--;
                    if (player.lives > 0) {
                        player.x = player.startX;
                        player.y = player.startY;
                        player.trail = [];
                        player.direction = { x: 0, y: 0 };
                        player.isMoving = false;
                        player.resetHomeCountdown();
                        this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: player.id, reason: '未及时回到出生点' });
                    } else {
                        player.isAlive = false;
                        this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: player.id, reason: '未及时回到出生点' });
                    }
                }
            }
        }

        // Territory detection
        for (const player of this.players) {
            const newTerritory = this.territory.detectEnclosure(player);
            if (newTerritory) {
                player.score = this.territory.calculateScore(player.id);
                this.onGameEvent?.({
                    type: 'TERRITORY_CAPTURED',
                    playerId: player.id,
                    score: player.score
                });

                // Capture mode: 检查旗帜归属
                if (this.gameMode === 'capture' && this.flagManager) {
                    const capturedFlags = this.flagManager.checkCaptureInNewTerritory(newTerritory, player.id);
                    for (const cf of capturedFlags) {
                        this.onGameEvent?.({
                            type: 'FLAG_CAPTURED',
                            playerId: player.id,
                            flagX: cf.x,
                            flagY: cf.y
                        });
                    }
                }

                if (this.gameMode === 'infinite' && player.score >= 60) {
                    this.endGame();
                    return;
                }
            }
        }

        // Survival mode: collision checks
        if (this.gameMode === 'survival' && this.survivalManager) {
            this.survivalManager.checkPlayerCollisions(this.players);
            this.survivalManager.checkAICollisions();
        }

        // Item cleanup
        this.itemManager.cleanup();

        // Check game over
        const alivePlayers = this.players.filter(p => p.isAlive);
        if (alivePlayers.length <= 1 && this.gameTime > 2000) {
            this.endGame();
        }
    }

    checkCollisions() {
        for (let i = 0; i < this.players.length; i++) {
            const player = this.players[i];
            if (!player.isAlive) continue;

            for (let j = 0; j < this.players.length; j++) {
                if (i === j) continue;
                const other = this.players[j];

                // Head-on collision
                const headDist = Math.sqrt(
                    Math.pow(player.x - other.x, 2) + Math.pow(player.y - other.y, 2)
                );
                if (headDist < player.size + other.size && other.isAlive) {
                    if (this.gameMode === 'explore' || this.gameMode === 'capture') {
                        player.die('头部碰撞', this.gameMode);
                        other.die('头部碰撞', this.gameMode);
                        this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: player.id, reason: '头部碰撞' });
                        this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: other.id, reason: '头部碰撞' });
                        break;
                    } else if (this.gameMode === 'fight' || this.gameMode === 'infinite' || this.gameMode === 'daynight') {
                        player.die('头部碰撞', this.gameMode);
                        other.die('头部碰撞', this.gameMode);
                        this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: player.id, reason: '头部碰撞' });
                        this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: other.id, reason: '头部碰撞' });
                        break;
                    }
                }

                // Trail collision
                for (const point of other.trail) {
                    const dist = Math.sqrt(
                        Math.pow(player.x - point.x, 2) + Math.pow(player.y - point.y, 2)
                    );
                    if (dist < player.size) {
                        if (this.gameMode === 'explore' || this.gameMode === 'capture') {
                            // explore/capture: 碰到轨迹的人死亡
                            player.die('碰到轨迹', this.gameMode);
                            this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: player.id, reason: '碰到轨迹' });
                            break;
                        } else if (this.gameMode === 'fight' || this.gameMode === 'infinite' || this.gameMode === 'daynight') {
                            other.die('轨迹被碰', this.gameMode);
                            this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: other.id, reason: '轨迹被碰' });
                            break;
                        }
                    }
                }

                // Territory collision
                const otherTerritories = this.territory.getPlayerTerritories(other.id);
                if (!player.canEnterEnemyTerritory() && otherTerritories.length > 0) {
                    if (this._checkTerritoryCollision(player, otherTerritories)) {
                        player.die('进入敌方领土', this.gameMode);
                        this.onGameEvent?.({ type: 'PLAYER_DIED', playerId: player.id, reason: '进入敌方领土' });
                        break;
                    }
                }
            }
        }
    }

    _checkTerritoryCollision(player, territories) {
        const point = { x: player.x, y: player.y };
        for (const territory of territories) {
            if (this.territory._isPointInPolygon(point, territory)) {
                return true;
            }
        }
        return false;
    }

    endGame(forfeitPlayerId = null) {
        this.gameState = 'finished';
        this.stop();

        let scores = this.players.map(p => ({
            id: p.id,
            score: this.territory.calculateScore(p.id),
            isAlive: p.isAlive,
            lives: p.lives
        }));

        let winner;
        let extraData = {};

        if (forfeitPlayerId) {
            const forfeitPlayer = scores.find(s => s.id === forfeitPlayerId);
            if (forfeitPlayer) {
                forfeitPlayer.isAlive = false;
                forfeitPlayer.forfeit = true;
            }
            const remainingPlayers = scores.filter(s => s.id !== forfeitPlayerId && s.isAlive);
            if (remainingPlayers.length === 1) {
                winner = remainingPlayers[0];
            } else if (remainingPlayers.length > 1) {
                const maxScore = Math.max(...remainingPlayers.map(p => p.score));
                const topPlayers = remainingPlayers.filter(p => p.score === maxScore);
                winner = topPlayers.length === 1 ? topPlayers[0] : { isDraw: true, players: topPlayers };
            } else {
                winner = { isDraw: true, players: [] };
            }
        } else if (this.gameMode === 'capture' && this.flagManager) {
            // 夺旗模式使用旗帜判定
            const victory = this.flagManager.checkVictoryCondition(this.players, this.territory);
            winner = victory.isDraw ? { isDraw: true, players: [] } : victory.winner;
            if (victory.flagCounts) extraData.flagCounts = victory.flagCounts;
            if (victory.scores) scores = victory.scores;
        } else {
            const alivePlayers = scores.filter(p => p.isAlive);
            const candidates = alivePlayers.length > 0 ? alivePlayers : scores;
            const maxScore = Math.max(...candidates.map(p => p.score));
            const winningPlayers = candidates.filter(p => p.score === maxScore);
            winner = winningPlayers.length === 1 ? winningPlayers[0] : { isDraw: true, players: winningPlayers };
        }

        const result = {
            winner,
            scores: scores.map(s => ({ ...s,
                lives: this.playerMap.get(s.id)?.lives ?? 0,
                isAlive: this.playerMap.get(s.id)?.isAlive ?? false,
                score: Math.round(s.score * 10) / 10 })),
            gameTime: this.gameTime,
            gameMode: this.gameMode,
            ...extraData
        };

        this.onGameEnd?.(result);
    }

    // 处理玩家因作弊被踢出
    kickPlayer(playerId, reason) {
        console.warn(`[反作弊] 踢出玩家 ${playerId.slice(0, 8)}: ${reason}`);
        const player = this.playerMap.get(playerId);
        if (player) {
            player.isAlive = false;
            player.lives = 0;
        }
        this.onGameEvent?.({
            type: 'PLAYER_KICKED',
            playerId,
            reason: `作弊检测: ${reason}`
        });
        this.endGame(playerId);
    }

    // 处理玩家弃权（点击主菜单/重新开始）
    forfeitPlayer(playerId) {
        if (this.gameState !== 'playing' && this.gameState !== 'countdown') return;
        // 标记玩家为死亡
        const player = this.playerMap.get(playerId);
        if (player) {
            player.isAlive = false;
            player.lives = 0;
        }
        this.endGame(playerId);
    }

    broadcastState() {
        if (!this.onStateSnapshot) return;

        const fullState = this._buildFullState();
        const deltaState = this._buildDeltaState(fullState);
        this.lastBroadcastState = fullState;
        this.onStateSnapshot(deltaState);
    }

    _buildFullState() {
        const state = {
            frame: this.frameCount,
            gameTime: this.gameTime,
            gameState: this.gameState,
            countdown: this.gameState === 'countdown' ? Math.ceil(this.countdown) : 0,
            maxGameTime: this.maxGameTime,
            gameMode: this.gameMode,
            difficulty: this.difficulty,
            players: this.players.map(p => p.serialize()),
            territories: this.territory.serialize(),
            items: this.itemManager.serialize()
        };

        // 模式特定状态
        state.modeState = {};
        if (this.gameMode === 'survival' && this.survivalManager) {
            state.modeState.survival = this.survivalManager.serialize();
        } else if (this.gameMode === 'capture' && this.flagManager) {
            state.modeState.capture = this.flagManager.serialize();
        } else if (this.gameMode === 'daynight' && this.dayNightManager) {
            state.modeState.dayNight = this.dayNightManager.serialize();
        }

        return state;
    }

    _buildDeltaState(fullState) {
        if (!this.lastBroadcastState) {
            // 首次广播：发送全量
            return { ...fullState, isDelta: false };
        }

        const delta = {
            frame: fullState.frame,
            gameTime: fullState.gameTime,
            gameState: fullState.gameState,
            countdown: fullState.countdown,
            isDelta: true
        };

        // 玩家：逐字段比较
        delta.players = fullState.players.map((p, i) => {
            const prev = this.lastBroadcastState.players[i];
            const dp = { id: p.id };

            if (p.x !== prev.x) dp.x = p.x;
            if (p.y !== prev.y) dp.y = p.y;
            if (p.direction.x !== prev.direction.x || p.direction.y !== prev.direction.y) {
                dp.direction = p.direction;
            }
            if (p.isAlive !== prev.isAlive) dp.isAlive = p.isAlive;
            if (p.lives !== prev.lives) dp.lives = p.lives;
            if (p.score !== prev.score) dp.score = p.score;
            if (p.hasShield !== prev.hasShield) dp.hasShield = p.hasShield;
            if (p.shieldRemaining !== prev.shieldRemaining) dp.shieldRemaining = p.shieldRemaining;
            if (p.speedActive !== prev.speedActive) dp.speedActive = p.speedActive;
            if (p.speedRemaining !== prev.speedRemaining) dp.speedRemaining = p.speedRemaining;
            if (p.lockTime !== prev.lockTime) dp.lockTime = p.lockTime;
            if (p.trailMaxLength !== prev.trailMaxLength) dp.trailMaxLength = p.trailMaxLength;
            if (p.name !== prev.name) dp.name = p.name;
            if (p.lastProcessedInputSeq !== prev.lastProcessedInputSeq) {
                dp.lastProcessedInputSeq = p.lastProcessedInputSeq;
            }

            // 轨迹：始终发送完整数据（Delta 增量同步暂未稳定，先全量确保正确）
            if (p.trail && p.trail.length > 0) {
                dp.trail = p.trail;
            } else if (prev.trail && prev.trail.length > 0 && (!p.trail || p.trail.length === 0)) {
                dp.trail = [];
                dp.trailReset = true;
            }

            // 始终包含 (slotIndex 不变但客户端需要)
            if (!prev) {
                dp.color = p.color;
                dp.slotIndex = p.slotIndex;
            }

            return dp;
        });

        // 领土：仅变化时发送
        const newTerrJson = JSON.stringify(fullState.territories);
        const newTerrHash = this._simpleHash(newTerrJson);
        if (newTerrHash !== this._lastTerrHash) {
            delta.territories = fullState.territories;
            this._lastTerrHash = newTerrHash;
        }

        // 道具：仅变化时发送
        const newItemJson = JSON.stringify(fullState.items);
        const newItemHash = this._simpleHash(newItemJson);
        if (newItemHash !== this._lastItemHash) {
            delta.items = fullState.items;
            this._lastItemHash = newItemHash;
        }

        // 模式状态：仅变化时发送（AI 敌人、旗帜、昼夜等）
        if (fullState.modeState) {
            const newModeJson = JSON.stringify(fullState.modeState);
            const newModeHash = this._simpleHash(newModeJson);
            if (newModeHash !== this._lastModeHash) {
                delta.modeState = fullState.modeState;
                this._lastModeHash = newModeHash;
            }
        }

        return delta;
    }

    _buildTrailDelta(prevTrail, currTrail) {
        if (!prevTrail || prevTrail.length === 0) {
            return { trail: currTrail, trailReset: true };
        }

        // 差异太大或围地后清空 → 全量
        if (Math.abs(prevTrail.length - currTrail.length) > 50 || currTrail.length === 0) {
            if (currTrail.length === 0 && prevTrail.length === 0) return null;
            return { trail: currTrail, trailReset: true };
        }

        let newPoints = [];
        if (currTrail.length > prevTrail.length) {
            newPoints = currTrail.slice(prevTrail.length);
        } else if (currTrail.length < prevTrail.length) {
            return { trail: currTrail, trailReset: true };
        } else {
            // 寻找尾部变化点
            let diffStart = prevTrail.length;
            for (let i = prevTrail.length - 1; i >= 0; i--) {
                if (!prevTrail[i] || !currTrail[i] ||
                    prevTrail[i].x !== currTrail[i].x || prevTrail[i].y !== currTrail[i].y) {
                    diffStart = i;
                } else {
                    break;
                }
            }
            if (diffStart < prevTrail.length) {
                newPoints = currTrail.slice(diffStart);
            }
        }

        if (newPoints.length === 0) return null;

        const totalRemoved = Math.max(0, prevTrail.length + newPoints.length - currTrail.length);
        return {
            trailAppend: newPoints,
            trailTrimCount: totalRemoved
        };
    }

    _simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + c;
            hash = hash & hash;
        }
        return hash.toString();
    }

    getFullState() {
        return {
            frame: this.frameCount,
            gameTime: this.gameTime,
            gameState: this.gameState,
            players: this.players.map(p => p.serialize()),
            territories: this.territory.serialize(),
            items: this.itemManager.serialize(),
            gameMode: this.gameMode,
            difficulty: this.difficulty,
            maxGameTime: this.maxGameTime
        };
    }
}

export default ServerEngine;
