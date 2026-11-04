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
// 交互动画 540 的长尾巴有两个毛病：整段动画一直拖到最后，而且最后 5% 的行程要花
// 约 310ms。这一族把「收尾」直接砍短 —— 每档有自己的**真实时长**（480 / 420 / 360 /
// 300ms），动画到点就真的结束；同时前段速度别变：
//
//   · 四条都是独立的三次贝塞尔，参数按「墙钟时间」拟合 —— 在各自前 200ms 里，
//     滑块/面板的实时位置与现版的差都 ≤ 2.3%，50% 走到的时间几乎一样（55–56ms）；
//   · 第一控制点略向右移（起步稍缓），抵消时长变短带来的加速；第二控制点右移更多，
//     让最后那段减速不至于「提前进入、拖长尾巴」；
//   · 最后 5% 行程的实际用时：现版 310ms → 256 / 201 / 146 / 88ms。
//
// 四条都是正常的三次贝塞尔，整条曲线连续可导，没有截尾、没有拼接、没有折线。
export interface TailCurve extends MotionCurve {
  /** 这一档真实播完的时长（ms）。短尾的重点就是它比 540ms 短。 */
  duration: number;
}

const TAIL_SPECS: readonly { id: string; duration: number; points: BezierPoints; note: string }[] = [
  {
    id: 'tail-480',
    duration: 480,
    points: [0.171, 1, 0.387, 1],
    note: '480ms 结束（早 60ms）：前段轨迹与现版几乎重合，最后 5% 行程从约 310ms 压到约 256ms。',
  },
  {
    id: 'tail-420',
    duration: 420,
    points: [0.185, 1, 0.502, 1],
    note: '420ms 结束（早 120ms）：中段开始能看出「到得更早」，最后 5% 行程约 201ms。',
  },
  {
    id: 'tail-360',
    duration: 360,
    points: [0.202, 1, 0.661, 1],
    note: '360ms 结束（早 180ms）：缓冲明显短了，最后 5% 行程约 146ms。',
  },
  {
    id: 'tail-300',
    duration: 300,
    points: [0.221, 1, 0.9, 1],
    note: '300ms 结束（早 240ms）：收得最狠的一档，最后 5% 行程只花约 88ms —— 用来判断缓冲收到这么短会不会太急。',
  },
];

const INTERACTION_CURVE = MOTION_CURVES.find((curve) => curve.id === 'interaction');
if (!INTERACTION_CURVE) throw new Error('curves.ts 里缺少交互动画曲线');

export const TAIL_CURVES: readonly TailCurve[] = TAIL_SPECS.map(({ id, duration, points, note }): TailCurve => ({
  id,
  name: `短尾 ${duration}ms`,
  points,
  note,
  verdict: 'candidate',
  duration,
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
