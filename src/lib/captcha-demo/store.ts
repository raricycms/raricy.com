import type { SceneObject, Instruction } from './vision-task';

// ─────────────────────────────────────────────────────────────────────────────
// store.ts — 演示用的挑战存储（内存，进程内）。两种题型共用一张表。
//
// 【为什么用判别联合而不是两张表】两种挑战的公共部分（id / 归属 / 过期 / 一次性消费）
//   完全一样，分开写就要维护两套 sweep 与清理策略 —— 而清理恰恰是最容易写漏、
//   漏了又只是「内存慢慢涨」的地方。用 kind 判别，公共逻辑只有一份。
//
// 【挂在 globalThis 上，不是模块级变量】本仓库踩过这个坑：Next 会把 instrumentation.ts
//   编进**独立的 compilation**，同一个 lib 模块于是在同一份产物里存在两份实例 ——
//   模块级变量会变成「A 写入、B 读到空」，**不报任何错**（见 src/lib/market-price.ts 头部）。
//   演示路由眼下只有一份，但这条纪律照抄成本为零，而踩中的代价是「挑战一直不存在」
//   这种极难查的症状。
//
// 【时钟：用 Date.now()，不是 nowForDb()】这是**进程内的短命缓存**，不是库内时间戳 ——
//   它不写库、不渲染、不与任何 getUTC* / 库内 Date 相遇，因此不存在「两把钟相减」那个
//   静默 8 小时错（db-time-guard 的五条规则一条都不适用）。
//   反过来，若硬套 nowForDb()，TTL 在日志里会显示成 8 小时之后到期 —— 更误导。
//   ⚠️ 判据是「它会不会与库内时间戳相遇」；将来若把挑战落库，这里必须整体换成库内钟。
//
// 【一次性】takeChallenge 取走即删除（无论后面判过还是判不过）—— 重放同一份解答是
//   验证码最经典的绕过方式。别改成「判过才删」。
// ─────────────────────────────────────────────────────────────────────────────

export interface ChallengeBase {
  id: string;
  /** 挑战绑定的用户 —— 否则 A 的解可以给 B 用。 */
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/** 滑块题型：答案是「拼图块该落在哪个 x」。 */
export interface SliderChallenge extends ChallengeBase {
  kind: 'slider';
  answerX: number;
  maxOffset: number;
  pieceSize: number;
  width: number;
  height: number;
  pieceY: number;
}

/** 点选题型：答案是「按顺序点击的那几个字心」。 */
export interface ClickChallenge extends ChallengeBase {
  kind: 'click';
  /** **按点击顺序**排列的目标字心坐标。 */
  targets: { x: number; y: number }[];
  /**
   * 图上**全部**字的字心（含干扰字）。
   * 只用于行为分析里那条「是不是次次都点在正中心」—— 它要的是「离最近的字的距离」，
   * 而不管点的是不是目标字。别把它当成第二份答案。
   */
  glyphs: { x: number; y: number }[];
  /** 点击容差半径（px）。 */
  radius: number;
  width: number;
  height: number;
}

export type Challenge = SliderChallenge | ClickChallenge;

// ── 多阶段视觉任务会话 ──────────────────────────────────────────────────────
//
// 【为什么不能复用 Challenge】Challenges 的语义是「取走即作废的单题」，
// 而视觉任务是**一条会话里连着几道题**：答对一阶段要**前进**、不是作废。
// 所以单开一张 sessions 表，共用同一个 sweep 与同一个 globalThis。

export interface VisionStage {
  /** 本阶段场景里所有物体（含干扰物）。判卷与「离谁最近」都要用。 */
  objects: SceneObject[];
  instruction: Instruction;
  /** 给人看的中文指令。 */
  prompt: string;
  /** 点击型 = 要点中的那个；拖拽型 = 落点。 */
  target: SceneObject;
  /** 拖拽型的起点；点击型为 null。 */
  source: SceneObject | null;
  form: 'simple' | 'relative' | 'drag';
}

export interface VisionSession extends ChallengeBase {
  kind: 'vision';
  stages: VisionStage[];
  /** 当前待答的阶段下标。答对一阶段就 +1。 */
  index: number;
  /** 阶段总数（= stages.length，冗余存一份方便返回）。 */
  total: number;
}

interface StoreState {
  challenges: Map<string, Challenge>;
  sessions: Map<string, VisionSession>;
  /** 指纹 → 出现次数，用来抓「同一个生成器批量刷」。 */
  fingerprints: Map<string, number>;
}

type GlobalWithStore = typeof globalThis & { __raricyCaptchaDemoStore?: StoreState };

/** 挑战有效期。够人慢慢做，又不足以让人批量囤起来解。 */
const TTL_MS = 2 * 60 * 1000;
/** 上限，防止无界增长（也顺带限制了并发出题的开销）。 */
const MAX_CHALLENGES = 500;
/** 指纹表同样有上限 —— 它是全进程共享的，不设界就是一条内存泄漏。 */
const MAX_FINGERPRINTS = 2000;
/**
 * 视觉任务会话的有效期。比单题长得多 —— 人要看图、读中文指令、再动手，
 * 多阶段还要来回几次。3 分钟是「够慢的人做完」与「不让人囤起来慢慢解」之间的折中。
 */
const VISION_TTL_MS = 3 * 60 * 1000;

function store(): StoreState {
  const g = globalThis as GlobalWithStore;
  if (!g.__raricyCaptchaDemoStore) {
    g.__raricyCaptchaDemoStore = { challenges: new Map(), sessions: new Map(), fingerprints: new Map() };
  }
  // 旧实例（本文件早先版本建的）没有 sessions 这一格 —— 补上，别让热更新炸掉
  if (!g.__raricyCaptchaDemoStore.sessions) g.__raricyCaptchaDemoStore.sessions = new Map();
  return g.__raricyCaptchaDemoStore;
}

/** 清掉过期的；超上限时按插入顺序丢最老的。 */
function sweep(s: StoreState, now: number): void {
  for (const [id, c] of s.challenges) {
    if (c.expiresAt <= now) s.challenges.delete(id);
  }
  while (s.challenges.size > MAX_CHALLENGES) {
    const oldest = s.challenges.keys().next();
    if (oldest.done) break;
    s.challenges.delete(oldest.value);
  }
  for (const [id, v] of s.sessions) {
    if (v.expiresAt <= now || v.index >= v.total) s.sessions.delete(id);
  }
  while (s.sessions.size > MAX_CHALLENGES) {
    const oldest = s.sessions.keys().next();
    if (oldest.done) break;
    s.sessions.delete(oldest.value);
  }
}

export function putChallenge<T extends Challenge>(c: Omit<T, 'createdAt' | 'expiresAt'>): T {
  const s = store();
  const now = Date.now();
  sweep(s, now);
  const full = { ...c, createdAt: now, expiresAt: now + TTL_MS } as T;
  s.challenges.set(full.id, full);
  return full;
}

/**
 * 取走并作废一份挑战。**一次性**：无论判定结果如何，这一份都不会再有第二次。
 *
 * 不存在 / 已过期 / 用户不匹配 / 题型不匹配 一律返回 null，调用方统一报
 * 「挑战不存在或已过期」—— 分开报等于告诉攻击者他猜的 id 存不存在、是什么题型。
 */
export function takeChallenge<K extends Challenge['kind']>(
  id: string,
  userId: string,
  kind: K
): Extract<Challenge, { kind: K }> | null {
  const s = store();
  const now = Date.now();
  sweep(s, now);
  const c = s.challenges.get(id);
  if (!c) return null;
  s.challenges.delete(id);
  if (c.userId !== userId) return null;
  if (c.expiresAt <= now) return null;
  if (c.kind !== kind) return null;
  return c as Extract<Challenge, { kind: K }>;
}

// ── 视觉任务会话的读写 ──────────────────────────────────────────────────────

export function putVisionSession(
  s: Omit<VisionSession, 'createdAt' | 'expiresAt'>
): VisionSession {
  const st = store();
  const now = Date.now();
  sweep(st, now);
  const full: VisionSession = { ...s, createdAt: now, expiresAt: now + VISION_TTL_MS };
  st.sessions.set(full.id, full);
  return full;
}

/**
 * 读一条会话（**不删**）。归属不符 / 不存在 / 过期一律 null，对外统一报
 * 「会话不存在或已过期」。注意与 takeChallenge 的区别：那个是取走即作废，
 * 这个要留着让会话继续往下走。
 */
export function getVisionSession(id: string, userId: string): VisionSession | null {
  const st = store();
  const now = Date.now();
  sweep(st, now);
  const v = st.sessions.get(id);
  if (!v || v.userId !== userId || v.expiresAt <= now) return null;
  return v;
}

export function dropVisionSession(id: string): void {
  store().sessions.delete(id);
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
