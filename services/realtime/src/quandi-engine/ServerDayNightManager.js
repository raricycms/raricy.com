// Adapted from yao1145/quandiyundong @ b1050bd177fa9764afd039f2ec6e68af55137436.
// 原作者授权及本地修改说明见 public/static/quandi/NOTICE.txt。
/**
 * ServerDayNightManager — 服务端昼夜循环管理器
 * 维护一个权威相位计时，广播给客户端做本地渲染
 */

import { QUANDI_DAYNIGHT } from '../../../../shared/quandi/rules';

class ServerDayNightManager {
    constructor() {
        this.PHASES = {
            DAY: 'day',
            FADE_TO_NIGHT: 'fadeToNight',
            NIGHT: 'night',
            FADE_TO_DAY: 'fadeToDay'
        };
        // 昼夜时序是「规则」不是实现细节：五个值全部来自 shared/quandi/rules.ts，
        // 客户端 Config.js 的 DAYNIGHT 必须与它同值（R3-596）。
        this.FADE_TIME = QUANDI_DAYNIGHT.fadeTime;
        this.DARK_TIME = QUANDI_DAYNIGHT.darkTime;
        this.CYCLE_TIME = QUANDI_DAYNIGHT.cycleTime;
        this.INITIAL_DAY_TIME = QUANDI_DAYNIGHT.initialTime;

        this.elapsed = 0;
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
        if (phase === this.PHASES.NIGHT) return QUANDI_DAYNIGHT.darkness;
        if (phase === this.PHASES.FADE_TO_NIGHT) return QUANDI_DAYNIGHT.darkness * Math.min(1, elapsed / this.FADE_TIME);
        if (phase === this.PHASES.FADE_TO_DAY) return QUANDI_DAYNIGHT.darkness * Math.max(0, 1 - elapsed / this.FADE_TIME);
        return 0;
    }

    serialize() {
        return {
            phase: this.getCurrentPhase(),
            elapsedInPhase: Math.round(this.getElapsedInPhase()),
            totalElapsed: Math.round(this.elapsed),
            darkness: Math.round(this.getDarkness() * 100) / 100
        };
    }
}

export default ServerDayNightManager;

