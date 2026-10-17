// Adapted from yao1145/quandiyundong @ b1050bd177fa9764afd039f2ec6e68af55137436.
// 原作者授权及本地修改说明见 public/static/quandi/NOTICE.txt。
/**
 * ServerFlagManager — 服务端夺旗模式管理器
 * 从客户端 Flag.js 移植，去除 Canvas/DOM 依赖
 */

class ServerFlag {
    constructor(x, y, size = 25) {
        this.x = x;
        this.y = y;
        this.size = size;
        this.capturedBy = null; // playerId
    }

    capture(playerId) {
        if (this.capturedBy !== playerId) {
            this.capturedBy = playerId;
            return true; // 旗帜状态变化
        }
        return false;
    }

    release() {
        if (this.capturedBy !== null) {
            this.capturedBy = null;
            return true;
        }
        return false;
    }
}

class ServerFlagManager {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.flags = [];
        this.flagCount = 5;
    }

    init(players) {
        this.flags = [];
        for (let i = 0; i < this.flagCount; i++) {
            this._placeFlag(players);
        }
    }

    _placeFlag(players) {
        const MIN_DISTANCE_FROM_PLAYER = 300;
        const MIN_DISTANCE_BETWEEN_FLAGS = 100;
        const FLAG_SIZE = 25;
        let attempts = 0;
        while (attempts < 200) {
            // 与客户端一致的生成范围
            const x = Math.random() * (this.width - 100) + 50;
            const y = Math.random() * (this.height - 100) + 50;

            // 避免离玩家生成点太近（与客户端一致）
            let valid = true;
            if (players) {
                for (const p of players) {
                    const playerSpawnAvoidanceSize = 2 * FLAG_SIZE; // 与客户端一致
                    // 矩形区域重叠检测
                    if (x > p.startX - playerSpawnAvoidanceSize && x < p.startX + playerSpawnAvoidanceSize &&
                        y > p.startY - playerSpawnAvoidanceSize && y < p.startY + playerSpawnAvoidanceSize) {
                        valid = false; break;
                    }
                    const d = Math.sqrt((p.startX - x) ** 2 + (p.startY - y) ** 2);
                    if (d < MIN_DISTANCE_FROM_PLAYER) { valid = false; break; }
                }
            }
            if (!valid) { attempts++; continue; }

            // 避免与已有旗帜太近
            const tooClose = this.flags.some(f =>
                Math.sqrt((f.x - x) ** 2 + (f.y - y) ** 2) < MIN_DISTANCE_BETWEEN_FLAGS
            );
            if (tooClose) { attempts++; continue; }

            // 避免在初始栏杆位置（与客户端一致）
            const barrierArea = 60;
            const centerX1 = this.width * 0.35;
            const centerX2 = this.width * 0.65;
            if (Math.abs(x - centerX1) < barrierArea || Math.abs(x - centerX2) < barrierArea) {
                attempts++;
                continue;
            }

            this.flags.push(new ServerFlag(x, y, FLAG_SIZE));
            return;
        }
        // 降级：即使位置不完美也放置
        const fallbackX = 100 + Math.random() * (this.width - 200);
        const fallbackY = 100 + Math.random() * (this.height - 200);
        this.flags.push(new ServerFlag(fallbackX, fallbackY, FLAG_SIZE));
    }

    /**
     * 当玩家围地时，检查新领土是否包含旗帜
     */
    checkCaptureInNewTerritory(newTerritory, playerId) {
        if (!newTerritory) return [];
        const captured = [];
        for (const flag of this.flags) {
            if (this._isPointInPolygon({ x: flag.x, y: flag.y }, newTerritory)) {
                if (flag.capture(playerId)) {
                    captured.push({ x: flag.x, y: flag.y, capturedBy: playerId });
                }
            }
        }
        return captured;
    }

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

    checkVictoryCondition(players, territory) {
        const alivePlayers = players.filter(p => p.isAlive);
        // 优先：最后存活
        if (alivePlayers.length <= 1) {
            const winner = alivePlayers[0];
            if (winner) {
                return {
                    winner,
                    isDraw: false,
                    scores: players.map(p => ({ id: p.id, score: territory.calculateScore(p.id) })),
                    flagCounts: this._getFlagCounts(players)
                };
            }
            // 全部死亡
            return { isDraw: true, scores: [], flagCounts: this._getFlagCounts(players) };
        }

        const flagCounts = this._getFlagCounts(players);
        const maxFlags = Math.max(...Object.values(flagCounts));
        const flagLeaders = players.filter(p => flagCounts[p.id] === maxFlags && p.isAlive);

        if (flagLeaders.length === 1) {
            return {
                winner: flagLeaders[0],
                isDraw: false,
                scores: players.map(p => ({ id: p.id, score: territory.calculateScore(p.id) })),
                flagCounts
            };
        }

        // 旗帜平手 → 按领土百分比决胜
        const scores = players.map(p => ({ id: p.id, score: territory.calculateScore(p.id) }));
        const maxScore = Math.max(...scores.filter(s => {
            const p = players.find(pp => pp.id === s.id);
            return p && p.isAlive;
        }).map(s => s.score));
        const winners = scores.filter(s => s.score === maxScore);

        return {
            winner: winners.length === 1 ? winners[0] : { isDraw: true, players: winners },
            isDraw: winners.length !== 1,
            scores,
            flagCounts
        };
    }

    _getFlagCounts(players) {
        const counts = {};
        for (const p of players) {
            counts[p.id] = 0;
        }
        for (const flag of this.flags) {
            if (flag.capturedBy && counts[flag.capturedBy] !== undefined) {
                counts[flag.capturedBy]++;
            }
        }
        return counts;
    }

    getFlagCount(playerId) {
        return this.flags.filter(f => f.capturedBy === playerId).length;
    }

    serialize() {
        return {
            flags: this.flags.map(f => ({
                x: Math.round(f.x),
                y: Math.round(f.y),
                capturedBy: f.capturedBy
            }))
        };
    }
}

export { ServerFlagManager, ServerFlag };
