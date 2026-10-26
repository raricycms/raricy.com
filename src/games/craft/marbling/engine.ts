// 水面印花的纯模型：低分辨率颜料网格、滴入与拖拽的位移、以及可存草稿的游程编码。
// 复杂度按网格（240×168）而不是屏幕像素计算；组件只负责把网格放大成画布。
// 零 DOM / 零 React —— tests/unit/craft-marbling.test.ts 直接 import 这一份。
//
// ┌─ 颜色烘进格子，不存调色板下标 ─────────────────────────────────────────┐
// │ 每一格记的是**实际颜色**（下面那张全站色表的序号 + 1），不是「第几个调色 │
// │ 板颜色」。差别不是洁癖：若存下标，换调色板时既有颜料会被整片重新着色 ——  │
// │ 已经配好的画面在换色的瞬间变掉，而且不报错。烘进去之后，换调色板只影响   │
// │ **下一滴**，已经落在水里的颜色是既成事实。                              │
// │ `tests/unit/craft-marbling.test.ts` 拿字节比对着这条。                  │
// └────────────────────────────────────────────────────────────────────────┘

export const MARBLING_W = 480;
export const MARBLING_H = 336;
/** 空格子的值。颜料值是 1..MARBLING_COLORS.length，所以 0 一定是"没有颜料"。 */
export const MARBLING_EMPTY = 0;
export const MARBLING_SAVE_KEY = 'craft-marbling-v2';
export const MARBLING_MAX_HISTORY = 16;

export interface MarblingPalette {
  id: string;
  name: string;
  colors: readonly string[];
}

export const MARBLING_PALETTES: readonly MarblingPalette[] = [
  { id: 'jade', name: '青碧', colors: ['#0f766e', '#14b8a6', '#0ea5e9', '#f0c04a', '#e85d4a', '#f3ede0'] },
  { id: 'ember', name: '晚霞', colors: ['#b23a48', '#e76f51', '#f4a261', '#e9c46a', '#2a9d8f', '#f6f1e6'] },
  { id: 'indigo', name: '夜蓝', colors: ['#1e3a8a', '#2563eb', '#38bdf8', '#a7f3d0', '#f5f3ff', '#fbbf24'] },
  { id: 'rose', name: '蔷薇', colors: ['#9d174d', '#db2777', '#f472b6', '#fbcfe8', '#7c3aed', '#fef3c7'] },
] as const;

export const MARBLING_COLOR_COUNT = 6;
export type MarblingTool = 'drop' | 'needle' | 'comb';
export type MarblingStage = 'water' | 'paper' | 'print';

/**
 * 全站颜色表：所有调色板的颜色的并集（去重，小写）。
 *
 * 网格里的值就是这个表的下标 + 1。所以一个值在**任何**调色板下都解析成同一个
 * 颜色 —— 这正是"换调色板不会重新着色"的实现方式。
 */
export const MARBLING_COLORS: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const palette of MARBLING_PALETTES) {
    for (const hex of palette.colors) {
      const key = hex.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
})();

/** 网格里能出现的最大颜料值。 */
export const MARBLING_MAX_VALUE = MARBLING_COLORS.length;

/** 颜色 → 网格值（1 起）。表里没有的颜色返回 0（= 没有颜料）。 */
export function colorValueOf(hex: string): number {
  const index = MARBLING_COLORS.indexOf(hex.toLowerCase());
  return index < 0 ? 0 : index + 1;
}

/** 网格值 → 颜色；0 与越界值返回 null。 */
export function valueHex(value: number): string | null {
  if (!Number.isInteger(value) || value < 1 || value > MARBLING_MAX_VALUE) return null;
  return MARBLING_COLORS[value - 1];
}

/** 某个调色板里第 index 个颜色对应的网格值。 */
export function colorValueAt(paletteId: string, index: number): number {
  const palette = marblingPalette(paletteId);
  const hex = palette.colors[Math.max(0, Math.min(MARBLING_COLOR_COUNT - 1, Math.round(index)))];
  return colorValueOf(hex);
}

export interface MarblingDraft {
  version: 2;
  palette: string;
  color: number;
  tool: MarblingTool;
  /** 水面上的颜料网格（游程编码）。 */
  cells: string;
  /** 撤销栈：每次改动画面前那份 cells。最多 MARBLING_MAX_HISTORY 步。 */
  history: string[];
  /** 已经揭起来的那张成品（游程编码）。没有印过就是 null。 */
  print: string | null;
  stage: MarblingStage;
  /** 纸盖在水面上的进度 0..1：0 是纸完全在水面上方，1 是完全贴住水面。 */
  lay: number;
  /** 纸是否曾经完全贴住水面 —— 只有贴满过，揭起来才算印了一张。 */
  inked: boolean;
}

export function marblingPalette(id: string): MarblingPalette {
  return MARBLING_PALETTES.find((palette) => palette.id === id) ?? MARBLING_PALETTES[0];
}

export function emptyGrid(): Uint8Array {
  return new Uint8Array(MARBLING_W * MARBLING_H);
}

export function gridHasPaint(grid: Uint8Array): boolean {
  for (let i = 0; i < grid.length; i += 1) if (grid[i] !== MARBLING_EMPTY) return true;
  return false;
}

/** 同值成段，游程编码比逐格数组小一到两个数量级。 */
export function encodeGrid(grid: Uint8Array): string {
  const parts: string[] = [];
  let value = grid[0] ?? MARBLING_EMPTY;
  let count = 1;
  for (let i = 1; i < grid.length; i += 1) {
    if (grid[i] === value) { count += 1; continue; }
    parts.push(`${value}:${count}`);
    value = grid[i];
    count = 1;
  }
  parts.push(`${value}:${count}`);
  return parts.join(',');
}

export function decodeGrid(raw: string): Uint8Array | null {
  if (!raw || raw.length > 3_000_000) return null;
  const grid = new Uint8Array(MARBLING_W * MARBLING_H);
  let index = 0;
  for (const part of raw.split(',')) {
    const separator = part.indexOf(':');
    if (separator <= 0) return null;
    const value = Number(part.slice(0, separator));
    const count = Number(part.slice(separator + 1));
    if (!Number.isInteger(value) || value < MARBLING_EMPTY || value > MARBLING_MAX_VALUE) return null;
    if (!Number.isInteger(count) || count < 1) return null;
    if (index + count > grid.length) return null;
    grid.fill(value, index, index + count);
    index += count;
  }
  return index === grid.length ? grid : null;
}

export function freshMarbling(): MarblingDraft {
  return {
    version: 2,
    palette: MARBLING_PALETTES[0].id,
    color: 0,
    tool: 'drop',
    cells: encodeGrid(emptyGrid()),
    history: [],
    print: null,
    stage: 'water',
    lay: 0,
    inked: false,
  };
}

export function setMarblingPalette(draft: MarblingDraft, palette: string): MarblingDraft {
  return { ...draft, palette: marblingPalette(palette).id };
}

export function setMarblingColor(draft: MarblingDraft, color: number): MarblingDraft {
  return { ...draft, color: Math.max(0, Math.min(MARBLING_COLOR_COUNT - 1, Math.round(color))) };
}

export function setMarblingTool(draft: MarblingDraft, tool: MarblingTool): MarblingDraft {
  return { ...draft, tool };
}

/** 记一步历史并把新网格写回草稿。网格没变就不记（免得撤销栈被空操作塞满）。 */
export function withGrid(draft: MarblingDraft, grid: Uint8Array): MarblingDraft {
  const cells = encodeGrid(grid);
  if (cells === draft.cells) return draft;
  const history = [...draft.history, draft.cells].slice(-MARBLING_MAX_HISTORY);
  return { ...draft, cells, history };
}

export function undoMarbling(draft: MarblingDraft): MarblingDraft {
  if (!draft.history.length) return draft;
  return {
    ...draft,
    cells: draft.history[draft.history.length - 1],
    history: draft.history.slice(0, -1),
  };
}

/**
 * 换一盆清水：水面的颜料清空，已经揭起来的成品保留（它是纸上的一张画，不在盆里）。
 *
 * 旧网格进撤销栈 —— 这是"不可挽回"与"一条命令就能推翻"的区别，比弹一个确认框
 * 更贴合手上在做的这件事。
 */
export function clearMarbling(draft: MarblingDraft): MarblingDraft {
  const cells = encodeGrid(emptyGrid());
  if (cells === draft.cells) {
    return draft.stage === 'water' && !draft.print ? draft : { ...draft, stage: 'water', lay: 0, inked: false };
  }
  return {
    ...draft,
    cells,
    history: [...draft.history, draft.cells].slice(-MARBLING_MAX_HISTORY),
    stage: 'water',
    lay: 0,
    inked: false,
  };
}

/**
 * 揭起纸时把水面的图案烘成成品。
 *
 * 接触转印是**不镜像**的：纸贴上去、吸起颜料、再揭起来，纸上的图案与水面一一对应
 * （翻过来看才镜像，而我们是看正面）。
 */
export function takePrint(draft: MarblingDraft): MarblingDraft {
  return { ...draft, print: draft.cells };
}

/**
 * 设置纸盖住水面的进度，并推进状态机。
 *
 * 【为什么只有一个 `lay`】铺纸与揭纸是同一个动作的两头：往下拖就是盖上去，往上拖
 * 就是揭起来。做成两个按钮（「铺纸」「揭起」）等于把一件连续的事拆成两个生硬的
 * 状态 —— 而"看着纸一点点吸起花纹"正是这一款最该有的那几秒。
 *
 * 状态推进：
 *   · 盖满（lay ≥ 1）→ `inked` 置真，stage 变 'paper'；
 *   · 从盖满退到全揭开（lay ≈ 0 且 inked）→ 烘成品，stage 变 'print'；
 *   · 没盖满就退回去 → 回到 'water'，不产生成品（纸没碰到水，什么也没印上）。
 */
export function setMarblingLay(draft: MarblingDraft, lay: number): MarblingDraft {
  if (!Number.isFinite(lay)) return draft;
  const value = Math.max(0, Math.min(1, lay));
  const inked = draft.inked || value >= 0.999;
  let stage: MarblingStage = draft.stage;
  if (value > 0.001) stage = 'paper';
  else stage = inked ? 'print' : 'water';
  let next: MarblingDraft = { ...draft, lay: value, inked, stage };
  // 揭到全开、而且真的盖满过 —— 这时候才有成品。
  if (value <= 0.001 && inked && draft.stage !== 'print') next = takePrint(next);
  return next;
}

/** 从成品回到水面：纸收起来，盆里的颜料还在，可以再拉一张。 */
export function reprintMarbling(draft: MarblingDraft): MarblingDraft {
  return { ...draft, stage: 'water', lay: 0, inked: false };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * 滴一滴颜料。
 *
 * 【同心环是怎么长出来的】这一步写错了，无论滴多少下都只有最后一坨颜色：
 *
 *   1. 新的一滴在圆心铺成一个圆盘（`rim` 之内全是新色）。
 *   2. 圆盘**之外**的旧颜料被往外推，推到比圆盘边缘更远的地方。
 *
 * 第 2 步的关键是：**被推到圆盘外面的，就是原先被圆盘盖住的那块颜料**。
 * 反向映射 `a = d - u(d)` 在圆盘边缘处算出的源半径会落到圆心附近 —— 那不是错误，
 * 那正是"圆心那块颜料被顶到了外圈"。于是每滴一次，旧花纹就整体往外挪一圈，
 * 而圆心换上新色；反复滴同一处，就是一圈套一圈。
 *
 * 【同色也照样推】在已有同色颜料上再滴一滴，旧的那圈照样被推开。若判"颜色没变
 * 就跳过"，玩家会以为点了没反应，也就永远叠不出纹样。
 *
 * 【源半径夹到 0，不要跳过】夹到 0 之外就 `continue` 的话，圆盘外会留出一条
 * 采不到料的水缝 —— 屏幕上是一圈虚线似的碎点。夹到圆心则采到的是圆心那块的旧色，
 * 环是连续的。
 *
 * `value` 是烘好的颜色值（见文件头），不是调色板下标。
 */
export function dropPaint(source: Uint8Array, cx: number, cy: number, value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 1 || value > MARBLING_MAX_VALUE) return source;
  const out = source.slice();
  const radius = 62;
  /**
   * 圆盘之外被推多远。
   *
   * 要明显大于圆盘半径的零头，环与环之间才拉得开、看得清是一圈圈的；
   * 太小则每圈都紧贴着圆盘、糊成一片。
   */
  const PUSH = 78;
  const reach = radius + PUSH;
  const seed = (cx * 12.9898 + cy * 78.233) % (Math.PI * 2);
  const minX = Math.max(0, Math.floor(cx - reach - 2));
  const maxX = Math.min(MARBLING_W - 1, Math.ceil(cx + reach + 2));
  const minY = Math.max(0, Math.floor(cy - reach - 2));
  const maxY = Math.min(MARBLING_H - 1, Math.ceil(cy + reach + 2));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      // 不规则边缘：一圈花边而不是正圆 —— 正圆看着像贴上去的圆点。
      const rim = radius * (0.9 + 0.1 * Math.sin(angle * 3 + seed));
      if (distance > reach) continue;
      const index = y * MARBLING_W + x;
      if (distance <= rim) { out[index] = value; continue; }
      /**
       * 位移：圆盘边缘处最大，到 `reach` 归零。
       *
       * 指数取 1.6 而不是 1：指数 1 是线性收尾，环与环紧挨着；1.6 让靠近圆盘的
       * 那段推得更狠，环与环之间就松开了。
       */
      const spread = (distance - rim) / PUSH;
      if (spread > 1) continue;
      const push = PUSH * Math.pow(1 - spread, 1.6);
      // 源半径夹到 0：负值采圆心那块旧色，环才连得起来（见上面的说明）。
      const sourceRadius = Math.max(0, distance - push);
      const sx = Math.round(cx + Math.cos(angle) * sourceRadius);
      const sy = Math.round(cy + Math.sin(angle) * sourceRadius);
      if (sx < 0 || sy < 0 || sx >= MARBLING_W || sy >= MARBLING_H) continue;
      const sampled = source[sy * MARBLING_W + sx];
      // 采到水就写水：旧颜料被推走之后，那儿本来就露着水色。
      out[index] = sampled;
    }
  }
  return out;
}

/**
 * 双线性取样。
 *
 * 【为什么不能用 `Math.round` 就近取】平流每走一步都要重新取样，就近取整会让误差
 * 一步步攒成锯齿 —— 屏幕上就是一圈毛刺，像喷枪喷的，不像水里的颜料。按距离加权
 * 混两个格子的值，边缘就顺下来了。
 *
 * 混色只在**有颜料的格子之间**做；任一格是空白就退回那一格非空的值（空白不参与
 * 平均，否则颜料会被水"稀释"成半透明的脏色）。
 */
function sampleGrid(grid: Uint8Array, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (gx: number, gy: number): number => {
    const cx = gx < 0 ? 0 : gx >= MARBLING_W ? MARBLING_W - 1 : gx;
    const cy = gy < 0 ? 0 : gy >= MARBLING_H ? MARBLING_H - 1 : gy;
    return grid[cy * MARBLING_W + cx];
  };
  const v00 = at(x0, y0);
  const v10 = at(x0 + 1, y0);
  const v01 = at(x0, y0 + 1);
  const v11 = at(x0 + 1, y0 + 1);
  // 空白不参与平均：只把非空的格子按权重加起来，权重归一。
  let weight = 0;
  let sum = 0;
  const add = (value: number, w: number) => {
    if (value === MARBLING_EMPTY || w <= 0) return;
    sum += value * w;
    weight += w;
  };
  add(v00, (1 - fx) * (1 - fy));
  add(v10, fx * (1 - fy));
  add(v01, (1 - fx) * fy);
  add(v11, fx * fy);
  if (weight <= 0) return MARBLING_EMPTY;
  // 权重不足一半时，说明这块地方大半是水 —— 不要凭空造出颜料。
  if (weight < 0.34) return MARBLING_EMPTY;
  return Math.round(sum / weight);
}

/**
 * 一枚针尖印章：一次**反向映射的平流**。
 *
 * 对圆内的每个格子，算出"这块颜料是从哪儿来的"（沿拖动方向的**反**方向采一格），
 * 把那一格的颜色搬过来。于是：
 *
 *   · 颜料被拖过去的地方留下颜料（拖动方向的前方堆起一道脊）；
 *   · 原来在的地方缺了一块（后方空出水色）。
 *
 * 这两半就是针在真的水面印花上留下的那道沟，缺一半都不像。
 *
 * 【为什么从 `buffer` 采样、写进拷贝】读与写必须分开。就地改写会出现"读到自己
 * 刚刚写进去的值"，位移会自我放大成一团糊。而每一步都拿上一步的结果当输入
 * （见 `needleStroke` 的累积），针才越拖越深 —— 一次性的位移是看不出来的。
 */
function stampNeedle(buffer: Uint8Array, cx: number, cy: number,
  moveX: number, moveY: number, radius: number): Uint8Array {
  const out = buffer.slice();
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(MARBLING_W - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(MARBLING_H - 1, Math.ceil(cy + radius));
  const length = Math.hypot(moveX, moveY) || 1;
  const normalX = -moveY / length;
  const normalY = moveX / length;
  /**
   * 侧向的弯按位移大小缩放。
   *
   * 固定幅度是不行的：它会在每一步上都把采样点推到同一个侧向，几十步累积下来
   * 就是横扫出去的一片尖刺。跟着位移走，针划出来的才是收放自如的弧线。
   */
  const curlAmount = length * 0.55;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      // 中心拖得最远、边缘几乎不动 —— 针尖划过水面就是这个剖面。
      const falloff = Math.pow(1 - distance / radius, 1.4);
      const curl = Math.sin((distance / radius) * Math.PI) * curlAmount;
      const sx = x - moveX * falloff + normalX * curl;
      const sy = y - moveY * falloff + normalY * curl;
      if (sx < 0 || sy < 0 || sx > MARBLING_W - 1 || sy > MARBLING_H - 1) continue;
      // 反向映射：这一格收下它上游那一格的颜色（空也照收，沟才会真的空出来）。
      out[y * MARBLING_W + x] = sampleGrid(buffer, sx, sy);
    }
  }
  return out;
}

/**
 * 针：沿这一段拖动，**逐步累积**每枚印章的平流。
 *
 * 【每步只挪 `位移/步数`】这一点很容易写错：若每一枚印章都用整段位移，一段 30 格的
 * 拖动会被放大成 `步数 × 30`，颜料被抽成横扫整个水面的长条（还带锯齿）。逐步分摊之后，
 * 累计位移正好等于手指走的那段距离 —— 拖多远，颜料就跟着走多远。
 *
 * 累积本身也是必须的：每一枚印章都从最初那张网格采样的话，位移永远只有一步那么浅，
 * 屏幕上完全看不出来。
 */
export function needleStroke(source: Uint8Array, from: { x: number; y: number }, to: { x: number; y: number }, radius = 20): Uint8Array {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  // 没动就**原样返回同一个数组**，不是一份拷贝：调用方靠引用没变来认出"这一下不算数"。
  if (distance < 0.4) return source;
  const steps = Math.max(1, Math.ceil(distance / (radius * 0.45)));
  // 位移按步数分摊，累计起来就等于这段拖动的长度。
  const moveX = clamp(dx, -26, 26) / steps;
  const moveY = clamp(dy, -26, 26) / steps;
  let buffer = source;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    buffer = stampNeedle(buffer, from.x + dx * t, from.y + dy * t, moveX, moveY, radius);
  }
  return buffer;
}

/**
 * 梳子：把一条**正弦形的横向剪切**作用在整段划过的水面上。
 *
 * 真实的梳子不是一排针 —— 它是一条带齿的直线压进水里再横着走，于是颜料整体被
 * 推成一道波纹，齿距决定波纹的疏密。所以这里不叠印章，而是对整段一次算出位移：
 *
 *     offset = 拖动距离 × cos(法向坐标 / 齿距)
 *
 * 齿正对着的地方被推得最远、齿缝里几乎不动，于是原有的花纹被搓成平行的波纹。
 * 法向坐标取「离这一划中心线的距离」，所以波纹跟着这一划的方向走。
 *
 * 【一次算完，不逐步累加】逐格累加会让每一格被反复重采样几十次，边缘被磨成毛刺 ——
 * 屏幕上就是一圈锯齿。梳子在水里是**一次成型**的动作，一次采样就够了，纹路也干净。
 */
export function combStroke(source: Uint8Array, from: { x: number; y: number }, to: { x: number; y: number }): Uint8Array {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  // 同 needleStroke：没动就返回原数组。
  if (distance < 0.4) return source;
  const out = source.slice();
  // 拖动方向与法向。
  const dirX = dx / distance;
  const dirY = dy / distance;
  const normalX = -dirY;
  const normalY = dirX;
  /** 齿距（法向上相邻两齿的间隔）与振幅上限。 */
  const spacing = 26;
  /**
   * 振幅要压住。
   *
   * 取到几十格时，波纹会把整圈颜料抽成尖角，环与环在中心撞成一片。十几格刚好够
   * 看出"被梳过"，又不至于把花纹搅烂 —— 梳子在水面印花里是**整理**纹理的工具，
   * 不是把纹理撕碎的工具。
   */
  const amplitude = Math.min(distance * 0.25, 14);
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  /** 带状区域：整段长度的两头各留一个齿距，波纹在边缘处自然收住。 */
  const halfAlong = distance / 2 + spacing;
  const minX = Math.max(0, Math.floor(midX - halfAlong - amplitude));
  const maxX = Math.min(MARBLING_W - 1, Math.ceil(midX + halfAlong + amplitude));
  const minY = Math.max(0, Math.floor(midY - halfAlong - amplitude));
  const maxY = Math.min(MARBLING_H - 1, Math.ceil(midY + halfAlong + amplitude));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5 - midX;
      const py = y + 0.5 - midY;
      // 沿拖动方向与法向分解。
      const along = px * dirX + py * dirY;
      const across = px * normalX + py * normalY;
      // 两头的位移平滑收到 0：硬切会把花纹截成一段尖角。
      const taper = Math.cos((along / halfAlong) * (Math.PI / 2));
      if (taper <= 0) continue;
      // 齿正对处推得最远、齿缝里几乎不动 —— 于是搓出平行的波纹。
      const offset = amplitude * Math.cos((across / spacing) * Math.PI) * taper;
      const sx = x + dirX * offset;
      const sy = y + dirY * offset;
      if (sx < 0 || sy < 0 || sx > MARBLING_W - 1 || sy > MARBLING_H - 1) continue;
      out[y * MARBLING_W + x] = sampleGrid(source, sx, sy);
    }
  }
  return out;
}

export function parseMarblingDraft(raw: string | null): MarblingDraft | null {
  if (!raw || raw.length > 4_000_000) return null;
  try {
    const data = JSON.parse(raw) as Partial<MarblingDraft> | null;
    if (!data || data.version !== 2) return null;
    if (typeof data.cells !== 'string' || !decodeGrid(data.cells)) return null;
    const palette = MARBLING_PALETTES.some((entry) => entry.id === data.palette) ? data.palette! : MARBLING_PALETTES[0].id;
    const color = Number.isInteger(data.color) && Number(data.color) >= 0 && Number(data.color) < MARBLING_COLOR_COUNT
      ? Number(data.color) : 0;
    const tool: MarblingTool = data.tool === 'needle' || data.tool === 'comb' ? data.tool : 'drop';
    const history = Array.isArray(data.history)
      ? data.history.filter((entry): entry is string => typeof entry === 'string' && decodeGrid(entry) !== null)
        .slice(-MARBLING_MAX_HISTORY)
      : [];
    const print = typeof data.print === 'string' && decodeGrid(data.print) ? data.print : null;
    const lay = typeof data.lay === 'number' && Number.isFinite(data.lay) ? Math.max(0, Math.min(1, data.lay)) : 0;
    const inked = data.inked === true;
    let stage: MarblingStage = data.stage === 'paper' || data.stage === 'print' ? data.stage : 'water';
    // 没有成品就不可能是"看成品"这一步；纸没盖住水面也不可能是"盖着"。
    if (stage === 'print' && !print) stage = 'water';
    if (stage === 'paper' && lay <= 0.001) stage = 'water';
    return { version: 2, palette, color, tool, cells: data.cells, history, print, stage, lay, inked };
  } catch {
    return null;
  }
}
