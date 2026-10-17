/**
 * RemotePlayer — 远程玩家的客户端代理
 * 负责自适应插值渲染，不做本地游戏逻辑
 */
class RemotePlayer {
    constructor(playerData) {
        this.id = playerData.id;
        this.name = playerData.name || '玩家';
        this.color = playerData.color || '#888888';
        this.slotIndex = playerData.slotIndex || 0;
        this.size = 8;

        // Current state
        this.x = 0;
        this.y = 0;
        this.renderX = 0;
        this.renderY = 0;
        this.direction = { x: 0, y: 0 };
        this.trail = [];
        this.isAlive = true;
        this.lives = 3;
        this.score = 0;
        this.hasShield = false;

        // Interpolation buffer
        this.positionBuffer = [];
        this.maxBufferSize = 60; // 3 seconds at 20Hz

        // Trail rendering
        this.renderTrail = [];

        // ─── 自适应插值 ────────────────────────────────
        this.interpDelayMs = 100;            // 当前使用的插值延迟（动态调整）
        this.targetInterpDelay = 100;        // 目标插值延迟
        this.lastDelayUpdate = 0;            // 上次调整时间
        this.delayUpdateInterval = 3000;     // 每 3 秒调整一次
        this.delayTransitionSpeed = 0.2;     // 平滑过渡速率（20%/次）

        // 基于接收间隔的抖动测量
        this.lastStateTime = 0;
        this.stateIntervals = [];            // 最近 30 次状态到达间隔
    }

    /**
     * Apply server state update to this remote player.
     * Called when S2C_GAME_STATE is received.
     */
    applyServerState(stateData) {
        const now = Date.now();

        // 测量状态到达间隔（用于自适应插值）
        if (this.lastStateTime > 0) {
            const interval = now - this.lastStateTime;
            this.stateIntervals.push(interval);
            if (this.stateIntervals.length > 30) this.stateIntervals.shift();
        }
        this.lastStateTime = now;

        // Update basic state
        if (stateData.isAlive !== undefined) this.isAlive = stateData.isAlive;
        if (stateData.lives !== undefined) this.lives = stateData.lives;
        if (stateData.score !== undefined) this.score = stateData.score;
        if (stateData.hasShield !== undefined) this.hasShield = stateData.hasShield;
        if (stateData.homeTimeRemaining !== undefined) this.homeTimeRemaining = stateData.homeTimeRemaining;
        // 仅在 direction 明确提供时才更新（delta 状态可能不含此字段）
        if (stateData.direction !== undefined) {
            this.direction = stateData.direction;
        }

        // Push position into interpolation buffer
        this.positionBuffer.push({
            x: stateData.x,
            y: stateData.y,
            timestamp: now
        });

        // Trim buffer
        while (this.positionBuffer.length > this.maxBufferSize) {
            this.positionBuffer.shift();
        }

        // Update actual position (used if buffer is too small)
        this.x = stateData.x;
        this.y = stateData.y;

        // Update trail for rendering (server sends full trail slice)
        // 注意：delta 状态下 isAlive 可能为 undefined（未变化），
        // 此时应保留已有存活状态，只处理显式的死亡/复活
        if (stateData.trail) {
            if (stateData.isAlive !== false) {
                this.renderTrail = stateData.trail;
                // 同步 x/y 到轨迹最前端（与本地 Player 一致）
                if (stateData.trail.length > 0) {
                    const front = stateData.trail[stateData.trail.length - 1];
                    this.x = front.x;
                    this.y = front.y;
                }
            }
        }
        if (stateData.isAlive === false && (!stateData.trail || stateData.trail.length === 0)) {
            this.renderTrail = [];
        }
    }

    /**
     * 根据网络质量更新目标插值延迟
     * 公式: interpDelay = clamp(avgLatency + jitter * 2, 30, 200)
     */
    updateInterpolationDelay(networkQuality) {
        const now = Date.now();
        if (now - this.lastDelayUpdate < this.delayUpdateInterval) return;
        this.lastDelayUpdate = now;

        // 优先使用接收间隔的抖动（更实时）
        let jitter = 0;
        if (this.stateIntervals.length >= 3) {
            const meanInt = this.stateIntervals.reduce((a, b) => a + b, 0) / this.stateIntervals.length;
            const variance = this.stateIntervals.reduce((s, i) => s + (i - meanInt) ** 2, 0) / this.stateIntervals.length;
            jitter = Math.sqrt(variance);
        }
        // 补充使用 ping 测量的数据
        const { avgLatency, jitter: pingJitter } = networkQuality;
        jitter = Math.max(jitter, pingJitter);

        const raw = avgLatency + jitter * 2;

        // 钳制范围 [30ms, 200ms]
        this.targetInterpDelay = Math.max(30, Math.min(200, Math.round(raw)));
    }

    /**
     * 每帧调用，平滑过渡到目标延迟
     */
    smoothDelay() {
        if (Math.abs(this.interpDelayMs - this.targetInterpDelay) < 1) {
            this.interpDelayMs = this.targetInterpDelay;
            return;
        }
        this.interpDelayMs += (this.targetInterpDelay - this.interpDelayMs) * this.delayTransitionSpeed;
    }

    /**
     * Get interpolated position for smooth rendering.
     * Uses adaptive delay to hide network jitter.
     */
    getInterpolatedPosition() {
        const now = Date.now();
        const targetTime = now - this.interpDelayMs;

        if (this.positionBuffer.length < 2) {
            // Not enough data, use latest known position
            if (this.positionBuffer.length === 1) {
                const latest = this.positionBuffer[this.positionBuffer.length - 1];
                return { x: latest.x, y: latest.y };
            }
            return { x: this.x, y: this.y };
        }

        // Find two positions that bracket the target time
        let before = null;
        let after = null;

        for (let i = 1; i < this.positionBuffer.length; i++) {
            if (this.positionBuffer[i].timestamp >= targetTime) {
                before = this.positionBuffer[i - 1];
                after = this.positionBuffer[i];
                break;
            }
        }

        if (!before || !after) {
            // Extrapolate using latest known position
            const latest = this.positionBuffer[this.positionBuffer.length - 1];
            return { x: latest.x, y: latest.y };
        }

        // Linear interpolation
        const range = after.timestamp - before.timestamp;
        if (range === 0) return { x: after.x, y: after.y };

        const t = Math.max(0, Math.min(1, (targetTime - before.timestamp) / range));
        return {
            x: before.x + (after.x - before.x) * t,
            y: before.y + (after.y - before.y) * t
        };
    }

    /**
     * Reset this remote player (e.g., on game restart).
     */
    reset(x, y) {
        this.x = x || 0;
        this.y = y || 0;
        this.renderX = x || 0;
        this.renderY = y || 0;
        this.direction = { x: 0, y: 0 };
        this.trail = [];
        this.renderTrail = [];
        this.positionBuffer = [];
        this.isAlive = true;
    }
}

window.RemotePlayer = RemotePlayer;
