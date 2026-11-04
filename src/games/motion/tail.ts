import { sampleEasing, type BezierPoints } from './bezier';

// 「短尾」曲线：不换贝塞尔，只在时间轴上给同一条曲线截尾。
//
// 交互动画（cubic-bezier(0.16, 1, 0.3, 1)）前段极快 —— 540ms 里前 230ms 就走到 95%，
// 剩下 310ms 全花在最后几个百分点上。这组变体把「收尾点」往前提：主段与交互动画
// **逐帧一致**，到收尾点后剩余的行程用一小段 ease-out 快速走完，然后停住。
// 所以同一时刻看，几条曲线几乎重合，区别只在尾巴还剩多长。
//
// 注意收尾段不是「速度连续」的：收尾点越早，压进这几十毫秒的行程越多，截尾处会有
// 一记更明显的加速（30% 那档约 12% 的行程挤进 54ms）。那不是瑕疵，正是这组
// 对照要让人判断的东西 —— 尾巴收到多短就开始「太硬」。
//
// 三次贝塞尔表达不了「提前走完然后停住」—— 它的终点固定在 x = 1。这里改成把截尾后的
// 进度函数采样成 CSS 的 `linear()` 缓动（浏览器原生支持，CSS transition / animation
// 都能吃），曲线图、数字递增与 CSS 过渡读同一份采样点，保留「图上看到的形状就是
// 浏览器真正会走的形状」这条口径。
export interface TailCut {
  /** 从整段时长的百分之几开始收尾（0–1）。 */
  cut: number;
  /** 收尾本身用掉整段时长的百分之几（0–1）。 */
  settle: number;
}

/** 收尾段的缓动：三次 ease-out —— 起步快、末尾减速到停住。 */
function settleEase(k: number) {
  return 1 - (1 - k) ** 3;
}

/** 主段采样点数。用平方分布排布 —— 前 10% 的行程最陡，采样点跟着加密。 */
const MAIN_STOPS = 28;
/** 收尾段采样点数（几十毫秒里要看清减速，单独补密）。 */
const SETTLE_STOPS = 6;

/**
 * 截尾后的进度采样点，直接就是 CSS `linear()` 的停靠点。
 *
 * 主段：x 从 0 到 cut 平方分布，y 取基准曲线在该时刻的原值 —— 这一段与基准逐帧相同。
 * 收尾段：从基准走到 cut 时的进度继续走到 1，曲线用 ease-out，避免突然停住。
 * 之后一直停在 1。
 */
export function tailStops(points: BezierPoints, tail: TailCut): [number, number][] {
  const { cut, settle } = tail;
  const atCut = sampleEasing(points, cut);
  const stops: [number, number][] = [];
  for (let i = 0; i <= MAIN_STOPS; i++) {
    const x = cut * (i / MAIN_STOPS) ** 2;
    stops.push([x, i === 0 ? 0 : sampleEasing(points, x)]);
  }
  for (let j = 1; j <= SETTLE_STOPS; j++) {
    const k = j / SETTLE_STOPS;
    stops.push([cut + settle * k, atCut + (1 - atCut) * settleEase(k)]);
  }
  stops.push([1, 1]);
  return stops;
}

/**
 * 进度：在采样点之间线性插值。
 *
 * 刻意不是「直接调 sampleEasing」—— CSS 那边吃的是 linear()，采样点之间就是直线；
 * 这里用同一份直线插值，数字递增才不会比 CSS 提前零点几个百分点。
 */
export function tailProgress(points: BezierPoints, tail: TailCut, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const stops = tailStops(points, tail);
  let low = 0;
  let high = stops.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (stops[mid][0] <= x) low = mid;
    else high = mid;
  }
  const [x0, y0] = stops[low];
  const [x1, y1] = stops[high];
  if (x1 === x0) return y1;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** 生成 CSS `linear()` 缓动串。精度到 0.01%，比屏幕上的一个像素还细。 */
export function tailCss(points: BezierPoints, tail: TailCut): string {
  const stops = tailStops(points, tail).map(([x, y], index) => {
    const value = Number(y.toFixed(4));
    if (index === 0) return `${value}`;
    return `${value} ${Number((x * 100).toFixed(2))}%`;
  });
  return `linear(${stops.join(', ')})`;
}

/** 收尾点换算成毫秒，给页面上的读数用。 */
export function tailEndMs(tail: TailCut, duration: number): number {
  return Math.round((tail.cut + tail.settle) * duration);
}
