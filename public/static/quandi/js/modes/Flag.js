class Flag {
    constructor(x, y, size = Config.FLAG_DEFAULTS.size) {
        this.x = x;
        this.y = y;
        this.size = size;
        this.capturedBy = null;
        this.color = Config.FLAG_DEFAULTS.color;
        this.captureRadius = size;
        this.lastState = null;
        this.needsRedraw = true;
    }

    isCapturedBy(playerId) {
        return this.capturedBy === playerId;
    }

    capture(playerId) {
        if (this.capturedBy !== playerId) {
            this.capturedBy = playerId;
            this.needsRedraw = true;
        }
    }

    release() {
        if (this.capturedBy !== null) {
            this.capturedBy = null;
            this.needsRedraw = true; // 标记需要重绘
        }
    }

    getDisplayColor(players) {
        if (this.capturedBy) {
            // 本地模式：按数字索引查找
            if (players && players[this.capturedBy - 1]) {
                return players[this.capturedBy - 1].color;
            }
            // 联机模式：按 UUID 查找（本地玩家或远程玩家）
            const engine = window.gameEngine;
            if (engine && engine.networkMode === 'online') {
                if (engine.localPlayer && engine.localPlayer.id === this.capturedBy) {
                    return engine.localPlayer.color;
                }
                const rp = engine.remotePlayers.get(this.capturedBy);
                if (rp) return rp.color;
            }
        }
        return this.color;
    }

    // 检查状态是否发生变化
    hasStateChanged(players) {
        const currentState = {
            capturedBy: this.capturedBy,
            displayColor: this.getDisplayColor(players)
        };

        if (!this.lastState ||
            this.lastState.capturedBy !== currentState.capturedBy ||
            this.lastState.displayColor !== currentState.displayColor) {
            this.lastState = currentState;
            return true;
        }
        return false;
    }

    // 获取是否需要重绘
    redraw(players) {
        return this.needsRedraw || this.hasStateChanged(players);
    }

    // 标记已完成重绘
    markRedrawn() {
        this.needsRedraw = false;
    }
}

class FlagManager {
    constructor(gameWidth, gameHeight) {
        this.gameWidth = gameWidth;
        this.gameHeight = gameHeight;
        this.flags = [];
        this.flagCount = 5; // 默认旗帜数量

        // 离屏缓存相关
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
        this.flagCaches = new Map(); // 存储每个旗帜的缓存
        this.initOffscreenCanvas();
    }

    // 初始化离屏画布
    initOffscreenCanvas() {
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = this.gameWidth;
        this.offscreenCanvas.height = this.gameHeight;
        this.offscreenCtx = this.offscreenCanvas.getContext('2d');
    }

    init() {
        this.flags = [];
        this.flagCaches.clear(); // 清除缓存
        this.generateFlags();
    }

    generateFlags() {
        const MIN_DISTANCE_FROM_PLAYER = Config.FLAG_DEFAULTS.ditance_from_player;
        const MIN_DISTANCE_BETWEEN_FLAGS = Config.FLAG_DEFAULTS.ditance_between_flags;
        const MAX_ATTEMPTS = 100; // 尝试生成旗帜位置的最大次数

        const P1_startX = Config.CANVAS.P1_startpoint.x * this.gameWidth;
        const P1_startY = Config.CANVAS.P1_startpoint.y * this.gameHeight;
        const P2_startX = Config.CANVAS.P2_startpoint.x * this.gameWidth;
        const P2_startY = Config.CANVAS.P2_startpoint.y * this.gameHeight;

        const isValidFlagPosition = (x, y) => {
            // 检查与玩家出发点的距离
            const distToP1 = Math.sqrt(Math.pow(x - P1_startX, 2) + Math.pow(y - P1_startY, 2));
            const distToP2 = Math.sqrt(Math.pow(x - P2_startX, 2) + Math.pow(y - P2_startY, 2));
            // 假设flag.size是旗帜的半径，避免区域为以玩家出生点为中心，边长为2*flag.size的正方形
            const playerSpawnAvoidanceSize = 2 * Config.FLAG_DEFAULTS.size; // 使用默认尺寸作为参考


            // 检查与玩家出生点区域的重叠
            if (
                (x > P1_startX - playerSpawnAvoidanceSize && x < P1_startX + playerSpawnAvoidanceSize &&
                    y > P1_startY - playerSpawnAvoidanceSize && y < P1_startY + playerSpawnAvoidanceSize) ||
                (x > P2_startX - playerSpawnAvoidanceSize && x < P2_startX + playerSpawnAvoidanceSize &&
                    y > P2_startY - playerSpawnAvoidanceSize && y < P2_startY + playerSpawnAvoidanceSize) ||
                distToP1 < MIN_DISTANCE_FROM_PLAYER || distToP2 < MIN_DISTANCE_FROM_PLAYER
            ) {
                return false;
            }

            // 检查与其他旗帜的距离
            for (const existingFlag of this.flags) {
                const dist = Math.sqrt(Math.pow(x - existingFlag.x, 2) + Math.pow(y - existingFlag.y, 2));
                if (dist < MIN_DISTANCE_BETWEEN_FLAGS) {
                    return false;
                }
            }

            // 检查与初始栏杆的重叠
            const centerX = this.gameWidth * 0.35;
            const centerX2 = this.gameWidth * 0.65;
            const barrierarea = 60;
            const distanceP1 = Math.abs(x - centerX);
            const distanceP2 = Math.abs(x - centerX2);

            if (distanceP1 < barrierarea || distanceP2 < barrierarea) {
                return false;
            };
            return true;
        };

        for (let i = 0; i < this.flagCount; i++) {
            let newFlagX, newFlagY;
            let attempts = 0;
            let positionFound = false;

            while (attempts < MAX_ATTEMPTS && !positionFound) {
                // 随机生成旗帜位置，确保在游戏区域内
                newFlagX = Math.random() * (this.gameWidth - 100) + 50; // 留出边界
                newFlagY = Math.random() * (this.gameHeight - 100) + 50; // 留出边界

                if (isValidFlagPosition(newFlagX, newFlagY)) {
                    const flag = new Flag(newFlagX, newFlagY);
                    this.flags.push(flag);
                    positionFound = true;
                }
                attempts++;
            }

            if (!positionFound) {
                console.warn(`无法在 ${MAX_ATTEMPTS} 次尝试内为旗帜 ${i + 1} 找到有效位置。`);
            }
        }
    }

    update(territory, players) {
        // 检查游戏是否处于暂停状态
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            return; // 如果游戏暂停，则不更新任何计时相关的逻辑
        }

        this.flags.forEach(flag => {
            if (flag.capturedBy) {
                const owner = players.find(p => p.id === flag.capturedBy);
                if (!owner || !owner.isAlive) {
                    flag.release();
                }
            }
        });

        this.checkPlayerCollisions(players, territory);
    }

    // 为单个旗帜创建缓存
    createFlagCache(flag, players) {
        const baseSize = flag.size * 0.7;
        const cacheSize = Math.ceil(baseSize * 2 + 30); // 留出足够空间

        const cacheCanvas = document.createElement('canvas');
        cacheCanvas.width = cacheSize;
        cacheCanvas.height = cacheSize;
        const cacheCtx = cacheCanvas.getContext('2d');

        const centerX = cacheSize / 2;
        const centerY = cacheSize / 2;
        const innerSize = baseSize * 0.6;

        cacheCtx.save();

        // 使用精灵图：金色旗帜徽标（含同心圈背景），用 multiply 上色为归属色/灰色
        const flagImg = window.imageLoader && window.imageLoader.get('flag');
        if (flagImg) {
            const tintColor = flag.capturedBy ? flag.getDisplayColor(players) : '#888888';
            // 外圈直径 = 2*baseSize，绘制精灵到该尺寸并居中于缓存画布
            const drawSize = baseSize * 2;
            const ox = centerX - drawSize / 2;
            const oy = centerY - drawSize / 2;
            cacheCtx.drawImage(flagImg, ox, oy, drawSize, drawSize);
            // 旗帜按圆形区域上色：以徽标中心为圆心 clip 成圆，避免染色矩形四角
            cacheCtx.save();
            cacheCtx.beginPath();
            cacheCtx.arc(centerX, centerY, drawSize / 2, 0, Math.PI * 2);
            cacheCtx.clip();
            cacheCtx.globalCompositeOperation = 'multiply';
            cacheCtx.globalAlpha = 0.6; // 降低上色强度，避免纯色过重
            cacheCtx.fillStyle = tintColor;
            cacheCtx.fillRect(ox, oy, drawSize, drawSize);
            cacheCtx.globalAlpha = 1;
            cacheCtx.globalCompositeOperation = 'source-over';
            cacheCtx.restore();

            // 如果被占领，显示玩家标识（在圆形 clip 之外绘制，避免被裁剪）
            if (flag.capturedBy) {
                cacheCtx.fillStyle = flag.getDisplayColor(players);
                cacheCtx.font = 'bold 10px Arial';
                cacheCtx.textAlign = 'center';
                cacheCtx.textBaseline = 'middle';
                cacheCtx.fillText(`P${flag.capturedBy}`, centerX, centerY + baseSize + 12);
            }
            cacheCtx.restore();
            return {
                canvas: cacheCanvas,
                size: cacheSize,
                baseSize: baseSize
            };
        }

        // 绘制外圈（半透明背景）
        cacheCtx.fillStyle = flag.getDisplayColor(players) + '40';
        cacheCtx.beginPath();
        cacheCtx.arc(centerX, centerY, baseSize, 0, Math.PI * 2);
        cacheCtx.fill();

        // 绘制内圈（更透明的背景）
        cacheCtx.fillStyle = flag.getDisplayColor(players) + '20';
        cacheCtx.beginPath();
        cacheCtx.arc(centerX, centerY, innerSize, 0, Math.PI * 2);
        cacheCtx.fill();

        // 绘制边框（半透明）
        cacheCtx.strokeStyle = flag.getDisplayColor(players) + '80';
        cacheCtx.lineWidth = 2;
        cacheCtx.beginPath();
        cacheCtx.arc(centerX, centerY, baseSize, 0, Math.PI * 2);
        cacheCtx.stroke();

        // 绘制旗帜图标（中心）
        cacheCtx.fillStyle = flag.capturedBy ? flag.getDisplayColor(players) : '#666';
        cacheCtx.font = 'bold 14px Arial';
        cacheCtx.textAlign = 'center';
        cacheCtx.textBaseline = 'middle';
        cacheCtx.fillText('🚩', centerX, centerY);

        // 如果被占领，显示玩家标识
        if (flag.capturedBy) {
            cacheCtx.fillStyle = flag.getDisplayColor(players);
            cacheCtx.font = 'bold 10px Arial';
            cacheCtx.fillText(`P${flag.capturedBy}`, centerX, centerY + baseSize + 12);
        }

        cacheCtx.restore();

        return {
            canvas: cacheCanvas,
            size: cacheSize,
            baseSize: baseSize
        };
    }

    isPointInPolygon(x, y, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            if (((polygon[i].y > y) !== (polygon[j].y > y)) &&
                (x < (polygon[j].x - polygon[i].x) * (y - polygon[i].y) / (polygon[j].y - polygon[i].y) + polygon[i].x)) {
                inside = !inside;
            }
        }
        return inside;
    }

    checkCaptureInNewTerritory(newPolygon, playerId) {
        this.flags.forEach(flag => {
            if (this.isPointInPolygon(flag.x, flag.y, newPolygon)) {
                // 如果旗帜在新领土内，就执行占领
                flag.capture(playerId);
            }
        });
    }

    getFlagCounts() {
        const counts = {};

        // 初始化所有玩家的计数为0
        for (let i = 1; i <= 2; i++) {
            counts[i] = 0;
        }

        // 统计每个玩家占领的旗帜数量
        this.flags.forEach(flag => {
            if (flag.capturedBy) {
                counts[flag.capturedBy]++;
            }
        });

        return counts;
    }

    getFlags() {
        return this.flags;
    }

    getFlagCount() {
        return this.flags.length;
    }

    setFlagCount(count) {
        this.flagCount = Math.max(1, Math.min(10, count)); // 限制在1-10之间
    }

    render(ctx, players) {
        this.flags.forEach((flag, index) => {
            // 检查是否需要更新缓存
            if (flag.redraw(players) || !this.flagCaches.has(index)) {
                // 创建或更新缓存
                const cache = this.createFlagCache(flag, players);
                this.flagCaches.set(index, cache);
                flag.markRedrawn(); // 标记已完成重绘
            }

            // 从缓存中获取并绘制
            const cache = this.flagCaches.get(index);
            if (cache) {
                const offsetX = cache.size / 2;
                const offsetY = cache.size / 2;
                ctx.drawImage(
                    cache.canvas,
                    flag.x - offsetX,
                    flag.y - offsetY
                );
            }
        });
    }

    // 新增：检查玩家之间的碰撞（类似探索模式）
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
                    player.die('与玩家头部碰撞');
                    otherPlayer.die('与玩家头部碰撞');
                    break;
                } else if (collisionType === 'trail-collision') {
                    // 轨迹碰撞：碰撞者死亡，被碰撞者杀死对手
                    player.die('碰撞到玩家轨迹');
                    break;
                }

                // 检查与其他玩家领土的碰撞
                const otherTerritories = territory.getPlayerTerritories(otherPlayer.id);
                if (!player.canEnterEnemyTerritory()) {
                    if (player.checkCollisionWithTerritory(otherTerritories)) {
                        player.die('碰撞到玩家领土');
                        break;
                    }
                }
            }
        }
    }

    // 检查胜利条件
    checkVictoryCondition(players, territory) {
        const flagCounts = this.getFlagCounts();
        const scores = players.map(player => ({
            id: player.id,
            score: territory.calculateScore(player.id, this.gameWidth, this.gameHeight),
            flags: flagCounts[player.id] || 0,
            isAlive: player.isAlive
        }));

        const alivePlayers = scores.filter(p => p.isAlive);
        const potentialWinners = alivePlayers.length > 0 ? alivePlayers : scores;
        if (potentialWinners.length === 1) {
            return {
                winner: potentialWinners[0],
                reason: 'alive',
                scores: scores,
                flagCounts: flagCounts
            };
        }

        // 比较旗帜数量
        const maxFlags = Math.max(...potentialWinners.map(s => s.flags));
        const flagWinners = potentialWinners.filter(s => s.flags === maxFlags);
        if (flagWinners.length === 1) {
            return {
                winner: flagWinners[0],
                reason: 'flags',
                scores: scores,
                flagCounts: flagCounts
            };
        }

        // 旗帜数量相同，比较领土面积
        const maxScore = Math.max(...potentialWinners.map(p => p.score));
        const territoryWinners = potentialWinners.filter(p => p.score === maxScore);
        if (territoryWinners.length === 1) {
            return {
                winner: territoryWinners[0],
                reason: 'territory',
                scores: scores,
                flagCounts: flagCounts
            };
        }else{
            return {
                winner: territoryWinners,
                isDraw: true,
                reason: 'draw',
                scores: scores,
                flagCounts: flagCounts
            };
        }
    }

    reset() {
        this.flags = [];
        this.flagCaches.clear(); // 清除所有缓存
        this.generateFlags();
    }

    // 联机模式：接收服务器权威旗帜状态
    applyServerState(captureData) {
        if (!captureData || !captureData.flags) return;

        // 确保旗帜数量一致
        while (this.flags.length < captureData.flags.length) {
            this.flags.push(new Flag(0, 0));
        }
        while (this.flags.length > captureData.flags.length) {
            this.flags.pop();
        }

        // 同步每面旗帜的位置和归属
        for (let i = 0; i < captureData.flags.length; i++) {
            const sFlag = captureData.flags[i];
            if (this.flags[i]) {
                this.flags[i].x = sFlag.x;
                this.flags[i].y = sFlag.y;
                if (this.flags[i].capturedBy !== sFlag.capturedBy) {
                    this.flags[i].capturedBy = sFlag.capturedBy;
                    this.flags[i].needsRedraw = true;
                }
            }
        }
    }

    // 清理资源
    dispose() {
        this.flagCaches.clear();
        if (this.offscreenCanvas) {
            this.offscreenCanvas = null;
            this.offscreenCtx = null;
        }
    }
}
