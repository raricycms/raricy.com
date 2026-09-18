// ─────────────────────────────────────────────────────────────────────────────
// rate-limit.ts — 限频（进程内 limiter + 快照持久化）
//
// 热路径是进程内 Map（零 IO，单机语义），但桶会**定期落盘**、
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
// 与上面的 loadSnapshot 对称：测试环境既不读也不写 —— 否则会把测试桶写进生产快照
// （要靠 tests/setup.ts 的 RATE_LIMIT_SNAPSHOT_PATH 兜底，但守卫不该只靠调用方自觉）。
// 测持久化的用例会显式调 flushSnapshot()，不受这里影响。
if (process.env.NODE_ENV !== 'test') {
  process.on('exit', () => {
    if (dirty) flushSnapshot();
  });
}

/** 仅供测试：清空所有计数桶与脏标记。 */
export function __resetRateLimitStore() {
  store.clear();
  dirty = false;
  lastSweep = 0;
}

// 全站配额以本对象为**唯一权威**（早期那份汇总文档已删除，
// 别在文档里另维护一份副本）。改数值 = 改全站行为，同步更新下面的注释口径。
//
// ── 2026-09-15：互动类配额整体放宽（用户反馈正常使用会触限）────────────────
// 背景：昨日（9/14）刚把两个日档提到 2000，一天内再撞 2000 条不可能是正常使用，
// 说明瓶颈在**分钟档与点赞档**上 —— 于是按「相关档一起放宽」处理，而不是继续
// 只抬日档（只抬日档等于让用户改撞一个锁 24 小时的天花板，比锁 60 秒惨得多）。
// 放宽的只有正常用户会摸到的几档；投票 / 登录 / 联机棋 / 鱼干转账 / 发私聊 /
// 对账轮询一概未动（它们各自防的是脚本与 CPU 放大，正常人离得很远）。
//
// ⚠️ **分钟档与日档必须一起看**：日档要 ≥ 分钟档 × 一段合理时长，否则放宽分钟档
// 只是把撞墙时间往后推，撞的还是同一个日档，而日档一撞就是锁满整个滑动窗口。
export const RULES = {
  likeHourly: { limit: 300, windowMs: 60 * 60 * 1000 },
  likeDaily: { limit: 1500, windowMs: 24 * 60 * 60 * 1000 },
  commentDaily: { limit: 8000, windowMs: 24 * 60 * 60 * 1000 },
  voteCreateHourly: { limit: 10, windowMs: 60 * 60 * 1000 },
  voteHourly: { limit: 30, windowMs: 60 * 60 * 1000 },
  imageUploadHourly: { limit: 200, windowMs: 60 * 60 * 1000 },
  /** 讨论发言（滑动窗口）。**拍一拍 / 表情 / 带图消息各算一条** —— 连拍或连点表情
   *  时消耗得比打字快得多，这是它当初 30/分 被正常人摸到的主因。 */
  chatMinute: { limit: 120, windowMs: 60 * 1000 },
  chatDaily: { limit: 8000, windowMs: 24 * 60 * 60 * 1000 },
  /** 讨论对账轮询：实时消息已走 SSE，正常客户端约 1~2 次/分钟/标签页；
   *  这个额度只用来兜住异常客户端（它是全站最重的接口）。 */
  chatPoll: { limit: 120, windowMs: 60 * 1000 },
  /** 发起私聊（可能建新频道行）：防脚本批量建空会话骚扰他人侧栏。 */
  chatNewChannel: { limit: 20, windowMs: 60 * 1000 },
  /**
   * 登录限频（新增档：限频表里原来没有它）。
   * 两个维度分别计数，任一超限即 429，且**只统计失败**（见 isRateLimited）：
   *   · IP —— 挡「一台机器扫一批账号」；
   *   · 用户名（小写归一）—— 挡「一批机器打同一个账号」。
   * 顺带也是 CPU 保护：每次尝试都要跑一次 scrypt。
   */
  loginPerIp: { limit: 300, windowMs: 15 * 60 * 1000 },
  loginPerUser: { limit: 100, windowMs: 15 * 60 * 1000 },
  /**
   * 鱼干转账（鱼干市场）。**唯一有配额的鱼干写路径** —— 投喂 / 签到 / CLI 都没有，
   * 因为它们只能把钱给「文章作者」或「系统」，而转账是唯一能把鱼干推给任意第三方的
   * 路径：没有配额的话，一个脚本能把鱼干当消息刷给别人（连带刷出站内通知）。
   * 键必须自带自己的前缀（transfer:h: / transfer:d:）—— rule 不参与分桶，
   * 复用别的前缀会与那边共用计数桶、互相吃额度。
   */
  transferHourly: { limit: 30, windowMs: 60 * 60 * 1000 },
  transferDaily: { limit: 200, windowMs: 24 * 60 * 60 * 1000 },
  /**
   * 鱼干市场的**无状态**接口（凭据随请求走，不签发会话）。
   * **成功也计数** —— 与会话路径不同：无状态路径每次请求都要跑一次 scrypt
   * （32MB + 数十毫秒），不封顶就是一个廉价的 CPU / 内存放大器；
   * 会话路径只验 JWT，不花这个 CPU，因此不消耗这条配额。
   * 桶键：fish-api:{用户名小写} / fish-api:ip:{IP}。
   * 失败另有更紧的一道：与 /api/auth/login 共用 login:user: / login:ip:（见 credential-auth.ts）。
   */
  fishApiPerUser: { limit: 20, windowMs: 60 * 1000 },
  fishApiPerIp: { limit: 120, windowMs: 60 * 1000 },
  /**
   * 画报 / 收款码的 PNG 生成。一次请求 = 一次 sharp 光栅化（1500×2480，几十毫秒 CPU），
   * 不封顶就能被拿来烤 CPU。桶键：poster:{用户 id}。
   * 预览与下载各算一次，30/分对正常使用绰绰有余。
   */
  posterMinute: { limit: 30, windowMs: 60 * 1000 },
  /**
   * 新建收藏夹。对照 voteCreateHourly（10/h）取宽松一档 —— 收藏夹是**用户整理自己
   * 书签**的动作，正常人手速也就建几个；真正的总量闸是 FAVORITE_PER_USER_MAX=200
   * （在 favorite-service 里用 count 判，不是 RULES）。桶键：fav:create:{用户 id}。
   * 复制收藏夹**共用这条**（键前缀相同）—— 否则复制就是绕过创建限频的后门。
   */
  favoriteCreateHourly: { limit: 20, windowMs: 60 * 60 * 1000 },
  /**
   * 导入收藏夹。一次请求最多写 1000 条（FAVORITE_ITEMS_MAX），是本站最重的用户写
   * 路径之一（N 条 upsert 在一个事务里），所以给得比创建紧一半。
   * 桶键：fav:import:{用户 id}。
   */
  favoriteImportHourly: { limit: 10, windowMs: 60 * 60 * 1000 },
  /**
   * 收藏夹的**免认证**读取（/api/spider/favorites/:id）—— 全站唯一无会话的收藏夹
   * 出口，没有会话就没法按用户分桶，只能按 IP。
   *
   * 【为什么必须有】spider 命名空间现有的三条路由**都没有限频**（历史遗留）：
   * 它们只按 id 查单篇内容，滥用成本低。收藏夹这条会一次带出整个列表，是新加的
   * 唯一一个有闸的 —— 别因为「邻居都没有」而把它删掉。
   * 取不到 IP 时跳过该维度（见 credential-auth.ts 的 clientIp 约定，别传占位串）。
   * 桶键：spider:fav:ip:{IP}。
   */
  spiderFavoritePerIp: { limit: 120, windowMs: 60 * 1000 },
} as const;
