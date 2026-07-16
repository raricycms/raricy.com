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
  return { allowed: true, remaining: rule.limit - bucket.hits.length, retryAfterMs: 0 };
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
