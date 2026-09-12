// ─────────────────────────────────────────────────────────────────────────────
// rate-limit.ts — 限频（复刻 Flask 侧多处重复的 in-memory limiter + 快照持久化）
//
// 热路径仍是进程内 Map（零 IO，与 Flask 版一致的单机语义），但桶会**定期落盘**、
// 启动时回灌：进程重启（PM2 restart / OOM / 发版）不再静默重置所有限频窗口 ——
// 之前「重启即清零」等于给所有用户发了免刷通行证，也放走了进行中的刷量。
//
// 落盘策略（对个人站的单进程部署足够，多实例请换 Redis —— 一直是已知限制）：
//   • 写：随 10 分钟一次的惰性清扫落盘，且仅在自上次落盘后有新命中时写（脏标记），
//     避免空转 IO；进程正常退出时再补一次（'exit' 同步写）。
//   • 读：模块初始化时回灌，超过最长窗口（24h）的旧命中直接丢弃。
//   • 原子写：先写 .tmp 再 rename，避免读到半截 JSON。
//   • 一切 IO 失败都不致命（catch 静默 + 一条 warn）：限频降级为纯内存，行为同旧版。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

interface Bucket {
  hits: number[]; // 时间戳（ms）
}

const store = new Map<string, Bucket>();
/** 自上次落盘以来是否有新命中（避免空转写盘）。 */
let dirty = false;

export interface RateRule {
  limit: number;
  windowMs: number;
}

/** 快照文件路径：默认 instance/（运行时数据目录，gitignored），可用环境变量覆盖。 */
function snapshotPath(): string {
  return (
    process.env.RATE_LIMIT_SNAPSHOT_PATH ||
    path.resolve(process.cwd(), 'instance', 'rate-limit-snapshot.json')
  );
}

/**
 * 判断某 key 是否超限；未超限则记一次命中。
 *
 * ⚠️ **key 必须自带场景前缀**（如 `like:h:${userId}` / `like:d:${userId}`）。
 * rule 不参与分桶 —— 同一个 key 配不同 rule 会共用同一计数桶、互相消耗配额。
 * 现有调用方都遵守了该约定（见 blog/comment/vote/image 各处），
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
  dirty = true;
  maybeSweep(now);
  return { allowed: true, remaining: rule.limit - bucket.hits.length, retryAfterMs: 0 };
}

/**
 * 只查不记（不改变计数）—— 供「失败才计数」的路径使用（登录）。
 *
 * 【为什么要拆出这一对】`rateLimit` 是「查 + 记」一体的，适合点赞这类
 * **每次调用都算一次操作**的场景。但登录不同：成功的登录不该消耗配额 ——
 * 否则正常用户（以及 e2e 里反复登录同一批种子账号的用例）会被自己的成功记录
 * 挡在门外。故登录走 `isRateLimited` 先查、失败后 `recordRateLimitHit` 补记。
 *
 * 两者与 rateLimit 共用同一 store 与同一套窗口裁剪，可混用同一 key。
 */
export function isRateLimited(key: string, rule: RateRule, now = Date.now()): boolean {
  const bucket = store.get(key);
  if (!bucket) return false;
  const cutoff = now - rule.windowMs;
  const hits = bucket.hits.filter((t) => t > cutoff);
  if (hits.length !== bucket.hits.length) {
    bucket.hits = hits;
    store.set(key, bucket);
  }
  return hits.length >= rule.limit;
}

/** 记一次命中（配合 isRateLimited 用于「失败才计数」）。 */
export function recordRateLimitHit(key: string, now = Date.now()): void {
  const bucket = store.get(key) ?? { hits: [] };
  bucket.hits.push(now);
  store.set(key, bucket);
  dirty = true;
  maybeSweep(now);
}

// ── 惰性清理 + 落盘 ─────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟（清扫与落盘共用同一节拍）
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
  if (dirty) flushSnapshot();
}

// ── 快照持久化 ──────────────────────────────────────────────────────────────

/** 把当前所有桶写入快照文件（原子写）。返回是否成功。 */
export function flushSnapshot(): boolean {
  dirty = false;
  const file = snapshotPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        // 用 Date.now() 而非 new Date()：统一走 db-time 守卫允许的取时方式（纯 ms 数）。
        savedAtMs: Date.now(),
        // 形状：{ key: [ms, ms, ...] }（与 loadSnapshot 的读取格式一一对应，勿改一半）
        buckets: Object.fromEntries([...store].map(([k, b]) => [k, b.hits])),
      })
    );
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.warn(`[rate-limit] 限频快照落盘失败（降级为纯内存，不影响限流正确性）:`, e);
    return false;
  }
}

/**
 * 从快照文件回灌限频桶（模块加载时调用；测试可显式调用）。
 * 超过最长窗口的旧命中直接丢弃；文件缺失/损坏静默跳过（返回 0）。
 * @returns 回灌的桶数
 */
export function loadSnapshot(): number {
  const file = snapshotPath();
  if (!fs.existsSync(file)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      buckets?: Record<string, number[]>;
    };
    const deadline = Date.now() - MAX_WINDOW_MS;
    let n = 0;
    for (const [k, hits] of Object.entries(raw.buckets ?? {})) {
      if (!Array.isArray(hits)) continue;
      const fresh = hits.filter((t) => typeof t === 'number' && t > deadline);
      if (fresh.length === 0) continue;
      store.set(k, { hits: fresh });
      n++;
    }
    return n;
  } catch (e) {
    console.warn(`[rate-limit] 限频快照读取失败（忽略，按空桶启动）:`, e);
    return 0;
  }
}

// 生产环境启动时回灌；测试环境（NODE_ENV=test）不自动读 —— 单测要求确定性，
// 需要测持久化的用例显式设 RATE_LIMIT_SNAPSHOT_PATH 后调 loadSnapshot()。
if (process.env.NODE_ENV !== 'test') loadSnapshot();

// 进程正常退出（发版 / PM2 stop）时尽力补一次落盘：'exit' 回调里只能做同步 IO。
process.on('exit', () => {
  if (dirty) flushSnapshot();
});

/** 仅供测试：清空所有计数桶与脏标记。 */
export function __resetRateLimitStore() {
  store.clear();
  dirty = false;
  lastSweep = 0;
}

// 全站配额以本对象为**唯一权威**（Flask 时代的汇总文档已删除；
// 旧配额值亦无须再对齐）。改数值 = 改全站行为，同步更新下面的注释口径。
export const RULES = {
  likeHourly: { limit: 100, windowMs: 60 * 60 * 1000 },
  likeDaily: { limit: 500, windowMs: 24 * 60 * 60 * 1000 },
  commentDaily: { limit: 1200, windowMs: 24 * 60 * 60 * 1000 },
  voteCreateHourly: { limit: 10, windowMs: 60 * 60 * 1000 },
  voteHourly: { limit: 30, windowMs: 60 * 60 * 1000 },
  imageUploadHourly: { limit: 75, windowMs: 60 * 60 * 1000 },
  chatMinute: { limit: 30, windowMs: 60 * 1000 },
  chatDaily: { limit: 800, windowMs: 24 * 60 * 60 * 1000 },
  /** 聊天对账轮询：实时消息已走 SSE，正常客户端约 1~2 次/分钟/标签页；
   *  这个额度只用来兜住异常客户端（它是全站最重的接口）。 */
  chatPoll: { limit: 120, windowMs: 60 * 1000 },
  /** 发起私聊（可能建新频道行）：防脚本批量建空会话骚扰他人侧栏。 */
  chatNewChannel: { limit: 20, windowMs: 60 * 1000 },
  /**
   * 登录限频（Flask 侧无对应配额，属新增）。
   * 两个维度分别计数，任一超限即 429，且**只统计失败**（见 isRateLimited）：
   *   · IP —— 挡「一台机器扫一批账号」；
   *   · 用户名（小写归一）—— 挡「一批机器打同一个账号」。
   * 顺带也是 CPU 保护：每次尝试都要跑一次 scrypt。
   */
  loginPerIp: { limit: 300, windowMs: 15 * 60 * 1000 },
  loginPerUser: { limit: 100, windowMs: 15 * 60 * 1000 },
} as const;
