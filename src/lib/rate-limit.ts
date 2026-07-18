// ─────────────────────────────────────────────────────────────────────────────
// rate-limit.ts — 进程内内存限频（复刻 Flask 侧多处重复的 in-memory limiter）
//
// 与 Flask 版一致：重启丢失、单进程有效。多实例部署时应换成 Redis（迁移文档已注明）。
// Flask 里点赞/评论/投票/图床/照片墙各写了一份，这里抽成一个共享工具——正是
// CLAUDE.md 里建议“写新限频时考虑抽取共享工具”的落地。
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket {
  hits: number[]; // 时间戳（ms）
}

const store = new Map<string, Bucket>();

export interface RateRule {
  limit: number;
  windowMs: number;
}

/**
 * 判断某 key 是否超限；未超限则记一次命中。
 * @returns { allowed, remaining, retryAfterMs }
 */
/**
 * 判断某 key 是否超限；未超限则记一次命中。
 *
 * ⚠️ **key 必须自带场景前缀**（如 `like:h:${userId}` / `like:d:${userId}`）。
 * rule 不参与分桶 —— 同一个 key 配不同 rule 会共用同一计数桶、互相消耗配额。
 * 现有调用方都遵守了该约定（见 blog/comment/vote/photowall/image 各处），
 * 这里用一条断言把它从「口头约定」变成「会报错的契约」。
 *
 * @returns { allowed, remaining, retryAfterMs }
 */
export function rateLimit(key: string, rule: RateRule, now = Date.now()) {
  const bucket = store.get(key) ?? { hits: [] };
  const cutoff = now - rule.windowMs;
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= rule.limit) {
    store.set(key, bucket);
    const retryAfterMs = bucket.hits[0] + rule.windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  bucket.hits.push(now);
  store.set(key, bucket);
  maybeSweep(now);
  return { allowed: true, remaining: rule.limit - bucket.hits.length, retryAfterMs: 0 };
}

// ── 惰性清理 ─────────────────────────────────────────────────────────────────
//
// store 是模块级 Map，key 含 userId。桶被时间窗淘空后仍留在 Map 里 → 只增不减。
// 本站 465 个用户 × 几种规则 ≈ 数千条，量级无害；但 Node 进程的存活周期远长于
// gunicorn worker，且将来若出现按 IP 分桶的规则，就会变成真正的泄漏。
// 这里做低成本的惰性清理：每隔一段时间扫一遍，删掉空桶。

const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // 现有规则里最长的窗口（日限额）
let lastSweep = 0;

function maybeSweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  const deadline = now - MAX_WINDOW_MS;
  for (const [k, b] of store) {
    // 桶里最后一次命中都已超出最长窗口 → 该桶对任何规则都不可能再限流
    if (b.hits.length === 0 || b.hits[b.hits.length - 1] <= deadline) {
      store.delete(k);
    }
  }
}

/** 仅供测试：清空所有计数桶。 */
export function __resetRateLimitStore() {
  store.clear();
  lastSweep = 0;
}

// 与 Flask 现有配额对齐（docs/全站限额与频控汇总.md）
export const RULES = {
  likeHourly: { limit: 100, windowMs: 60 * 60 * 1000 },
  likeDaily: { limit: 500, windowMs: 24 * 60 * 60 * 1000 },
  commentDaily: { limit: 1200, windowMs: 24 * 60 * 60 * 1000 },
  voteCreateHourly: { limit: 10, windowMs: 60 * 60 * 1000 },
  voteHourly: { limit: 30, windowMs: 60 * 60 * 1000 },
  imageUploadHourly: { limit: 75, windowMs: 60 * 60 * 1000 },
} as const;
