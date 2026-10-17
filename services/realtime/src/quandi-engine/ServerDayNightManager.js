// Adapted from yao1145/quandiyundong @ b1050bd177fa9764afd039f2ec6e68af55137436.
// 原作者授权及本地修改说明见 public/static/quandi/NOTICE.txt。
/**
 * ServerDayNightManager — 服务端昼夜循环管理器
 * 维护周期计时 + 随机种子，广播给客户端做本地渲染
 */

class ServerDayNightManager {
    constructor() {
        this.PHASES = {
            DAY: 'day',
            FADE_TO_NIGHT: 'fadeToNight',
            NIGHT: 'night',
            FADE_TO_DAY: 'fadeToDay'
        };
        this.FADE_TIME = 5000;
        this.DARK_TIME = 10000;
        this.CYCLE_TIME = 20000;
        this.INITIAL_DAY_TIME = 10000;

        this.elapsed = 0;
        this.seed = Math.floor(Math.random() * 1000000);
    }

    update(deltaTime) {
        this.elapsed += deltaTime;
    }

    getCurrentPhase() {
        const t = this.elapsed;
        if (t < this.INITIAL_DAY_TIME) return this.PHASES.DAY;
        const cycleT = (t - this.INITIAL_DAY_TIME) % this.CYCLE_TIME;
        if (cycleT < this.FADE_TIME) return this.PHASES.FADE_TO_NIGHT;
        if (cycleT < this.FADE_TIME + this.DARK_TIME) return this.PHASES.NIGHT;
        return this.PHASES.FADE_TO_DAY;
    }

    getElapsedInPhase() {
        const t = this.elapsed;
        if (t < this.INITIAL_DAY_TIME) return t;
        const cycleT = (t - this.INITIAL_DAY_TIME) % this.CYCLE_TIME;
        const phase = this.getCurrentPhase();
        if (phase === this.PHASES.FADE_TO_NIGHT) return cycleT;
        if (phase === this.PHASES.NIGHT) return cycleT - this.FADE_TIME;
        if (phase === this.PHASES.FADE_TO_DAY) return cycleT - this.FADE_TIME - this.DARK_TIME;
        return cycleT - this.CYCLE_TIME + this.FADE_TIME;
    }

    getDarkness() {
        const phase = this.getCurrentPhase();
        const elapsed = this.getElapsedInPhase();
        if (phase === this.PHASES.DAY) return 0;
        if (phase === this.PHASES.NIGHT) return 0.98;
        if (phase === this.PHASES.FADE_TO_NIGHT) return 0.98 * Math.min(1, elapsed / this.FADE_TIME);
        if (phase === this.PHASES.FADE_TO_DAY) return 0.98 * Math.max(0, 1 - elapsed / this.FADE_TIME);
        return 0;
    }

    serialize() {
        return {
            phase: this.getCurrentPhase(),
            elapsedInPhase: Math.round(this.getElapsedInPhase()),
            totalElapsed: Math.round(this.elapsed),
            darkness: Math.round(this.getDarkness() * 100) / 100,
            seed: this.seed
        };
    }

    reset() {
        this.elapsed = 0;
        this.seed = Math.floor(Math.random() * 1000000);
    }
}

export default ServerDayNightManager;
