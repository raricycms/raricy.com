// ─────────────────────────────────────────────────────────────────────────────
// store.ts — 演示用的挑战存储（内存，进程内）。
//
// 【挂在 globalThis 上，不是模块级变量】本仓库踩过这个坑：Next 会把
//   `instrumentation.ts` 编进**独立的 compilation**，同一个 lib 模块于是在同一份产物里
//   存在两份实例 —— 模块级变量会变成「A 写入、B 读到空」，**不报任何错**
//   （见 src/lib/market-price.ts 头部）。演示路由眼下只有一份，但这条纪律照抄成本为零，
//   而踩中的代价是「挑战一直不存在」这种极难查的症状。
//
// 【时钟：用 Date.now()，不是 nowForDb()】这是**进程内的短命缓存**，不是库内时间戳 ——
//   它不写库、不渲染、不与任何 `getUTC*` / 库内 `Date` 相遇，因此不存在「两把钟相减」
//   那个静默 8 小时错（db-time-guard 的五条规则一条都不适用，它也不命中任何正则）。
//   反过来，若这里硬套 nowForDb()，TTL 在日志里会显示成 8 小时之后到期 —— 更误导。
//   ⚠️ 判据是「它会不会与库内时间戳相遇」；将来若把挑战落库，这里必须整体换成库内钟。
//
// 【一次性】takeChallenge 取走即删除（无论后面判过还是判不过）—— 重放同一份解答是
//   滑块验证码最经典的绕过方式。别改成「判过才删」。
// ─────────────────────────────────────────────────────────────────────────────

export interface Challenge {
  id: string;
  /** 挑战绑定的用户 —— 否则 A 的解可以给 B 用。 */
  userId: string;
  /** 正确答案：滑块的目标位移（px）。 */
  answerX: number;
  /** 滑块可走的最大位移（px）。 */
  maxOffset: number;
  pieceSize: number;
  width: number;
  height: number;
  pieceY: number;
  createdAt: number;
  expiresAt: number;
}

interface StoreState {
  challenges: Map<string, Challenge>;
  /** 指纹 → 出现次数，用来抓「同一个生成器批量刷」。 */
  fingerprints: Map<string, number>;
}

type GlobalWithStore = typeof globalThis & { __raricyCaptchaDemoStore?: StoreState };

/** 挑战有效期。够人慢慢拖，又不足以让人批量囤起来解题。 */
const TTL_MS = 2 * 60 * 1000;
/** 上限，防止无界增长（也顺带限制了并发生成图片的开销）。 */
const MAX_CHALLENGES = 500;
/** 指纹表同样有上限 —— 它是全进程共享的，不设界就是一条内存泄漏。 */
const MAX_FINGERPRINTS = 2000;

function store(): StoreState {
  const g = globalThis as GlobalWithStore;
  if (!g.__raricyCaptchaDemoStore) {
    g.__raricyCaptchaDemoStore = { challenges: new Map(), fingerprints: new Map() };
  }
  return g.__raricyCaptchaDemoStore;
}

/** 清掉过期的；超上限时按创建时间丢最老的。 */
function sweep(s: StoreState, now: number): void {
  for (const [id, c] of s.challenges) {
    if (c.expiresAt <= now) s.challenges.delete(id);
  }
  while (s.challenges.size > MAX_CHALLENGES) {
    // Map 保持插入顺序，第一个就是最老的
    const oldest = s.challenges.keys().next();
    if (oldest.done) break;
    s.challenges.delete(oldest.value);
  }
}

export function putChallenge(c: Omit<Challenge, 'createdAt' | 'expiresAt'>): Challenge {
  const s = store();
  const now = Date.now();
  sweep(s, now);
  const full: Challenge = { ...c, createdAt: now, expiresAt: now + TTL_MS };
  s.challenges.set(full.id, full);
  return full;
}

/**
 * 取走并作废一份挑战。**一次性**：无论判定结果如何，这一份都不会再有第二次。
 * 用户不匹配 / 不存在 / 已过期一律返回 null（调用方统一报「挑战不存在或已过期」，
 * 不区分 —— 区分等于告诉攻击者他猜的 id 存不存在）。
 */
export function takeChallenge(id: string, userId: string): Challenge | null {
  const s = store();
  const now = Date.now();
  sweep(s, now);
  const c = s.challenges.get(id);
  if (!c) return null;
  s.challenges.delete(id);
  if (c.userId !== userId) return null;
  if (c.expiresAt <= now) return null;
  return c;
}

/** 记一次指纹，返回**含本次在内**的同一指纹出现次数（1 = 首次见到）。 */
export function noteFingerprint(fp: string): number {
  const s = store();
  const next = (s.fingerprints.get(fp) ?? 0) + 1;
  s.fingerprints.set(fp, next);
  if (s.fingerprints.size > MAX_FINGERPRINTS) {
    const oldest = s.fingerprints.keys().next();
    if (!oldest.done) s.fingerprints.delete(oldest.value);
  }
  return next;
}

/** 运维口：看一眼内存里还剩什么。 */
export function storeStats(): { challenges: number; fingerprints: number } {
  const s = store();
  return { challenges: s.challenges.size, fingerprints: s.fingerprints.size };
}
