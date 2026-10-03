// ─────────────────────────────────────────────────────────────────────────────
// trace.ts — 滑块行为分析：把一条指针轨迹判成「人」还是「脚本」。
//
// 【零依赖】服务端判定与客户端实时读数共用这一份 —— 所以本文件**不 import 任何东西**
//   （不碰 prisma、不碰 node:），与 market-math.ts 同一条纪律：能被两端同时拖进包里。
//
// 【为什么权威判定必须在服务端】客户端算出来的结论是攻击者伸手就能改的
//   （直接 POST 一个 `{"verdict":"human"}`）。这一份在浏览器里也跑，**纯粹是为了演示时
//   能当场看到读数**；真正说了算的永远是服务端那次调用。
//
// 【它拦得住谁】拦的是「脚本直接算终点坐标、一次性 set 到位」这一类：采样数、dt 的
//   规律性、y 抖动、松手时机都会露馅。**拦不住**「知道你在量什么、并照人体曲线合成
//   轨迹」的对手 —— 那需要长期样本训练，见文件末尾「能力边界」。
//
// 【权重全是估的】下面每个 weight 都是拍的，不是拟合出来的。上线前必须拿站内真人样本
//   回放一遍按误杀率调 —— 现在只保证「脚本样例的分数显著低于真人样例」，
//   **不保证任何绝对阈值**。别把 SCORE_HUMAN 当成已校准的判据。
// ─────────────────────────────────────────────────────────────────────────────

/** 一次指针采样。时间与坐标都由客户端给，**因此全是不可信输入**（见 sanitizeTrace）。 */
export interface TraceSample {
  /** 相对「挑战渲染完成」的毫秒偏移。 */
  t: number;
  /** 滑块当前位移（px，0..maxOffset）。 */
  x: number;
  /** 指针的视口纵坐标。只用它的**离散程度**，绝对值无意义。 */
  y: number;
}

export interface TraceMeta {
  /** 'mouse' / 'touch' / 'pen' / '' —— 浏览器报的指针类型。 */
  pointerType: string | null;
  /** 全部 pointer 事件是否 isTrusted。合成事件（dispatchEvent）为 false。 */
  allTrusted: boolean;
  /** pointerup 相对挑战渲染完成时刻的毫秒偏移。 */
  endMs: number;
}

export interface TraceInput {
  samples: TraceSample[];
  meta: TraceMeta;
}

/** 单条命中的可疑特征。weight 是「命中它就扣多少分」。 */
export interface TraceFlag {
  key: string;
  label: string;
  weight: number;
  detail: string;
}

export interface TraceSignals {
  sampleCount: number;
  durationMs: number;
  /** 相邻采样间隔的变异系数（σ/μ）。趋 0 = 定时器式均匀采样。 */
  dtCv: number;
  /** x 对 t 做一元线性回归的 R²。趋 1 = 完美直线。 */
  linearR2: number;
  /** 方向反转次数（相邻位移变号）。 */
  reversals: number;
  maxVelocity: number;
  meanVelocity: number;
  /**
   * 最大单步位移 / 中位单步位移。**仅供观察，不参与判定。**
   * 它度量的是**采样节奏**而不是人手：真人快推、或浏览器把几帧合成一次事件，同样会大。
   * 见本文件「关于『瞬移步』为什么不在下面」那一段。
   */
  stepSpikeRatio: number;
  /** y 的标准差。趋 0 = 指针锁死在一条水平线上。 */
  yStdDev: number;
  /** 从**首次**采样到松手的毫秒数。 */
  startDelayMs: number;
  /** 末次移动距松手的毫秒数。趋 0 = 落点即松手。 */
  settleMs: number;
  /** dt 超过 PAUSE_DT_MS 的间隔占总时长的比例。 */
  pauseRatio: number;
}

export type TraceBand = 'human' | 'suspect' | 'bot';

export interface TraceVerdict {
  /** 0–100，越高越像人。 */
  score: number;
  band: TraceBand;
  signals: TraceSignals;
  flags: TraceFlag[];
}

// ── 阈值与权重（全是待调的估计值，见文件头） ────────────────────────────────

// ── 关于「瞬移步」为什么不在下面 ────────────────────────────────────────────
//
// 这里曾有一条 `teleport`：最大单步位移 / 中位单步位移 > 8 就扣 20 分。
// **已删除，别再按直觉加回来。**
//
// 删它的依据是实测：朴素脚本 spike=1.0、老练脚本 spike=3.8，**两个都没到 8** ——
// 它对机器人的检出率是零。而真人拖动时，浏览器按固定频率（约 60–125Hz）采样
// pointermove，一次快速推送就会让 max 远大于 median，所以它**专门抓真人**。
// 站长的原话是「我自己试经常会出现瞬移步」—— 这就是典型的误杀。
//
// 教训不止于此：这个比值**度量的是采样节奏，不是人手**。「一次大步」既可能是脚本
// set 到位，也可能是浏览器把几帧合成了一次事件 —— 两者在这里长得一模一样。
// 想抓「一步到位」应该走**速度**（dx/dt）而不是位移比值，而且必须用真实录制的
// 正样本校准过阈值再上。现在没有正样本，所以不设这条。

const MIN_SAMPLES = 5;
const FAST_MS = 120;
const SLOW_MS = 60_000;
/**
 * dt 变异系数阈值。**别调高**：浏览器是按固定频率轮询指针的，真人的 dt 本来就相当
 * 规整（60Hz ≈ 16.7ms）。帧率抖动大时人也能到 0.1 上下 —— 阈值 0.15 会误杀。
 * 0.05 才是「几乎完全等距」那种定时器特征，且额外要求采样点够多（见 TIMER_MIN_SAMPLES）。
 */
const TIMER_CV = 0.05;
const TIMER_MIN_SAMPLES = 20;
const PERFECT_R2 = 0.9995;
const FLAT_Y = 0.01;
const INSTANT_RELEASE_MS = 2;
const INSTANT_START_MS = 60;
const PAUSE_DT_MS = 100;
const LOW_PAUSE_RATIO = 0.02;

/** 位移容差（px）。服务端只认这一个数 —— 客户端不许自带。 */
export const POSITION_TOLERANCE_PX = 6;

export const SCORE_HUMAN = 70;
export const SCORE_SUSPECT = 40;

/** 采样点数上限：再多也拒（附带 DoS 防护，见 sanitizeTrace）。 */
export const MAX_SAMPLES = 5000;

// ── 统计小工具（导出给 click-trace.ts 复用 —— 两个题型的统计口径必须一致，
//    否则「滑块更难还是点选更难」的对比会因为实现差异而失真） ────────────────────

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** 总体标准差。 */
export function stdDev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// ── 信号提取 ────────────────────────────────────────────────────────────────

export function extractSignals(input: TraceInput): TraceSignals {
  const { samples, meta } = input;
  const n = samples.length;
  if (n === 0) {
    return {
      sampleCount: 0,
      durationMs: 0,
      dtCv: 0,
      linearR2: 0,
      reversals: 0,
      maxVelocity: 0,
      meanVelocity: 0,
      stepSpikeRatio: 0,
      yStdDev: 0,
      startDelayMs: 0,
      settleMs: 0,
      pauseRatio: 0,
    };
  }

  const ts = samples.map((s) => s.t);
  const xs = samples.map((s) => s.x);
  const ys = samples.map((s) => s.y);

  const durationMs = ts[n - 1] - ts[0];

  // 相邻间隔
  const dts: number[] = [];
  for (let i = 1; i < n; i++) dts.push(ts[i] - ts[i - 1]);
  const meanDt = mean(dts);
  const dtCv = meanDt > 0 ? stdDev(dts) / meanDt : 0;

  // 一元线性回归 x = a·t + b，取 R²
  let linearR2 = 1;
  if (n >= 3) {
    const mt = mean(ts);
    const mx = mean(xs);
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      const dt = ts[i] - mt;
      const dx = xs[i] - mx;
      sxx += dt * dt;
      sxy += dt * dx;
      syy += dx * dx;
    }
    // 退化（时间或位移完全没有变化）时认为「完美拟合」—— 那本身就是可疑的
    linearR2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
  }

  // 位移步长、速度、反转
  const steps: number[] = [];
  const velocities: number[] = [];
  let reversals = 0;
  let prevSign = 0;
  for (let i = 1; i < n; i++) {
    const dx = xs[i] - xs[i - 1];
    const dt = ts[i] - ts[i - 1];
    steps.push(Math.abs(dx));
    if (dt > 0) velocities.push(Math.abs(dx) / dt);
    const sign = Math.sign(dx);
    if (sign !== 0) {
      if (prevSign !== 0 && sign !== prevSign) reversals++;
      prevSign = sign;
    }
  }
  const medStep = median(steps);
  const maxStep = steps.length > 0 ? Math.max(...steps) : 0;
  const stepSpikeRatio =
    medStep > 0 ? Math.min(maxStep / medStep, 999) : maxStep > 0 ? 999 : 0;

  const maxVelocity = velocities.length > 0 ? Math.max(...velocities) : 0;
  const meanVelocity = durationMs > 0 ? Math.abs(xs[n - 1] - xs[0]) / durationMs : 0;

  // 停顿占比
  let pauseMs = 0;
  for (const dt of dts) if (dt > PAUSE_DT_MS) pauseMs += dt;
  const pauseRatio = durationMs > 0 ? pauseMs / durationMs : 0;

  const settleMs = meta.endMs - ts[n - 1];

  return {
    sampleCount: n,
    durationMs,
    dtCv,
    linearR2,
    reversals,
    maxVelocity,
    meanVelocity,
    stepSpikeRatio,
    yStdDev: stdDev(ys),
    startDelayMs: ts[0],
    settleMs,
    pauseRatio,
  };
}

// ── 判定 ────────────────────────────────────────────────────────────────────

export function analyzeTrace(input: TraceInput): TraceVerdict {
  const s = extractSignals(input);
  const flags: TraceFlag[] = [];

  const flag = (key: string, label: string, weight: number, detail: string) =>
    flags.push({ key, label, weight, detail });

  if (!input.meta.allTrusted) {
    flag('untrusted', '事件非浏览器原生', 40, 'isTrusted=false —— 由脚本 dispatchEvent 合成');
  }
  if (!input.meta.pointerType) {
    flag('noPointerType', '缺指针类型', 10, '浏览器未报告 pointerType');
  }

  if (s.sampleCount < MIN_SAMPLES) {
    flag('tooFewSamples', '采样点过少', 25, `只有 ${s.sampleCount} 个（脚本常整段 set 一步到位）`);
  }

  if (s.sampleCount >= MIN_SAMPLES) {
    if (s.durationMs < FAST_MS) {
      flag('tooFast', '全程过快', 20, `${Math.round(s.durationMs)}ms 完成（低于 ${FAST_MS}ms）`);
    }
    if (s.durationMs > SLOW_MS) {
      flag('tooSlow', '全程过慢', 10, `${(s.durationMs / 1000).toFixed(1)}s —— 可能是在慢慢试`);
    }
    if (s.dtCv < TIMER_CV && s.sampleCount >= TIMER_MIN_SAMPLES) {
      flag('regularTimer', '采样间隔近乎等距', 25, `dt 变异系数 ${s.dtCv.toFixed(3)}（低于 ${TIMER_CV}）`);
    }
    if (s.yStdDev < FLAT_Y) {
      // 桌面端用鼠标横向直拖，y 就是逐像素恒定的 —— 这条对真人不友好。现在不拦截
      // （见 verify 路由的 BEHAVIOR_BLOCKS），但真要开拦截必须先把这条压下去或删掉。
      flag('flatY', '指针纵坐标零抖动', 8, `y 标准差 ${s.yStdDev.toFixed(4)}`);
    }
    if (s.startDelayMs < INSTANT_START_MS) {
      flag('instantStart', '起手无反应时间', 8, `渲染后 ${Math.round(s.startDelayMs)}ms 就开始拖`);
    }
    if (s.settleMs < INSTANT_RELEASE_MS) {
      flag('instantRelease', '落点即松手', 10, `末次移动后 ${Math.round(s.settleMs)}ms 松手`);
    }
    if (s.durationMs > 800 && s.pauseRatio < LOW_PAUSE_RATIO) {
      flag('noPause', '全程无停顿', 10, '一次不停的匀速拖动');
    }
  }

  if (s.linearR2 > PERFECT_R2 && s.reversals === 0) {
    flag('perfectLine', '轨迹是完美直线', 20, `R²=${s.linearR2.toFixed(5)} 且零反转`);
  } else if (s.reversals === 0 && s.sampleCount >= MIN_SAMPLES) {
    // 单独看很弱（慢速的谨慎操作也常常零反转），所以权重低 —— 别上调
    flag('noReversal', '零方向反转', 6, '人类拖动通常有微小回抽');
  }

  let score = 100;
  for (const f of flags) score -= f.weight;
  score = Math.max(0, Math.min(100, score));

  const band: TraceBand = score >= SCORE_HUMAN ? 'human' : score >= SCORE_SUSPECT ? 'suspect' : 'bot';
  return { score, band, signals: s, flags };
}

// ── 跨会话指纹 ──────────────────────────────────────────────────────────────
//
// 【这是整套里最值钱的一条】单条轨迹可以伪造得像人；**两百个账号的轨迹彼此一模一样**
// 却极难同时伪造 —— 要么生成器是确定性的（那就必然聚成一堆），要么攻击者得为每个账号
// 生成各不相同的「人味」曲线，成本立刻上一台阶。
//
// 做法：把信号粗量化成一个字符串，同一个指纹出现多次就报出来。量化刻意做**粗** ——
// 抓的是「同一个生成器」，不是「同一个人」。

function q(v: number, step: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v / step);
}

export function traceFingerprint(s: TraceSignals): string {
  return [
    q(s.durationMs, 50),
    s.sampleCount,
    q(s.dtCv, 0.1),
    q(s.linearR2, 0.001),
    s.reversals,
    q(s.maxVelocity, 0.5),
    q(s.stepSpikeRatio, 0.1),
    q(s.yStdDev, 0.01),
    q(s.settleMs, 10),
    q(s.pauseRatio, 0.02),
  ].join('|');
}

// ── 不可信输入的清洗 ────────────────────────────────────────────────────────
//
// 轨迹是**客户端给的**，所以它可能：不是对象、samples 不是数组、坐标是 NaN、
// 采样点一百万个（DoS）、时间倒流。任何一条都必须在进 analyzeTrace 之前挡掉 ——
// 判定函数本身不该兼职做校验（它只做数学，NaN 会让它悄悄算出一堆 0）。

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function sanitizeTrace(raw: unknown): TraceInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const rawSamples = r.samples;
  if (!Array.isArray(rawSamples)) return null;
  if (rawSamples.length === 0 || rawSamples.length > MAX_SAMPLES) return null;

  const samples: TraceSample[] = [];
  let prevT = -Infinity;
  for (const it of rawSamples) {
    if (typeof it !== 'object' || it === null) return null;
    const o = it as Record<string, unknown>;
    const { t, x, y } = o;
    if (!isFiniteNumber(t) || !isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    // 时间必须单调不减 —— 倒流说明是拼出来的
    if (t < prevT) return null;
    prevT = t;
    samples.push({ t, x, y });
  }

  const rawMeta = r.meta;
  if (typeof rawMeta !== 'object' || rawMeta === null) return null;
  const m = rawMeta as Record<string, unknown>;
  const pointerType =
    m.pointerType === null || m.pointerType === undefined
      ? null
      : typeof m.pointerType === 'string'
        ? m.pointerType
        : null;
  const allTrusted = m.allTrusted === true;
  const endMs = isFiniteNumber(m.endMs) ? m.endMs : samples[samples.length - 1].t;

  return { samples, meta: { pointerType, allTrusted, endMs } };
}
