// ─────────────────────────────────────────────────────────────────────────────
// vision-task.ts — 「视觉空间任务」题型的词汇表、指令语法与求解器。
//
// 【零依赖】不 import 任何东西（不碰 sharp、不碰 node:），服务端出题、服务端判卷、
//   攻击脚本三方共用 —— 攻击脚本要能算出「标准答案」，否则没法量成功率。
//
// ── 为什么是这个题型 ────────────────────────────────────────────────────────
//
// 前面两个题型（滑块 / 点选）输在同一个性质上：**答案空间可枚举**。
//   24 个字 = 24 个模板；「黄色圆锥」= 3 色 × 4 形 = 12 个模板。预渲染一遍就完事。
//
// 这个题型换的是**指令的复杂度**，不是词汇表的规模：
//   · 指令由语法随机组合，**嵌套一层空间关系** ——
//     「点击位于最大红色棱锥左侧的最小蓝色圆柱」要求先解出参照物、再在它的左侧找目标。
//   · 攻击者没法针对某一道题 hack，**必须写一个能解析任意指令的求解器**。
//   · 多阶段串联 ⇒ p^n，且**每次失败都是全新随机题，练不了**。
//
// ⚠️ 但要说清楚：词汇表**依然是小的**（5 形 × 6 色 × 2 档大小）。真正加的是**组合**。
//   一个把「分割 + 属性分类 + 关系推理」都写全了的求解器，或者一个多模态大模型，
//   对这种任务是能做的 —— 见 attack-vision-*.mts 的实测。别把「指令看起来复杂」
//   误当成「机器做不了」。
// ─────────────────────────────────────────────────────────────────────────────

export type ShapeKind = 'cylinder' | 'cone' | 'pyramid' | 'box' | 'sphere';
export type ColorKind = 'blue' | 'red' | 'green' | 'yellow' | 'orange' | 'purple';
export type SizeRank = 0 | 1 | 2; // 小 / 中 / 大
export type Direction = 'left' | 'right' | 'above' | 'below';

export const SHAPE_LABEL: Record<ShapeKind, string> = {
  cylinder: '圆柱',
  cone: '圆锥',
  pyramid: '棱锥',
  box: '长方体',
  sphere: '球',
};

export const COLOR_LABEL: Record<ColorKind, string> = {
  blue: '蓝色',
  red: '红色',
  green: '绿色',
  yellow: '黄色',
  orange: '橙色',
  purple: '紫色',
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  left: '左侧',
  right: '右侧',
  above: '上方',
  below: '下方',
};

/** 体色。渲染器会据此推出高光面与暗面，见 vision-scene.ts。 */
export const COLOR_HEX: Record<ColorKind, string> = {
  blue: '#3b82f6',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#facc15',
  orange: '#f97316',
  purple: '#a855f7',
};

/** 场景里的一个物体。坐标是**包围盒中心**，判定点击命中时用。 */
export interface SceneObject {
  id: number;
  kind: ShapeKind;
  color: ColorKind;
  size: SizeRank;
  /** 包围盒中心的横坐标。 */
  cx: number;
  /** 包围盒中心的纵坐标。 */
  cy: number;
  /** 包围盒宽高（命中判定用）。 */
  w: number;
  h: number;
}

/**
 * 一个物体的「描述」。`withSize` 表示**这句话里要不要念出尺寸词**。
 *
 * 它**只影响读起来的样子，不影响求解**：求解永远按 (尺寸, 颜色, 形状) 三元组匹配。
 * 之所以敢省，是因为只在「颜色+形状已经唯一确定」时才省 —— 那时三元组也必然唯一。
 * 于是「中等红色棱锥」能念成「红色棱锥」：人读着顺，机器算着一样。
 */
export interface ObjDesc {
  size: SizeRank;
  color: ColorKind;
  shape: ShapeKind;
  withSize: boolean;
}

/** 一条指令。结构化的，不是字符串 —— 文本由 renderInstruction 拼出来。 */
export type Instruction =
  | ({ form: 'simple' } & ObjDesc)
  | ({ form: 'relative'; ref: ObjDesc; dir: Direction } & ObjDesc)
  /** 拖拽型：把 src 拖到 dst 上。两个物体都靠属性描述出来。 */
  | { form: 'drag'; src: ObjDesc; dst: ObjDesc };

function sizeWord(r: SizeRank): string {
  return r === 0 ? '最小' : r === 1 ? '中等' : '最大';
}

function describe(d: ObjDesc): string {
  // 省掉尺寸词时读作「红色棱锥」，带上时读作「最大的红色棱锥」
  return `${d.withSize ? sizeWord(d.size) : ''}${COLOR_LABEL[d.color]}${SHAPE_LABEL[d.shape]}`;
}

/**
 * 最小可识别描述：**能省掉尺寸词就省掉**。
 *
 * 实测出题时「中等红色棱锥」里的尺寸词十次有九次是多余的（颜色+形状已经唯一），
 * 而长指令读起来更累、更容易看错 —— 那是实打实的误杀。省掉之后指令短一半：
 *   「点击位于最大红色棱锥左侧的最小蓝色圆柱」→「点击位于红色棱锥左侧的蓝色圆柱」
 */
function minimalDesc(objects: SceneObject[], o: SceneObject): ObjDesc {
  const full: ObjDesc = { size: o.size, color: o.color, shape: o.kind, withSize: true };
  const sameColorShape = objects.filter((x) => x.color === o.color && x.kind === o.kind);
  return sameColorShape.length === 1 ? { ...full, withSize: false } : full;
}

/** 把结构化指令拼成人话。 */
export function renderInstruction(ins: Instruction): string {
  if (ins.form === 'simple') return `点击${describe(ins)}`;
  if (ins.form === 'drag') return `把${describe(ins.src)}拖到${describe(ins.dst)}上`;
  return `点击位于${describe(ins.ref)}${DIRECTION_LABEL[ins.dir]}的${describe(ins)}`;
}

/** 某个物体是否满足「尺寸 + 颜色 + 形状」这组属性。 */
function matches(o: SceneObject, size: SizeRank, color: ColorKind, shape: ShapeKind): boolean {
  return o.size === size && o.color === color && o.kind === shape;
}

/** 方向关系：a 是否在 b 的某个方向。 */
export function satisfiesDirection(a: SceneObject, b: SceneObject, dir: Direction): boolean {
  switch (dir) {
    case 'left':
      return a.cx < b.cx;
    case 'right':
      return a.cx > b.cx;
    case 'above':
      return a.cy < b.cy;
    case 'below':
      return a.cy > b.cy;
  }
}

/**
 * 解出指令指向的那个物体。
 *
 * 返回 null 表示**无解或多解** —— 出题时必须当失败重来。
 * ⚠️ **绝不能容忍多解**：一道有歧义的题，真人和攻击者都可能选到另一个，
 * 而服务端只会判「错」。判卷严格 + 出题随意 = 误杀真人。
 */
export function resolveInstruction(
  objects: SceneObject[],
  ins: Instruction
): SceneObject | null {
  if (ins.form === 'simple') {
    const hits = objects.filter((o) => matches(o, ins.size, ins.color, ins.shape));
    return hits.length === 1 ? hits[0] : null;
  }
  // 拖拽型有两个目标，不归这里管 —— 见 resolveDrag
  if (ins.form === 'drag') return null;

  const refs = objects.filter((o) => matches(o, ins.ref.size, ins.ref.color, ins.ref.shape));
  if (refs.length !== 1) return null;
  const ref = refs[0];

  const hits = objects.filter(
    (o) =>
      o.id !== ref.id &&
      matches(o, ins.size, ins.color, ins.shape) &&
      satisfiesDirection(o, ref, ins.dir)
  );
  return hits.length === 1 ? hits[0] : null;
}

/** 解拖拽型：返回要拖的与要拖到的两个物体；任一不唯一即 null。 */
export function resolveDrag(
  objects: SceneObject[],
  ins: Instruction
): { src: SceneObject; dst: SceneObject } | null {
  if (ins.form !== 'drag') return null;
  const srcHits = objects.filter((o) => matches(o, ins.src.size, ins.src.color, ins.src.shape));
  const dstHits = objects.filter((o) => matches(o, ins.dst.size, ins.dst.color, ins.dst.shape));
  if (srcHits.length !== 1 || dstHits.length !== 1) return null;
  if (srcHits[0].id === dstHits[0].id) return null;
  return { src: srcHits[0], dst: dstHits[0] };
}

// ── 出题：随机造一条「有唯一解」的指令 ──────────────────────────────────────

export interface Instruction2 {
  instruction: Instruction;
  /** 点击型：要点的那个物体。拖拽型：要拖走的那个。 */
  answer: SceneObject;
  /** 拖拽型：要拖到的那个物体；点击型为 null。 */
  drop: SceneObject | null;
}

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)];
}

/**
 * 随机造一条指令，并**验证它有唯一解**；造不出来返回 null（调用方换一组物体重来）。
 *
 * `form` 由调用方指定 —— 出题时按比例混三种形态。**刻意不让「简单型」总是赢**：
 * 简单型只是「按属性筛唯一命中」，攻击者写个属性分类器就完事；
 * 相对型要它先解参照物再比方位，拖拽型要它同时定位两个物体。难度主要在后两种。
 */
export function makeInstruction(
  objects: SceneObject[],
  rng: () => number,
  form: 'simple' | 'relative' | 'drag'
): Instruction2 | null {
  const answer = pick(objects, rng);
  const answerFull = { size: answer.size, color: answer.color, shape: answer.kind };

  if (form === 'simple') {
    const hits = objects.filter((o) => matches(o, answerFull.size, answerFull.color, answerFull.shape));
    if (hits.length !== 1) return null;
    return {
      instruction: { form: 'simple', ...minimalDesc(objects, answer) },
      answer,
      drop: null,
    };
  }

  if (form === 'relative') {
    let tries = 0;
    while (tries++ < 40) {
      const ref = pick(objects, rng);
      if (ref.id === answer.id) continue;
      // 方位偏向左右：物体摆在「货架」上，同一排的高度相近，「上/下」判起来更容易有歧义
      const dir = rng() < 0.72
        ? pick(['left', 'right'] as Direction[], rng)
        : pick(['above', 'below'] as Direction[], rng);
      if (!satisfiesDirection(answer, ref, dir)) continue;
      const ins: Instruction = {
        form: 'relative',
        ref: minimalDesc(objects, ref),
        dir,
        ...minimalDesc(objects, answer),
      };
      if (resolveInstruction(objects, ins)?.id === answer.id) {
        return { instruction: ins, answer, drop: null };
      }
    }
    return null;
  }

  // drag：src 与 dst 各自必须「按属性唯一命中」，而且**两者颜色必须不同** ——
  // 「把中等紫色球拖到最大紫色球上」这种题真人都容易搞混，属于自找误杀。
  let tries = 0;
  while (tries++ < 40) {
    const dst = pick(objects, rng);
    if (dst.id === answer.id) continue;
    if (dst.color === answer.color && dst.kind === answer.kind) continue;
    const dstHits = objects.filter((o) => matches(o, dst.size, dst.color, dst.kind));
    if (dstHits.length !== 1) continue;
    return {
      instruction: {
        form: 'drag',
        src: minimalDesc(objects, answer),
        dst: minimalDesc(objects, dst),
      },
      answer,
      drop: dst,
    };
  }
  return null;
}

// ── 判卷 ────────────────────────────────────────────────────────────────────

/** 命中判定用的「离哪个图形最近」。距离用包围盒中心的欧氏距离。 */
export function nearestObject(objects: SceneObject[], x: number, y: number): SceneObject {
  let best = objects[0];
  let bestD = Infinity;
  for (const o of objects) {
    const d = Math.hypot(o.cx - x, o.cy - y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

export interface ClickVerdict {
  ok: boolean;
  /** 落点最近的那个图形。 */
  nearest: SceneObject;
  dist: number;
}

/**
 * 判一次点击。
 *
 * 判据是**「离你点的位置最近的那个图形，是不是正确答案」**，而不是「落点是否在某个矩形里」——
 * 因为物体允许重叠，矩形判定在压叠处会有歧义（一个点同时落在两个框里），
 * 而「最近」永远只有一个。
 * 再加一道距离上限（`max(w,h) * 0.75`），免得「点在天边、恰好最近」也算过。
 */
export function judgeClick(
  objects: SceneObject[],
  answer: SceneObject,
  x: number,
  y: number
): ClickVerdict {
  const nearest = nearestObject(objects, x, y);
  const dist = Math.hypot(answer.cx - x, answer.cy - y);
  const limit = Math.max(answer.w, answer.h) * 0.75;
  return { ok: nearest.id === answer.id && dist <= limit, nearest, dist };
}
