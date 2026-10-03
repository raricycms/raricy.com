// ─────────────────────────────────────────────────────────────────────────────
// click-trace.ts — 点选题型的行为分析：把一条「点击序列 + 移动轨迹」判成人与脚本。
//
// 与 trace.ts（滑块）的分工：那边判的是一条**连续拖动**，这边判的是**离散的多次点击**。
// 统计口径共用 trace.ts 的 mean/stdDev/median —— 两个题型必须用同一套口径，
// 否则「哪个更难」的对比会因为实现差异而失真。
//
// 【权威在服务端】客户端算出来的结论攻击者伸手就能改（直接 POST 一个
//   `{"verdict":"human"}`）。这一份在浏览器里也跑，只为演示时能当场看到读数。
//
// 【点选比滑块多出来的两条信号 —— 都很好用】
//   · **每段移动的采样数**：人要把指针移到目标上，必然产生一串 pointermove；
//     脚本「直接 set 坐标然后 click」则一段只有 0~1 个采样。滑块那边量不到这个，
//     因为滑块的位移本身就是连续的。
//   · **点击落点距字心的距离**：人点字是**点在字上**，落点随机散布，离字心通常 3~15px；
//     OCR + 模板定位出来的机器人会点在**包围盒正中心**，几乎恒为 0~2px。
//     这条是「过于精确」型的破绽 —— 与真人的「不够精确」正好相反。
//
// 【能力边界同 trace.ts】拦得住「脚本算好坐标直接点」，拦不住「驱动真浏览器 + 合成
//   人味移动曲线」。后者是成本问题，不是检测问题。权重全是估的，见那边的说明。
// ─────────────────────────────────────────────────────────────────────────────

import { mean, stdDev } from './trace';

export interface ClickSample {
  /** 相对「挑战渲染完成」的毫秒偏移。 */
  t: number;
  x: number;
  y: number;
}

export interface ClickTraceInput {
  /** 全部 pointermove 采样。 */
  moves: ClickSample[];
  /** 按顺序的点击。 */
  clicks: ClickSample[];
  meta: {
    pointerType: string | null;
    allTrusted: boolean;
  };
}

export interface ClickFlag {
  key: string;
  label: string;
  weight: number;
  detail: string;
}

export interface ClickSignals {
  clickCount: number;
  moveCount: number;
  /** 挑战渲染完成 → 第一次点击的毫秒数。 */
  firstClickDelayMs: number;
  /** 第一次点击 → 最后一次点击。 */
  totalMs: number;
  /** 相邻两次点击间隔的变异系数。趋 0 = 定拍子。 */
  interClickCv: number;
  /** 每段（两次点击之间）平均有多少个 pointermove 采样。 */
  movesPerSegment: number;
  /** 每段位移 / 路径长度。1 = 完全直线。 */
  pathStraightness: number;
  /** 段内相邻采样间隔的变异系数（取全段汇总）。 */
  moveDtCv: number;
  /** 每次点击距**最近的那个字心**的平均距离（px）。趋 0 = 次次点在正中心。 */
  meanCenterOffsetPx: number;
}

export type ClickBand = 'human' | 'suspect' | 'bot';

export interface ClickVerdict {
  score: number;
  band: ClickBand;
  signals: ClickSignals;
  flags: ClickFlag[];
}

// ── 阈值与权重（全是待调的估计值，同 trace.ts 的纪律） ──────────────────────

const MIN_MOVES = 6;
const MIN_MOVES_PER_SEGMENT = 2;
/** 落点距字心小于这个值，就认为「精确得不像手」。 */
const PERFECT_CENTER_PX = 2;
const INTER_CLICK_CV = 0.08;
const INSTANT_FIRST_CLICK_MS = 150;
const STRAIGHT_PATH = 0.995;
const MOVE_TIMER_CV = 0.05;
const MOVE_TIMER_MIN_MOVES = 20;
const FAST_TOTAL_MS = 400;

export const CICK_SCORE_HUMAN = 70;
export const CLICK_SCORE_SUSPECT = 40;

/** 采样上限（含 DoS 防护，见 sanitizeClickTrace）。 */
export const MAX_MOVE_SAMPLES = 5000;
export const MAX_CLICKS = 20;

// ── 信号提取 ────────────────────────────────────────────────────────────────

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function extractClickSignals(
  input: ClickTraceInput,
  glyphs: { x: number; y: number }[]
): ClickSignals {
  const { moves, clicks } = input;
  const clickCount = clicks.length;

  if (clickCount === 0) {
    return {
      clickCount: 0,
      moveCount: moves.length,
      firstClickDelayMs: 0,
      totalMs: 0,
      interClickCv: 0,
      movesPerSegment: 0,
      pathStraightness: 0,
      moveDtCv: 0,
      meanCenterOffsetPx: 0,
    };
  }

  const firstClickDelayMs = clicks[0].t;
  const totalMs = clickCount > 1 ? clicks[clickCount - 1].t - clicks[0].t : 0;

  // 相邻点击间隔的变异系数
  const interDts: number[] = [];
  for (let i = 1; i < clickCount; i++) interDts.push(clicks[i].t - clicks[i - 1].t);
  const meanInter = mean(interDts);
  const interClickCv = meanInter > 0 ? stdDev(interDts) / meanInter : 0;

  // 分段：以每次点击为界。第 i 段 = [上一次点击, 第 i 次点击)
  const segMoves: ClickSample[][] = [];
  for (let i = 0; i < clickCount; i++) {
    const from = i === 0 ? -Infinity : clicks[i - 1].t;
    const to = clicks[i].t;
    segMoves.push(moves.filter((m) => m.t >= from && m.t < to));
  }

  const movesPerSegment = mean(segMoves.map((s) => s.length));

  // 直线度：位移 / 路径长度（只统计有 2 个以上采样的段）
  const straightness: number[] = [];
  const segDts: number[] = [];
  for (const seg of segMoves) {
    if (seg.length < 2) continue;
    let pathLen = 0;
    for (let i = 1; i < seg.length; i++) {
      pathLen += dist(seg[i].x, seg[i].y, seg[i - 1].x, seg[i - 1].y);
      segDts.push(seg[i].t - seg[i - 1].t);
    }
    const span = dist(seg[0].x, seg[0].y, seg[seg.length - 1].x, seg[seg.length - 1].y);
    if (pathLen > 0) straightness.push(span / pathLen);
  }
  const pathStraightness = mean(straightness);
  const meanDt = mean(segDts);
  const moveDtCv = meanDt > 0 ? stdDev(segDts) / meanDt : 0;

  // 落点距最近字心的距离
  const offsets = clicks.map((c) => {
    let best = Infinity;
    for (const g of glyphs) best = Math.min(best, dist(c.x, c.y, g.x, g.y));
    return Number.isFinite(best) ? best : 0;
  });
  const meanCenterOffsetPx = mean(offsets);

  return {
    clickCount,
    moveCount: moves.length,
    firstClickDelayMs,
    totalMs,
    interClickCv,
    movesPerSegment,
    pathStraightness,
    moveDtCv,
    meanCenterOffsetPx,
  };
}

// ── 判定 ────────────────────────────────────────────────────────────────────

export function analyzeClickTrace(
  input: ClickTraceInput,
  glyphs: { x: number; y: number }[]
): ClickVerdict {
  const s = extractClickSignals(input, glyphs);
  const flags: ClickFlag[] = [];
  const flag = (key: string, label: string, weight: number, detail: string) =>
    flags.push({ key, label, weight, detail });

  if (!input.meta.allTrusted) {
    flag('untrusted', '事件非浏览器原生', 40, 'isTrusted=false —— 由脚本 dispatchEvent 合成');
  }
  if (!input.meta.pointerType) {
    flag('noPointerType', '缺指针类型', 10, '浏览器未报告 pointerType');
  }

  if (s.moveCount < MIN_MOVES) {
    flag('tooFewMoves', '移动采样过少', 25, `全程只有 ${s.moveCount} 个 pointermove`);
  }
  if (s.clickCount >= 1 && s.movesPerSegment < MIN_MOVES_PER_SEGMENT) {
    // 点选题型最有力的那一条：真人在两次点击之间必然拖出一串采样
    flag('noMoveBeforeClick', '点击之间几乎无移动', 25,
      `每段平均只有 ${s.movesPerSegment.toFixed(1)} 个采样（直接跳到目标再点）`);
  }
  if (s.meanCenterOffsetPx < PERFECT_CENTER_PX) {
    flag('perfectCenters', '次次点在正中心', 20,
      `平均偏心 ${s.meanCenterOffsetPx.toFixed(2)}px —— 手点字不会这么准`);
  }
  if (s.clickCount >= 3 && s.interClickCv < INTER_CLICK_CV) {
    flag('uniformIntervals', '点击节奏过于均匀', 20,
      `间隔变异系数 ${s.interClickCv.toFixed(3)}（低于 ${INTER_CLICK_CV}）`);
  }
  if (s.moveCount >= MOVE_TIMER_MIN_MOVES && s.moveDtCv < MOVE_TIMER_CV) {
    flag('regularMoveTimer', '移动采样近乎等距', 20,
      `dt 变异系数 ${s.moveDtCv.toFixed(3)} —— 定时器式合成轨迹`);
  }
  if (s.clickCount >= 2 && s.pathStraightness > STRAIGHT_PATH) {
    flag('straightPaths', '移动是完美直线', 15,
      `直线度 ${s.pathStraightness.toFixed(4)} —— 人的鼠标轨迹带弧`);
  }
  if (s.firstClickDelayMs < INSTANT_FIRST_CLICK_MS) {
    flag('instantFirstClick', '起手无反应时间', 12,
      `渲染后 ${Math.round(s.firstClickDelayMs)}ms 就点了第一次`);
  }
  if (s.clickCount >= 2 && s.totalMs < FAST_TOTAL_MS) {
    flag('tooFast', '全程过快', 15, `${s.totalMs}ms 点完全部（低于 ${FAST_TOTAL_MS}ms）`);
  }

  let score = 100;
  for (const f of flags) score -= f.weight;
  score = Math.max(0, Math.min(100, score));
  const band: ClickBand =
    score >= CICK_SCORE_HUMAN ? 'human' : score >= CLICK_SCORE_SUSPECT ? 'suspect' : 'bot';
  return { score, band, signals: s, flags };
}

// ── 跨会话指纹 ──────────────────────────────────────────────────────────────
// 同 trace.ts：单条可以伪造，**两百条一模一样**很难。量化刻意做粗。

function q(v: number, step: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v / step);
}

export function clickFingerprint(s: ClickSignals): string {
  return [
    s.clickCount,
    q(s.firstClickDelayMs, 50),
    q(s.totalMs, 100),
    q(s.interClickCv, 0.05),
    q(s.movesPerSegment, 1),
    q(s.pathStraightness, 0.01),
    q(s.moveDtCv, 0.05),
    q(s.meanCenterOffsetPx, 1),
  ].join('|');
}

// ── 不可信输入的清洗（同 trace.ts：判定函数只做数学，不兼职校验） ────────────

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseSamples(raw: unknown, max: number): ClickSample[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const out: ClickSample[] = [];
  let prevT = -Infinity;
  for (const it of raw) {
    if (typeof it !== 'object' || it === null) return null;
    const o = it as Record<string, unknown>;
    if (!isFiniteNumber(o.t) || !isFiniteNumber(o.x) || !isFiniteNumber(o.y)) return null;
    if (o.t < prevT) return null; // 时间倒流说明是拼出来的
    prevT = o.t;
    out.push({ t: o.t, x: o.x, y: o.y });
  }
  return out;
}

export function sanitizeClickTrace(raw: unknown): ClickTraceInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const moves = parseSamples(r.moves, MAX_MOVE_SAMPLES);
  if (!moves) return null;
  const clicks = parseSamples(r.clicks, MAX_CLICKS);
  // 一次点击都没有 = 没做这道题，直接拒（不是「行为可疑」，是没答）
  if (!clicks || clicks.length === 0) return null;

  const rawMeta = r.meta;
  if (typeof rawMeta !== 'object' || rawMeta === null) return null;
  const m = rawMeta as Record<string, unknown>;
  const pointerType =
    typeof m.pointerType === 'string' ? m.pointerType : null;

  return { moves, clicks, meta: { pointerType, allTrusted: m.allTrusted === true } };
}
