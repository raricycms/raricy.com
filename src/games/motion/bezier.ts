// 三次贝塞尔缓动采样器 —— 零依赖，纯函数。
//
// 浏览器跑 CSS transition 时用的就是这条曲线；页面上那张「曲线图」和「数字递增」两个
// 区块要跟着 CSS 同一条曲线走，所以必须自己采样，不能拿 CSS 之外的近似替代
// （用 `ease` 之类的名字反推不了中途的高度）。
//
// 形状与浏览器实现一致：先按 x 反解 t，再取 t 处的 y。
//   · x 必须在 [0, 1] 内（时间轴不会倒流），超出就夹住；
//   · **y 不受 [0, 1] 约束** —— 过冲曲线（回弹类）中途会超过 1 再落回来，夹住 y 会让
//     图上那条线与页面里实际动的东西对不上。
//
// 曲线由 CSS 的 `cubic-bezier(x1, y1, x2, y2)` 四个数描述，端点固定是 (0,0) 与 (1,1)。
export type BezierPoints = readonly [number, number, number, number];

const NEWTON_ITERATIONS = 8;
/** 斜率小于它就退回二分 —— 牛顿法在斜率接近 0 处会一步跳到区间外。 */
const NEWTON_MIN_SLOPE = 1e-3;
const SUBDIVISION_ITERATIONS = 40;
const EPSILON = 1e-7;

function coefficientA(p1: number, p2: number) {
  return 1 - 3 * p2 + 3 * p1;
}

function coefficientB(p1: number, p2: number) {
  return 3 * p2 - 6 * p1;
}

function coefficientC(p1: number) {
  return 3 * p1;
}

/** 把 [0, 1] 的参数 t 代进一维三次贝塞尔，得到该轴上的坐标。 */
function sampleComponent(p1: number, p2: number, t: number) {
  return ((coefficientA(p1, p2) * t + coefficientB(p1, p2)) * t + coefficientC(p1)) * t;
}

function sampleComponentSlope(p1: number, p2: number, t: number) {
  return (3 * coefficientA(p1, p2) * t + 2 * coefficientB(p1, p2)) * t + coefficientC(p1);
}

/** 已知 x，反解参数 t。 */
function solveTForX(x: number, x1: number, x2: number) {
  let t = x;

  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const slope = sampleComponentSlope(x1, x2, t);
    if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
    const error = sampleComponent(x1, x2, t) - x;
    if (Math.abs(error) < EPSILON) return t;
    t -= error / slope;
  }

  // 二分兜底：牛顿法收敛不了时（起点斜率为 0 的曲线最常见）仍然单调可靠。
  let low = 0;
  let high = 1;
  t = Math.min(high, Math.max(low, t));
  for (let i = 0; i < SUBDIVISION_ITERATIONS; i++) {
    const value = sampleComponent(x1, x2, t);
    if (Math.abs(value - x) < EPSILON) return t;
    if (value < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return t;
}

/**
 * 取缓动在进度 `x`（0–1 的时间进度）处的输出值。
 *
 * 两端是硬端点：x ≤ 0 返回 0、x ≥ 1 返回 1（回弹曲线末段也不会停在一个小数上）。
 */
export function sampleEasing(bezier: BezierPoints, x: number): number {
  const [x1, y1, x2, y2] = bezier;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // 对角线上四个数相等就是 linear —— 直接返回，省掉解方程也避免浮点残留。
  if (x1 === y1 && x2 === y2) return x;
  const t = solveTForX(x, x1, x2);
  return sampleComponent(y1, y2, t);
}

/**
 * 采样成 `steps + 1` 个点，返回 `[x, y]` 数组（x 单调递增）。
 * 图上画线、以及「逐帧递增的数字」都吃这一份。
 */
export function sampleEasingPoints(bezier: BezierPoints, steps = 48): [number, number][] {
  const count = Math.max(1, Math.round(steps));
  const points: [number, number][] = [];
  for (let i = 0; i <= count; i++) {
    const x = i / count;
    points.push([x, sampleEasing(bezier, x)]);
  }
  return points;
}

/** 一维三次贝塞尔的极值（用来算图的纵向取值范围，过冲曲线不被裁掉）。 */
export function easingRange(bezier: BezierPoints): { min: number; max: number } {
  const [, y1, , y2] = bezier;
  const values = [0, 1];
  // y(t) = (1-t)³·0 + 3(1-t)²t·y1 + 3(1-t)t²·y2 + t³·1
  // 导数化成 at² + bt + c，解出 [0, 1] 内的根即为极值候选点。
  const a = 3 * (1 - 3 * y2 + 3 * y1);
  const b = 6 * (y2 - 2 * y1);
  const c = 3 * y1;
  const roots: number[] = [];
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) > EPSILON) roots.push(-c / b);
  } else {
    const delta = b * b - 4 * a * c;
    if (delta >= 0) {
      const root = Math.sqrt(delta);
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
  }
  for (const t of roots) {
    if (t > 0 && t < 1) values.push(sampleComponent(y1, y2, t));
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}
