// 一局游戏的状态机（src/games/twinshade/session.ts）。
//
// 钉 R3-544：容器用 `${level.id}:${serial}` 做通关去重键（TwinShade.tsx 的
// solvedKeyRef）。如果 `load` 把 serial 重置回 1，重进同一关、用同样步数再通关时
// 键会与上次相同 —— recordClear / 通关音 / 结算弹层会被整体跳过，玩家只看到
// 「通关了但没记成绩」。serial 必须跨换关继续单调递增。

import { describe, expect, it } from 'vitest';
import { compileLevel } from '../../src/games/twinshade/engine';
import { LEVELS } from '../../src/games/twinshade/levels';
import { createSession, sessionReducer } from '../../src/games/twinshade/session';

const levels = LEVELS.map((def) => compileLevel(def));
const secondIndex = levels.length > 1 ? 1 : 0;

describe('Twinshade 会话：换关不重置 serial（R3-544）', () => {
  it('load 让 serial 继续递增，而不是回到 1', () => {
    const first = createSession(levels, 0);
    expect(first.serial).toBe(1);

    const reloaded = sessionReducer(levels, first, { type: 'load', index: 0 });
    expect(reloaded.serial).toBeGreaterThan(first.serial);

    const switched = sessionReducer(levels, reloaded, { type: 'load', index: secondIndex });
    expect(switched.serial).toBeGreaterThan(reloaded.serial);
  });

  it('重进同一关不会撞回旧的去重键', () => {
    const first = createSession(levels, 0);
    // 模拟「上一轮通关时 serial 已经是 7」：再 load 回同一关，键不能再是 7。
    const solved = { ...first, serial: 7, solved: true, last: 'move' as const };
    const reloaded = sessionReducer(levels, solved, { type: 'load', index: 0 });

    const key = (serial: number) => `${levels[0].id}:${serial}`;
    expect(key(reloaded.serial)).not.toBe(key(solved.serial));
    expect(reloaded.solved).toBe(false);
    expect(reloaded.levelIndex).toBe(0);
  });

  it('restart 之后 serial 也继续递增', () => {
    const session = createSession(levels, 0);
    const restarted = sessionReducer(levels, session, { type: 'restart' });
    expect(restarted.serial).toBeGreaterThan(session.serial);
  });
});
