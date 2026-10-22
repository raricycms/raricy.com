// @vitest-environment jsdom
// 双影存档（src/games/twinshade/progress.ts）的单测。
//
// 为什么必须在 jsdom 里：这个模块唯一的对外依赖就是 window.localStorage，而它存在的
// 意义正是兜住「localStorage 不是你想的那样」那几类现实 —— 不存在 / 读会抛 / 写会抛 /
// 坏 JSON / 版本不符。node 环境里 window 根本不存在，只能测到第一类，另外几条
// （恰恰是最容易让游戏开局白屏的那几条）全测不到。
//
// 【每个用例都重新 import 模块】progress.ts 里有两个模块级缓存（memory 与
// storageUsable）。storageUsable 一旦在某个用例里被置 false，后面「存储恢复后照样能读」
// 那条就会静默变成假绿；memory 也会把上一个用例的进度带进来。vi.resetModules() +
// 动态 import 是唯一能拿到干净模块的办法。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressState } from '../../src/games/twinshade/ui-types';

/** 全新玩家的状态。与 progress.ts 的 defaults() 逐字段对齐。 */
const DEFAULTS: ProgressState = {
  version: 1,
  best: {},
  seenIntro: false,
  muted: false,
  lastLevelId: null,
};

/** 拿一份「模块级缓存全清空」的 progress 模块。 */
async function freshProgress(): Promise<typeof import('../../src/games/twinshade/progress')> {
  vi.resetModules();
  return import('../../src/games/twinshade/progress');
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('读存档的容错', () => {
  it('空存档 → 默认值（全新玩家）', async () => {
    const { loadProgress } = await freshProgress();
    // 结构必须与 defaults() 逐字段一致：少一个字段会让上层 `progress.best[id]` 之类的
    // 读取静默拿到 undefined，而不是当场红。
    expect(loadProgress()).toEqual(DEFAULTS);
    expect(loadProgress()).toStrictEqual(DEFAULTS);
  });

  it('坏 JSON / 不是对象 / 版本不符 → 整体退回默认值（按约定不迁移旧版本）', async () => {
    const { loadProgress, PROGRESS_KEY } = await freshProgress();
    const raws = [
      '{not json', // 手改坏 / 写盘写了一半
      '[]', // 数组
      'null',
      '"just a string"',
      '42',
      JSON.stringify({ version: 2, best: { a1: 2 }, muted: true }), // 版本不符
      JSON.stringify({ best: { a1: 2 } }), // 缺 version
    ];
    for (const raw of raws) {
      localStorage.setItem(PROGRESS_KEY, raw);
      expect(loadProgress(), `存档串 ${raw} 应退回默认值，而不是把旧语义读进来`).toEqual(DEFAULTS);
    }
  });

  it('缺字段 → 只把那一个字段退回默认值，其余照留', async () => {
    const { loadProgress, PROGRESS_KEY } = await freshProgress();

    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ version: 1 }));
    expect(loadProgress()).toEqual(DEFAULTS);

    // best 逐条筛：0 步 / 负步 / 字符串 / 非有限数都丢掉，其余保留并取整。
    // 一条坏记录不该抹掉其它关的成绩。
    localStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({ version: 1, best: { a1: 4, a2: 0, a3: '3', a4: 2.7, a5: null }, muted: true }),
    );
    expect(loadProgress()).toEqual({
      version: 1,
      best: { a1: 4, a4: 2 },
      seenIntro: false,
      muted: true,
      lastLevelId: null,
    });

    // lastLevelId 必须是「非空字符串」，空串 / 数字都当成没续关。
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ version: 1, lastLevelId: '' }));
    expect(loadProgress().lastLevelId).toBeNull();
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ version: 1, lastLevelId: 7 }));
    expect(loadProgress().lastLevelId).toBeNull();
  });

  it('saveProgress 写盘后 loadProgress 能原样读回；存档键是 e2e 直接读的那一个', async () => {
    const { loadProgress, saveProgress, PROGRESS_KEY } = await freshProgress();
    expect(PROGRESS_KEY).toBe('twinshade_progress_v2');
    const saved: ProgressState = {
      version: 1,
      best: { a1: 3, b2: 7 },
      seenIntro: true,
      muted: true,
      lastLevelId: 'b2',
    };
    saveProgress(saved);
    expect(JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? 'null')).toEqual(saved);
    expect(loadProgress()).toEqual(saved);
  });

  it('localStorage.getItem 抛错时不崩：静默退化成默认值，且之后不再反复去撞异常', async () => {
    const { loadProgress } = await freshProgress();
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: 站点数据被禁用');
    });
    expect(() => loadProgress()).not.toThrow();
    expect(loadProgress()).toEqual(DEFAULTS);
    // storageUsable 已被置 false：第二次读不该再去调 getItem（每次操作都撞一次异常
    // 纯属浪费，隐私模式也不会在同一次页面生命周期里自己好起来）。
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('localStorage.setItem 抛错（配额满 / 隐私模式）时不崩，本次会话仍然记得进度', async () => {
    const { loadProgress, saveProgress } = await freshProgress();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const saved: ProgressState = {
      version: 1,
      best: { a1: 2 },
      seenIntro: true,
      muted: false,
      lastLevelId: 'a1',
    };
    expect(() => saveProgress(saved)).not.toThrow();
    // 写盘失败 → 之后的读直接走内存态；玩家这一局看到的进度必须还在。
    expect(loadProgress()).toEqual(saved);
  });
});

describe('starsFor：par / 宽限 / 完成 三档', () => {
  it('= par 三星；宽限 = max(2, ceil(par/2))，宽限内二星，超出即一星', async () => {
    const { starsFor } = await freshProgress();

    // par 5：宽限 max(2, ceil(2.5)) = 3 → 6..8 两星，9 起一星。
    expect(starsFor(5, 5)).toBe(3);
    expect(starsFor(6, 5)).toBe(2);
    expect(starsFor(8, 5)).toBe(2);
    expect(starsFor(9, 5)).toBe(1);

    // par 3（小关）：固定 2 步宽限 —— 多走一步就掉到一星会显得刻薄。
    expect(starsFor(3, 3)).toBe(3);
    expect(starsFor(4, 3)).toBe(2);
    expect(starsFor(5, 3)).toBe(2);
    expect(starsFor(6, 3)).toBe(1);

    // par 10：按比例宽限 5 步，才不会宽到随便乱走也两星。
    expect(starsFor(10, 10)).toBe(3);
    expect(starsFor(11, 10)).toBe(2);
    expect(starsFor(15, 10)).toBe(2);
    expect(starsFor(16, 10)).toBe(1);

    // par 是上限而不是等号：理论上走得更少也算三星（真实对局做不到，但判定不该反着来）。
    expect(starsFor(1, 4)).toBe(3);
    // 坏输入不抛：NaN 步数按最差算；NaN par 当成 par 1（宽限 2 步）。
    expect(starsFor(Number.NaN, 5)).toBe(1);
    expect(starsFor(1, Number.NaN)).toBe(3);
    expect(starsFor(3, Number.NaN)).toBe(2);
  });
});

describe('recordClear / rememberLevel / setMuted：纯函数，不改入参', () => {
  it('recordClear 只记更好的成绩：更差 / 相同都不覆盖，但 lastLevelId 一定更新', async () => {
    const { recordClear } = await freshProgress();
    const base: ProgressState = {
      version: 1,
      best: { a1: 5 },
      seenIntro: false,
      muted: false,
      lastLevelId: 'a2',
    };

    const worse = recordClear(base, 'a1', 8);
    expect(worse.best).toEqual({ a1: 5 });
    expect(worse.lastLevelId).toBe('a1'); // 刚打过的这一关才算「续关」

    const equal = recordClear(base, 'a1', 5);
    expect(equal.best).toEqual({ a1: 5 });

    const better = recordClear(base, 'a1', 3);
    expect(better.best).toEqual({ a1: 3 });
    expect(better.lastLevelId).toBe('a1');

    // 新关：没有旧成绩，直接记。
    expect(recordClear(base, 'b1', 7).best).toEqual({ a1: 5, b1: 7 });

    // 不可变：入参对象从头到尾没变（容器拿它做 useState，改了会漏渲染）。
    expect(base).toEqual({
      version: 1,
      best: { a1: 5 },
      seenIntro: false,
      muted: false,
      lastLevelId: 'a2',
    });

    // 非法步数（0 步通关在规则上不存在）一律当没发生，连 lastLevelId 都不动。
    for (const moves of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recordClear(base, 'a1', moves), `moves=${String(moves)} 不该被记成成绩`).toBe(base);
    }
  });

  it('recordClear 在「更差且 lastLevelId 已经是这一关」时返回原对象（省掉一次无谓的写盘 / 重渲染）', async () => {
    const { recordClear } = await freshProgress();
    const base: ProgressState = {
      version: 1,
      best: { a1: 2 },
      seenIntro: true,
      muted: false,
      lastLevelId: 'a1',
    };
    expect(recordClear(base, 'a1', 9)).toBe(base);
  });

  it('rememberLevel / setMuted：同值返回原对象，改值返回新对象', async () => {
    const { rememberLevel, setMuted } = await freshProgress();
    const base: ProgressState = { ...DEFAULTS };

    const remembered = rememberLevel(base, 'b2');
    expect(remembered).not.toBe(base);
    expect(remembered.lastLevelId).toBe('b2');
    expect(base.lastLevelId).toBeNull();
    expect(rememberLevel(remembered, 'b2')).toBe(remembered);
    expect(rememberLevel(base, '')).toBe(base); // 空 id = 没记住

    const muted = setMuted(base, true);
    expect(muted).not.toBe(base);
    expect(muted.muted).toBe(true);
    expect(base.muted).toBe(false);
    expect(setMuted(muted, true)).toBe(muted);
  });
});
