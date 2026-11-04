import { sampleEasing, sampleEasingPoints, type BezierPoints } from './bezier';
import { tailCss, tailProgress, tailStops, type TailCut } from './tail';

// 备选速度曲线清单 —— 这份表就是后面全站加动效时挑曲线的唯一来源。
//
// `adopt` 是站内已经在用的三条：交互动画（交互反馈统一用它）、收起档、
// 以及 150–250ms 反馈档的 `ease`。`ease` 正在被交互动画取代，暂时留在这里作对照。
// 另外几条是候选，**加进这个清单 ≠ 已经采用** —— 它们只是摆在页面上让人对着同一段动画比较。
//
// 曲线一律写成 CSS 的 `cubic-bezier()` 四元组，页面上那张图与「逐帧递增」区块都用同一个
// 元组现算（见 `bezier.ts`），所以图上看到的形状就是 CSS 真正会走的形状。
//
// 唯一例外是 `TAIL_CURVES`（短尾变体）：它们不是另一条贝塞尔，而是把「交互动画」这条
// 曲线在时间轴上截尾，再采样成 `linear()`。取样函数同样只有一份（`curveProgress` /
// `curvePoints`），图、读数与 CSS 仍然对得上。
export type CurveVerdict = 'adopt' | 'candidate' | 'avoid';

export interface MotionCurve {
  id: string;
  name: string;
  points: BezierPoints;
  note: string;
  verdict: CurveVerdict;
  /** 短尾变体：主段与 `points` 逐帧一致，到 `cut` 处收尾。普通曲线不填。 */
  tail?: TailCut;
}

export const MOTION_CURVES: readonly MotionCurve[] = [
  {
    id: 'interaction',
    name: '交互动画',
    points: [0.16, 1, 0.3, 1],
    note: '交互产生的一切反馈统一用它，默认 540ms 走完全程。起步极快、尾巴拖长，所以「点了马上有反应」；反过来当收起用会显得「先冲一下」。',
    verdict: 'adopt',
  },
  {
    id: 'standard',
    name: '收起档',
    points: [0.4, 0, 0.2, 1],
    note: '两端都收得住，正反两个方向都自然。收起 220ms，也适合 200ms 左右的通用过渡。',
    verdict: 'adopt',
  },
  {
    id: 'ease',
    name: 'ease（现行反馈）',
    points: [0.25, 0.1, 0.25, 1],
    note: 'CSS 默认值。站内按钮、滑块、卡片光晕的原取值（150–250ms）。交互反馈已统一改走交互动画，这条留作对照 —— 同样的短时长下，它比交互动画「温」一些。',
    verdict: 'adopt',
  },
  {
    id: 'linear',
    name: 'linear 匀速',
    points: [0, 0, 1, 1],
    note: '参照系。只有进度条、循环动画这类「时间本身是信息」的地方才该用它 —— 别用在有起止的过渡上，收放都很生硬。',
    verdict: 'candidate',
  },
  {
    id: 'ease-out',
    name: 'ease-out',
    points: [0, 0, 0.58, 1],
    note: '起步就最快、一路减速。和交互动画同一族但没那么极端，适合 200ms 上下的入场。',
    verdict: 'candidate',
  },
  {
    id: 'ease-in',
    name: 'ease-in',
    points: [0.42, 0, 1, 1],
    note: '越走越快。只适合离场（元素正在消失，加速离开反而不拖沓）；用在入场会像「卡了一下才动」。',
    verdict: 'candidate',
  },
  {
    id: 'ease-in-out',
    name: 'ease-in-out',
    points: [0.42, 0, 0.58, 1],
    note: '两头都缓。适合位移距离长、需要「起步和落点都不突兀」的场景，短反馈里会显得肉。',
    verdict: 'candidate',
  },
  {
    id: 'decelerate',
    name: 'Material 减速',
    points: [0, 0, 0.2, 1],
    note: '与 ease-out 接近但尾巴更长。进入视野的动效（入场、弹层）可用。',
    verdict: 'candidate',
  },
  {
    id: 'accelerate',
    name: 'Material 加速',
    points: [0.4, 0, 1, 1],
    note: '与 ease-in 接近，中段更陡。同样只建议用在离场。',
    verdict: 'candidate',
  },
  {
    id: 'swift-out',
    name: '快出缓停',
    points: [0.22, 1, 0.36, 1],
    note: '比交互动画再快一档的「瞬间起步」。540ms 嫌慢、又不想换曲线时，用它把时长压到 320ms 观感接近。',
    verdict: 'candidate',
  },
  {
    id: 'overshoot',
    name: '回弹（过冲）',
    points: [0.34, 1.56, 0.64, 1],
    note: '中途冲过头再落回。作为对照件留着：能看到「弹性」是怎么来的，也能看出它与站内「工具感」有多不搭 —— 不建议采用。',
    verdict: 'avoid',
  },
];

// ── 短尾变体 ─────────────────────────────────────────────────────────────────
//
// 针对「交互动画 540」单独摆的一族对照：主段与它完全一样，只把收尾点提前、用几十
// 毫秒把剩下的行程走完。数字是「从整段时长的百分之几开始收尾」+「收尾本身占多长」。
//
// 为什么不用新的 cubic-bezier：贝塞尔终点固定在 x = 1，没法表达「提前走完然后停住」。
// 硬调控制点只会把中段一起改掉，「同一时刻长得很像、只是尾巴不同」这个前提就没了。
const TAIL_SPECS: readonly { id: string; cut: number; settle: number; note: string }[] = [
  {
    id: 'tail-75',
    cut: 0.75,
    settle: 0.06,
    note: '收尾点提前到 75%（约 405ms 起收，437ms 停）：几乎看不出差别，只把最后那一小段挪快。',
  },
  {
    id: 'tail-60',
    cut: 0.6,
    settle: 0.07,
    note: '60% 处开始收尾（324ms 起 38ms 走完，362ms 停）：尾巴比现版短一截，起步与中段完全一样。',
  },
  {
    id: 'tail-45',
    cut: 0.45,
    settle: 0.08,
    note: '45% 处开始收尾（243ms 起 43ms 走完，286ms 停）：「到得更干脆」已经看得出来，中段仍与现版重合。',
  },
  {
    id: 'tail-30',
    cut: 0.3,
    settle: 0.1,
    note: '30% 处开始收尾（162ms 起 54ms 走完，216ms 停）：收得最急的一档，用来试「尾巴真的不要了」会不会太硬。',
  },
];

const INTERACTION_CURVE = MOTION_CURVES.find((curve) => curve.id === 'interaction');
if (!INTERACTION_CURVE) throw new Error('curves.ts 里缺少交互动画曲线');

export const TAIL_CURVES: readonly MotionCurve[] = TAIL_SPECS.map(({ id, cut, settle, note }) => ({
  id,
  name: `短尾 ${Math.round(cut * 100)}%`,
  points: INTERACTION_CURVE.points,
  note,
  verdict: 'candidate',
  tail: { cut, settle },
}));

export const CURVE_BY_ID = new Map([...MOTION_CURVES, ...TAIL_CURVES].map((curve) => [curve.id, curve]));

export function curveCss(curve: MotionCurve): string {
  if (curve.tail) return tailCss(curve.points, curve.tail);
  return `cubic-bezier(${curve.points.join(', ')})`;
}

/** 曲线在时间进度 `x` 处的实际输出 —— 图、数字递增与 CSS 三处共用。 */
export function curveProgress(curve: MotionCurve, x: number): number {
  if (curve.tail) return tailProgress(curve.points, curve.tail, x);
  return sampleEasing(curve.points, x);
}

/** 采样成 `[x, y]` 点集。短尾曲线直接给 CSS `linear()` 用的停靠点，图与过渡完全同源。 */
export function curvePoints(curve: MotionCurve, steps = 48): [number, number][] {
  if (curve.tail) return tailStops(curve.points, curve.tail);
  return sampleEasingPoints(curve.points, steps);
}

/** 页面读数：普通曲线给四元组，短尾曲线给收尾点（完整 linear() 串太长，不往界面上塞）。 */
export function curveReadout(curve: MotionCurve): string {
  if (curve.tail) return `linear() · 收尾点 ${Math.round(curve.tail.cut * 100)}%`;
  return `cubic-bezier(${curve.points.join(', ')})`;
}

export function curveById(id: string): MotionCurve {
  const curve = CURVE_BY_ID.get(id);
  if (!curve) throw new Error(`未知的动效曲线：${id}`);
  return curve;
}
