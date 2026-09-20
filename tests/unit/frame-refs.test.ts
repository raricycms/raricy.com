// frame-refs.ts —— 头像框的词汇表与**到期判定**。
//
// 【为什么这块值得单独钉】
//  1. **到期比较全仓只有这一处**（见 frame-refs.ts 文件头）。它写错的症状是
//     「那一处永远戴着框、到期不消失」—— 不报错、不 500、日志里什么都没有。
//     边界（null = 永久 / 相同时刻算未过期）在这里钉死，比在 15 个渲染点里各判一次可靠。
//  2. **`FRAMES` 必须穷尽 `FRAME_KEYS`**：漏补一条的后果是设置面板少一张卡片、CLI
//     的选项里没有它 —— 都静默。tsc 会拦（`Record<FrameKey, FrameDef>`），
//     这里再钉一遍是为了让「加了 key 却把 FRAMES 写成别的形状」也能红。
//  3. **retired 的语义**（下架≠删除）是「用户还能卸下它」这条能力的唯一保障。
//
// 【为什么可以改 FRAMES】本文件测的是**真实代码路径**，而白名单里目前只有一个
// 在架的 key —— 不临时改一条出来，retired 分支就测不到（未测的分支等于没有）。
// FRAMES 是可变的普通对象，afterEach 会还原。用例串行执行（同文件内），不并行泄漏。

import { describe, it, expect, afterEach } from 'vitest';

import {
  FRAME_KEYS,
  FRAMES,
  FRAME_URL_PREFIX,
  frameLabel,
  frameUrl,
  isFrameExpired,
  parseFrameKey,
  resolveFrameKey,
} from '@/lib/frame-refs';

const DEMO = FRAME_KEYS[0];

/**
 * 白名单的出厂快照。上面那几个用例会临时把 `DEMO` 改成 retired 来跑真实分支，
 * afterEach 用它逐条还原 —— **快照 + 无条件还原**，而不是靠每个用例自己写在
 * `finally` 里：漏写一个就泄漏给后续用例，而泄漏的症状是「别的用例莫名其妙红了」，
 * 那种失败最难查。
 */
const PRISTINE = Object.fromEntries(FRAME_KEYS.map((k) => [k, { ...FRAMES[k] }])) as typeof FRAMES;

/** 冻一个固定时刻当基准，避免用真实时钟（与库里的「同一把钟」纪律一致）。 */
const T0 = new Date('2026-09-20T12:00:00.000Z');
const before = (ms: number) => new Date(T0.getTime() - ms);
const after = (ms: number) => new Date(T0.getTime() + ms);

// ── FRAMES 与 FRAME_KEYS 的穷尽性 ───────────────────────────────────────────

describe('FRAMES 与 FRAME_KEYS', () => {
  it('键集完全相等（加 key 不补条目、或补了多余条目，都该红）', () => {
    expect(Object.keys(FRAMES).sort()).toEqual([...FRAME_KEYS].sort());
  });

  it('每条都有非空的 label 与 description', () => {
    for (const k of FRAME_KEYS) {
      expect(FRAMES[k].label.length, k).toBeGreaterThan(0);
      expect(FRAMES[k].description.length, k).toBeGreaterThan(0);
    }
  });

  it('key 是标识符形状 —— 它会被当成磁盘文件名 <key>.png', () => {
    // 含 / 或 .. 的 key 会让 frame-service 拼出一个目录外的路径。
    // 白名单是手写的，所以这条是「防手滑」而不是「防攻击」；
    // 真正的纵深防御在 frame-service 的 dirname 断言。
    for (const k of FRAME_KEYS) expect(k, k).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

// ── parseFrameKey ──────────────────────────────────────────────────────────

describe('parseFrameKey', () => {
  it('白名单内的 key 原样返回', () => {
    expect(parseFrameKey(DEMO)).toBe(DEMO);
  });

  it.each([
    ['未登记的字符串', 'no-such-frame'],
    ['空串', ''],
    ['undefined', undefined],
    ['null', null],
    ['数字', 7],
    ['对象', { key: DEMO }],
    ['数组', [DEMO]],
    ['字符串化后的 null', 'null'],
  ])('%s → null（由调用方报 400，不静默兜底）', (_label, raw) => {
    expect(parseFrameKey(raw)).toBeNull();
  });

  it('大小写敏感 —— 白名单是精确匹配，不做归一化', () => {
    expect(parseFrameKey(DEMO.toUpperCase())).toBeNull();
  });
});

// ── frameUrl / frameLabel ──────────────────────────────────────────────────

describe('frameUrl', () => {
  it('形状 = 前缀 + key，无编码（key 已是标识符形状）', () => {
    expect(frameUrl(DEMO)).toBe(`${FRAME_URL_PREFIX}${DEMO}`);
  });
});

describe('frameLabel', () => {
  it('已知 key 给显示名', () => {
    expect(frameLabel(DEMO)).toBe(FRAMES[DEMO].label);
  });

  it('未知 key → null（界面据此显示「未知」，而不是编一个名字）', () => {
    expect(frameLabel('no-such-frame')).toBeNull();
  });

  it('退役的 key 照常给名字 —— 否则面板只能显示一行机器值', () => {
    FRAMES[DEMO] = { ...PRISTINE[DEMO], retired: true };
    expect(frameLabel(DEMO)).toBe(PRISTINE[DEMO].label);
  });
});

// ── isFrameExpired：全仓唯一的到期比较 ─────────────────────────────────────

describe('isFrameExpired', () => {
  it('null / undefined = 永久，永远不过期', () => {
    expect(isFrameExpired(null, T0)).toBe(false);
    expect(isFrameExpired(undefined, T0)).toBe(false);
  });

  it('★ 相同时刻算【未】过期（用 > 不是 >=，与 isCurrentlyBanned 同口径）', () => {
    expect(isFrameExpired(T0, T0)).toBe(false);
  });

  it('早一毫秒：未过期', () => {
    expect(isFrameExpired(after(1), T0)).toBe(false);
  });

  it('晚一毫秒：已过期', () => {
    expect(isFrameExpired(before(1), T0)).toBe(true);
  });

  it('跨日边界比的是绝对时刻，不做任何本地日历运算', () => {
    // 到期时刻是一个「墙上时间贴 Z 标签」的值（见 db-time.ts）。本函数必须只做
    // 时刻比较 —— 一旦混进本地日历 / 时区换算，跨日这 1 毫秒会变成 8 小时的偏差，
    // 而那正是「30 天的框实际生效 29 天 16 小时」那类没人会发现的错误。
    const lastMs = new Date('2026-09-20T23:59:59.999Z');
    expect(isFrameExpired(lastMs, new Date('2026-09-21T00:00:00.000Z'))).toBe(true);
    expect(isFrameExpired(lastMs, lastMs)).toBe(false);
  });
});

// ── resolveFrameKey：白名单 → 未退役 → 未过期 ──────────────────────────────

describe('resolveFrameKey', () => {
  it('在架 + 未过期 → 返回 key', () => {
    expect(resolveFrameKey(DEMO, after(1000), T0)).toBe(DEMO);
  });

  it('在架 + 永久 → 返回 key', () => {
    expect(resolveFrameKey(DEMO, null, T0)).toBe(DEMO);
  });

  it('已过期 → null', () => {
    expect(resolveFrameKey(DEMO, before(1), T0)).toBeNull();
  });

  it('未知 key（数据脏 / 白名单里删过）→ null', () => {
    expect(resolveFrameKey('no-such-frame', null, T0)).toBeNull();
  });

  it('key 为 null → null（没装备）', () => {
    expect(resolveFrameKey(null, null, T0)).toBeNull();
  });

  it('★ 退役的框 → null，即使永久且未到期（下架即刻失效）', () => {
    FRAMES[DEMO] = { ...PRISTINE[DEMO], retired: true };
    expect(resolveFrameKey(DEMO, null, T0)).toBeNull();
    expect(resolveFrameKey(DEMO, after(1000), T0)).toBeNull();
  });

  it('未过期但将要过期 —— 到最后那一毫秒仍返回 key', () => {
    expect(resolveFrameKey(DEMO, T0, T0)).toBe(DEMO);
  });
});

// ── 还原（防御性）───────────────────────────────────────────────────────────

afterEach(() => {
  for (const k of FRAME_KEYS) FRAMES[k] = { ...PRISTINE[k] };
});
