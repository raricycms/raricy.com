import type { BezierPoints } from './bezier';

// 备选速度曲线清单 —— 这份表就是后面全站加动效时挑曲线的唯一来源。
//
// `adopt` 是站内已经在用的三条：交互动画（交互反馈统一用它）、收起档、
// 以及 150–250ms 反馈档的 `ease`。`ease` 正在被交互动画取代，暂时留在这里作对照。
// 另外几条是候选，**加进这个清单 ≠ 已经采用** —— 它们只是摆在页面上让人对着同一段动画比较。
//
// 曲线一律写成 CSS 的 `cubic-bezier()` 四元组，页面上那张图与「逐帧递增」区块都用同一个
// 元组现算（见 `bezier.ts`），所以图上看到的形状就是 CSS 真正会走的形状。
export type CurveVerdict = 'adopt' | 'candidate' | 'avoid';

export interface MotionCurve {
  id: string;
  name: string;
  points: BezierPoints;
  note: string;
  verdict: CurveVerdict;
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
// 交互动画（0.16, 1, 0.3, 1）的长尾巴来自第二控制点：y₂ = 1 让曲线在末端几乎水平，
// 最后几个百分点要慢慢爬。这一族只移动第二控制点 —— 从 (0.3, 1) 沿对角线收到
// (0.1, 0.7)，分四档：
//   · 第一控制点 (0.16, 1) 没动 → 起步速度与现版完全一样；
//   · 第二控制点只小幅移动 → 前 25% 时间里行程几乎重合（x = 0.2 处差不到 1 个点），
//     从三成时间往后才逐渐分开；
//   · 收得越多，中后段减速越少、尾巴越短，落点也越干脆（末段速度更高）。
// 四条都是正常的三次贝塞尔，整条曲线连续可导，没有截尾、没有拼接、没有折线。
const TAIL_SPECS: readonly { id: string; p2: readonly [number, number]; note: string }[] = [
  {
    id: 'tail-1',
    p2: [0.25, 0.925],
    note: '第二控制点收到 (0.25, 0.925)：最轻的一档。前段几乎看不出差别，最后 5% 行程从现版的约 310ms 缩到约 250ms。',
  },
  {
    id: 'tail-2',
    p2: [0.2, 0.85],
    note: '第二控制点收到 (0.2, 0.85)：中段开始能看出「少减速」，最后 5% 行程缩到约 160ms。',
  },
  {
    id: 'tail-3',
    p2: [0.15, 0.775],
    note: '第二控制点收到 (0.15, 0.775)：最后那段慢爬基本没有了，最后 5% 行程缩到约 110ms。',
  },
  {
    id: 'tail-4',
    p2: [0.1, 0.7],
    note: '第二控制点收到 (0.1, 0.7)：收得最狠的一档，最后 5% 行程只花约 85ms —— 用来判断「尾巴收多短会显硬」。',
  },
];

const INTERACTION_CURVE = MOTION_CURVES.find((curve) => curve.id === 'interaction');
if (!INTERACTION_CURVE) throw new Error('curves.ts 里缺少交互动画曲线');

export const TAIL_CURVES: readonly MotionCurve[] = TAIL_SPECS.map(({ id, p2, note }, index): MotionCurve => ({
  id,
  name: `短尾 ${index + 1}/4`,
  points: [INTERACTION_CURVE.points[0], INTERACTION_CURVE.points[1], p2[0], p2[1]],
  note,
  verdict: 'candidate',
}));

export const CURVE_BY_ID = new Map([...MOTION_CURVES, ...TAIL_CURVES].map((curve) => [curve.id, curve]));

export function curveCss(curve: MotionCurve): string {
  return `cubic-bezier(${curve.points.join(', ')})`;
}

export function curveById(id: string): MotionCurve {
  const curve = CURVE_BY_ID.get(id);
  if (!curve) throw new Error(`未知的动效曲线：${id}`);
  return curve;
}
