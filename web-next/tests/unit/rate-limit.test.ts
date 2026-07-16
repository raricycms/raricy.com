// rate-limit.ts —— 进程内滑动窗口限频。
//
// 这是 Flask 侧散落在点赞/评论/投票/图床/照片墙里的 in-memory limiter 的抽取版，
// 全站配额都压在这一个函数上：算错一格，要么放水（刷赞刷图）要么误伤正常用户。
//
// 时间通过第三个参数 `now` 注入 —— 全部用例都不 sleep，窗口过期靠推进时间戳模拟。
// 注意 store 是模块级 Map 且跨用例共享，因此每个用例都用独立 key。

import { describe, it, expect } from 'vitest';
import { rateLimit, RULES } from '@/lib/rate-limit';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 每个用例一个独立 key，避免模块级 store 串味。 */
let seq = 0;
const k = (name: string) => `test:${name}:${seq++}`;

describe('窗口内计数与拒绝', () => {
  it('窗口内到达 limit 后拒绝后续请求', () => {
    const key = k('basic');
    const rule = { limit: 3, windowMs: 1000 };
    const t = 1_000_000;

    for (let i = 1; i <= 3; i++) {
      expect(rateLimit(key, rule, t).allowed, `第 ${i} 次应放行（未达 limit=3）`).toBe(true);
    }
    expect(rateLimit(key, rule, t).allowed, '第 4 次已超 limit=3，必须拒绝').toBe(false);
  });

  it('边界：恰好第 limit 次放行、第 limit+1 次拒绝（实现是 hits.length >= limit 才拒）', () => {
    const key = k('boundary');
    const rule = { limit: 5, windowMs: 1000 };
    const t = 2_000_000;

    const results = Array.from({ length: 6 }, () => rateLimit(key, rule, t).allowed);
    expect(results, 'limit=5 时应为 [放行×5, 拒绝]').toEqual([true, true, true, true, true, false]);
  });

  it('limit=1 时第一次放行、第二次即拒（最紧的边界）', () => {
    const key = k('limit1');
    const rule = { limit: 1, windowMs: 1000 };
    expect(rateLimit(key, rule, 0).allowed).toBe(true);
    expect(rateLimit(key, rule, 0).allowed).toBe(false);
  });

  it('被拒绝的请求不计入窗口（拒绝不应把封禁时间越拖越长）', () => {
    const key = k('no-penalty');
    const rule = { limit: 2, windowMs: 1000 };
    const t0 = 3_000_000;

    rateLimit(key, rule, t0);
    rateLimit(key, rule, t0); // 此时已满
    // 连续撞墙 5 次
    for (let i = 0; i < 5; i++) rateLimit(key, rule, t0 + 100);
    // 首个 hit 在 t0，窗口 1000ms，t0+1001 时它已滑出 → 应放行。
    // 若撞墙请求被记入，这里会继续被拒。
    expect(
      rateLimit(key, rule, t0 + 1001).allowed,
      '撞墙请求被误计入窗口 ⇒ 用户被无限延长限制'
    ).toBe(true);
  });
});

describe('滑动窗口过期（用 now 注入时间，不做真实 sleep）', () => {
  it('超过 windowMs 后重新放行', () => {
    const key = k('expire');
    const rule = { limit: 2, windowMs: 1000 };
    const t0 = 4_000_000;

    expect(rateLimit(key, rule, t0).allowed).toBe(true);
    expect(rateLimit(key, rule, t0).allowed).toBe(true);
    expect(rateLimit(key, rule, t0).allowed, '窗口内第 3 次应拒').toBe(false);

    expect(rateLimit(key, rule, t0 + 1001).allowed, '窗口过后应重新放行').toBe(true);
  });

  it('边界：t0+windowMs 时旧 hit 已滑出（cutoff 判定是 t > now-windowMs，严格大于）', () => {
    const key = k('exact-window');
    const rule = { limit: 1, windowMs: 1000 };
    const t0 = 5_000_000;

    expect(rateLimit(key, rule, t0).allowed).toBe(true);
    // t0 + 999：cutoff = t0-1，hit(t0) > cutoff → 仍在窗口内 → 拒绝
    expect(rateLimit(key, rule, t0 + 999).allowed, 'windowMs 内 1ms 也算窗口内').toBe(false);
    // t0 + 1000：cutoff = t0，hit(t0) > t0 为 false → 滑出 → 放行
    expect(rateLimit(key, rule, t0 + 1000).allowed, '恰好满 windowMs 时即释放').toBe(true);
  });

  it('滑动窗口是逐条过期，不是整窗清零', () => {
    const key = k('sliding');
    const rule = { limit: 2, windowMs: 1000 };
    const t0 = 6_000_000;

    rateLimit(key, rule, t0); // hit@t0
    rateLimit(key, rule, t0 + 500); // hit@t0+500 → 满
    expect(rateLimit(key, rule, t0 + 600).allowed).toBe(false);

    // t0+1000：只有 hit@t0 滑出，hit@t0+500 还在 → 放行 1 次后又满
    expect(rateLimit(key, rule, t0 + 1000).allowed, '仅最老的 hit 过期，应放行 1 次').toBe(true);
    expect(rateLimit(key, rule, t0 + 1000).allowed, 'hit@t0+500 仍占位，应再次拒绝').toBe(false);
  });
});

describe('key 隔离', () => {
  it('不同 key 互不干扰（A 被限流不能影响 B）', () => {
    const a = k('iso-a');
    const b = k('iso-b');
    const rule = { limit: 1, windowMs: 1000 };
    const t = 7_000_000;

    expect(rateLimit(a, rule, t).allowed).toBe(true);
    expect(rateLimit(a, rule, t).allowed).toBe(false); // A 已满
    expect(rateLimit(b, rule, t).allowed, '用户 A 触顶不该连坐用户 B').toBe(true);
  });

  it('同 key 不同规则共用一个计数桶（key 需自带业务前缀区分场景）', () => {
    // 语义提示：store 只按 key 分桶，rule 不参与 key。
    // 因此调用方必须用 `like:hourly:<uid>` / `like:daily:<uid>` 这类前缀区分，
    // 否则小时规则与日规则会互相消耗同一个桶。
    const key = k('shared-bucket');
    const t = 8_000_000;
    rateLimit(key, { limit: 5, windowMs: HOUR }, t);
    const r = rateLimit(key, { limit: 5, windowMs: HOUR }, t);
    expect(r.remaining, '同 key 的两次调用应累计到同一桶').toBe(3);
  });
});

describe('返回值形态', () => {
  it('allowed 时 remaining 递减、retryAfterMs 为 0', () => {
    const key = k('remaining');
    const rule = { limit: 3, windowMs: 1000 };
    const t = 9_000_000;

    expect(rateLimit(key, rule, t)).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(rateLimit(key, rule, t)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    expect(rateLimit(key, rule, t)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it('被拒时 remaining=0，retryAfterMs = 最老 hit 的剩余存活时间（可直接喂 Retry-After）', () => {
    const key = k('retry-after');
    const rule = { limit: 1, windowMs: 10_000 };
    const t0 = 10_000_000;

    rateLimit(key, rule, t0); // hit@t0，10s 后释放
    const r = rateLimit(key, rule, t0 + 3000);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterMs, '过了 3s，还需再等 7s').toBe(7000);
  });

  it('retryAfterMs 永不为负', () => {
    const key = k('non-negative');
    const rule = { limit: 2, windowMs: 1000 };
    const t0 = 11_000_000;
    rateLimit(key, rule, t0);
    rateLimit(key, rule, t0);
    const r = rateLimit(key, rule, t0 + 999);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it('不传 now 时默认取 Date.now()（生产调用方通常不传）', () => {
    const key = k('default-now');
    const rule = { limit: 1, windowMs: 60_000 };
    expect(rateLimit(key, rule).allowed).toBe(true);
    expect(rateLimit(key, rule).allowed).toBe(false);
  });
});

describe('RULES 全站配额（与 docs/全站限额与频控汇总.md 对齐，改动即报警）', () => {
  // 这些数字是产品口径，不是实现细节 —— 任何改动都应是一次有意识的决定。
  const EXPECTED = [
    { name: 'likeHourly', limit: 100, windowMs: HOUR, desc: '点赞 100 次/时' },
    { name: 'likeDaily', limit: 500, windowMs: DAY, desc: '点赞 500 次/天' },
    { name: 'commentDaily', limit: 1200, windowMs: DAY, desc: '评论 1200 次/天' },
    { name: 'voteCreateHourly', limit: 10, windowMs: HOUR, desc: '投票创建 10 次/时' },
    { name: 'voteHourly', limit: 30, windowMs: HOUR, desc: '投票 30 次/时' },
    { name: 'imageUploadHourly', limit: 75, windowMs: HOUR, desc: '图床上传 75 次/时' },
  ] as const;

  for (const e of EXPECTED) {
    it(`${e.name} = ${e.desc}`, () => {
      const rule = RULES[e.name];
      expect(rule, `RULES.${e.name} 缺失`).toBeDefined();
      expect(rule.limit, `${e.name}.limit 应为 ${e.limit}`).toBe(e.limit);
      expect(rule.windowMs, `${e.name}.windowMs 应为 ${e.windowMs}`).toBe(e.windowMs);
    });
  }

  it('RULES 的键集合完整且无多余项（新增配额需同步本用例与文档）', () => {
    expect(Object.keys(RULES).sort()).toEqual(EXPECTED.map((e) => e.name).sort());
  });

  it('RULES 可直接喂给 rateLimit（配额落地自检：第 limit+1 次被拒）', () => {
    const key = k('rules-apply');
    const t = 12_000_000;
    const rule = RULES.voteCreateHourly; // limit=10，用最小的那个跑完整轮
    for (let i = 1; i <= rule.limit; i++) {
      expect(rateLimit(key, rule, t).allowed, `第 ${i} 次`).toBe(true);
    }
    expect(rateLimit(key, rule, t).allowed, '第 11 次应被拒（voteCreateHourly=10/时）').toBe(false);
    // 一小时后释放
    expect(rateLimit(key, rule, t + HOUR).allowed, '整点滑出后应恢复').toBe(true);
  });
});
