import type { BezierPoints } from './bezier';

// 备选速度曲线清单 —— 这份表就是后面全站加动效时挑曲线的唯一来源。
//
// `adopt` 是站内已经在用的三条（`docs/frontend-styles.md` §6.2）：展开档、收起档、
// 以及 150–250ms 反馈档的 `ease`。另外几条是候选，**加进这个清单 ≠ 已经采用** ——
// 它们只是摆在页面上让人对着同一段动画比较。
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
    id: 'expressive',
    name: '展开档',
    points: [0.16, 1, 0.3, 1],
    note: '起步极快、尾巴拖长。展开与入场用它，480ms 走完全程；反过来当收起用会显得「先冲一下」。',
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
    note: 'CSS 默认值。站内按钮、滑块、卡片光晕的 150–250ms 反馈现在都用它。',
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
    note: '起步就最快、一路减速。和展开档同一族但没那么极端，适合 200ms 上下的入场。',
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
    note: '比展开档再快一档的「瞬间起步」。480ms 展开嫌慢时，用它把时长压到 320ms 观感接近。',
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

export const CURVE_BY_ID = new Map(MOTION_CURVES.map((curve) => [curve.id, curve]));

export function curveCss(curve: MotionCurve): string {
  return `cubic-bezier(${curve.points.join(', ')})`;
}

export function curveById(id: string): MotionCurve {
  const curve = CURVE_BY_ID.get(id);
  if (!curve) throw new Error(`未知的动效曲线：${id}`);
  return curve;
}
