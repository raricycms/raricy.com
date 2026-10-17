// Adapted from yao1145/quandiyundong @ b1050bd177fa9764afd039f2ec6e68af55137436.
// 原作者授权及本地修改说明见 public/static/quandi/NOTICE.txt。
/**
 * ServerSurvivalManager — 服务端 AI 敌人管理器
 * 从客户端 Survive.js 移植，去除 Canvas/DOM 依赖
 */

// AI 配置（与客户端 Config.js 保持一致）
const CONFIG = {
    CANVAS_WIDTH: 1200,
    CANVAS_HEIGHT: 600,
    AI_DEFAULTS: {
        slow: { multiplier: 0.9, count: 2, maxEnemies: 6, interval: 30000 },
        medium: { multiplier: 1.2, count: 3, maxEnemies: 7, interval: 20000 },
        fast: { multiplier: 1.4, count: 4, maxEnemies: 8, interval: 15000 },
        ultra: { multiplier: 2.0, count: 5, maxEnemies: 10, interval: 10000 }
    },
    PLAYER_DEFAULTS: {
        size: 8,
        deathshieldtime: 3000,
        detectionRadius: 150,
        pushdistance: 6
    }
};

class ServerAIEnemy {
    constructor(id, x, y, gameWidth, gameHeight, difficulty) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.gameWidth = gameWidth;
        this.gameHeight = gameHeight;
        this.speed = 1.5 * (CONFIG.AI_DEFAULTS[difficulty]?.multiplier || 1.2);
        this.direction = Math.random() * Math.PI * 2;
        this.size = CONFIG.PLAYER_DEFAULTS.size;
        this.state = 'wander'; // wander | chase | avoiding
        this.stateChangeTime = 0;
        this.relaxMode = false;
        this.relaxTimer = 0;
        this.shieldtime = CONFIG.PLAYER_DEFAULTS.deathshieldtime;
        this.targetPlayer = null;
        this.detectionRadius = CONFIG.PLAYER_DEFAULTS.detectionRadius;
    }

    update(deltaTime, players) {
        this.stateChangeTime += deltaTime;

        // relax 模式计时
        if (this.relaxMode) {
            this.relaxTimer += deltaTime;
            if (this.relaxTimer >= 5000) {
                this.relaxMode = false;
                this.relaxTimer = 0;
            }
        }

        // avoiding 状态
        if (this.state === 'avoiding') {
            if (this.stateChangeTime > 300) {
                this.state = 'wander';
                this.stateChangeTime = 0;
            } else {
                const normalizedSpeed = this.speed * (deltaTime / 16);
                this.x += Math.cos(this.direction) * normalizedSpeed;
                this.y += Math.sin(this.direction) * normalizedSpeed;
            }
        } else {
            // 寻找最近的存活玩家
            let nearest = null;
            let nearestDist = Infinity;
            for (const p of players) {
                if (!p.isAlive) continue;
                const d = Math.sqrt((this.x - p.x) ** 2 + (this.y - p.y) ** 2);
                if (d < nearestDist) { nearestDist = d; nearest = p; }
            }

            if (!this.relaxMode && nearest && nearestDist < this.detectionRadius) {
                this.state = 'chase';
                this.targetPlayer = nearest;
                this._chase(deltaTime, nearest);
            } else {
                this.state = 'wander';
                this.targetPlayer = null;
                this._wander(deltaTime);
            }
        }

        this._constrainToBounds();
    }

    _wander(deltaTime) {
        const normalizedSpeed = this.speed * (deltaTime / 16);
        // 偶尔随机改变方向
        if (Math.random() < 0.02) {
            this.direction += (Math.random() - 0.5) * Math.PI * 0.5;
        }
        this.x += Math.cos(this.direction) * normalizedSpeed;
        this.y += Math.sin(this.direction) * normalizedSpeed;
    }

    _chase(deltaTime, target) {
        const normalizedSpeed = this.speed * (deltaTime / 16);
        const toTarget = Math.atan2(target.y - this.y, target.x - this.x);
        // 平滑转向
        let diff = toTarget - this.direction;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.direction += diff * 0.1;
        // 距离越近速度越快
        const dist = Math.sqrt((target.x - this.x) ** 2 + (target.y - this.y) ** 2);
        const speedMultiplier = 1 + Math.max(0, 1 - dist / this.detectionRadius);
        this.x += Math.cos(this.direction) * normalizedSpeed * speedMultiplier;
        this.y += Math.sin(this.direction) * normalizedSpeed * speedMultiplier;
    }

    _constrainToBounds() {
        if (this.x < this.size) { this.x = this.size; this.direction = Math.PI - this.direction; }
        if (this.x > this.gameWidth - this.size) { this.x = this.gameWidth - this.size; this.direction = Math.PI - this.direction; }
        if (this.y < this.size) { this.y = this.size; this.direction = -this.direction; }
        if (this.y > this.gameHeight - this.size) { this.y = this.gameHeight - this.size; this.direction = -this.direction; }
    }

    avoid(obstacleX, obstacleY, obstacleW, obstacleH) {
        const centerX = obstacleX + obstacleW / 2;
        const centerY = obstacleY + obstacleH / 2;
        this.direction = Math.atan2(this.y - centerY, this.x - centerX);
        this.state = 'avoiding';
        this.stateChangeTime = 0;
    }

    hitPlayer() {
        this.relaxMode = true;
        this.relaxTimer = 0;
        this.state = 'wander';
    }

    serialize() {
        return {
            id: this.id,
            x: Math.round(this.x * 10) / 10,
            y: Math.round(this.y * 10) / 10,
            state: this.state,
            relaxMode: this.relaxMode
        };
    }
}

class ServerSurvivalManager {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.enemies = [];
        this.spawnTimer = 0;
        this.lastSpawnTime = 0;
        this.difficulty = 'medium';
        this.maxEnemies = 7;
        this.spawnInterval = 20000;
        this.initialCount = 3;
        this.enemyIdCounter = 0;
    }

    init(difficulty) {
        this.difficulty = difficulty || 'medium';
        const aiCfg = CONFIG.AI_DEFAULTS[this.difficulty];
        this.maxEnemies = aiCfg.maxEnemies;
        this.spawnInterval = aiCfg.interval;
        this.initialCount = aiCfg.count;

        // 生成初始敌人
        this.enemies = [];
        this.enemyIdCounter = 0;
        for (let i = 0; i < this.initialCount; i++) {
            this._spawnEnemy();
        }
        this.lastSpawnTime = 0;
    }

    update(deltaTime, players, territory, obstacles, initialBarriers) {
        this.spawnTimer += deltaTime;

        // 定时生成新敌人
        if (this.spawnTimer - this.lastSpawnTime >= this.spawnInterval && this.enemies.length < this.maxEnemies) {
            this._spawnEnemy();
            this.lastSpawnTime = this.spawnTimer;
        }

        // 更新所有 AI
        for (const enemy of this.enemies) {
            enemy.update(deltaTime, players);

            // 检查障碍物碰撞
            const allObstacles = [...(obstacles || []), ...(initialBarriers || [])];
            for (const obs of allObstacles) {
                const closestX = Math.max(obs.x, Math.min(enemy.x, obs.x + (obs.width || obs.w || 40)));
                const closestY = Math.max(obs.y, Math.min(enemy.y, obs.y + (obs.height || obs.h || 40)));
                const dist = Math.sqrt((enemy.x - closestX) ** 2 + (enemy.y - closestY) ** 2);
                if (dist < CONFIG.PLAYER_DEFAULTS.pushdistance + enemy.size) {
                    enemy.avoid(obs.x, obs.y, obs.width || obs.w || 40, obs.height || obs.h || 40);
                }
            }

            // 边界
            enemy._constrainToBounds();
        }
    }

    checkPlayerCollisions(players) {
        for (const player of players) {
            if (!player.isAlive) continue;
            for (const enemy of this.enemies) {
                if (enemy.relaxMode) continue;
                const dist = Math.sqrt((player.x - enemy.x) ** 2 + (player.y - enemy.y) ** 2);
                if (dist < player.size + enemy.size + 2) {
                    // 玩家死亡
                    if (!player.hasShield()) {
                        player.lives--;
                        if (player.lives > 0) {
                            // 重生 + 护盾
                            player.x = player.startX;
                            player.y = player.startY;
                            player.trail = [];
                            player.direction = { x: 0, y: 0 };
                            player.activateShield(CONFIG.PLAYER_DEFAULTS.deathshieldtime);
                        } else {
                            player.isAlive = false;
                        }
                    }
                    // 敌人进入 relax 模式
                    enemy.hitPlayer();
                    return { playerHit: true, playerId: player.id, enemyId: enemy.id };
                }
            }
        }
        return null;
    }

    checkAICollisions() {
        for (let i = 0; i < this.enemies.length; i++) {
            for (let j = i + 1; j < this.enemies.length; j++) {
                const a = this.enemies[i];
                const b = this.enemies[j];
                const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
                if (dist < a.size + b.size) {
                    a.avoid(b.x, b.y, b.size * 2, b.size * 2);
                    b.avoid(a.x, a.y, a.size * 2, a.size * 2);
                }
            }
        }
    }

    _spawnEnemy() {
        let attempts = 0;
        while (attempts < 50) {
            const x = 50 + Math.random() * (this.width - 100);
            const y = 50 + Math.random() * (this.height - 100);
            // 避免离中心生成点太近
            const distP1 = Math.sqrt((180 - x) ** 2 + (300 - y) ** 2);
            const distP2 = Math.sqrt((1020 - x) ** 2 + (300 - y) ** 2);
            if (distP1 < 150 || distP2 < 150) { attempts++; continue; }
            // 避免与已有敌人重叠
            const tooClose = this.enemies.some(e => Math.sqrt((e.x - x) ** 2 + (e.y - y) ** 2) < 30);
            if (tooClose) { attempts++; continue; }
            this.enemyIdCounter++;
            const enemy = new ServerAIEnemy(`ai_${this.enemyIdCounter}`, x, y, this.width, this.height, this.difficulty);
            this.enemies.push(enemy);
            return;
        }
    }

    reset() {
        this.enemies = [];
        this.spawnTimer = 0;
        this.lastSpawnTime = 0;
        this.enemyIdCounter = 0;
    }

    serialize() {
        return {
            enemies: this.enemies.map(e => e.serialize()),
            enemyCount: this.enemies.length
        };
    }
}

export { ServerSurvivalManager, ServerAIEnemy };
