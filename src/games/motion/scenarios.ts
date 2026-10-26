import type { BezierPoints } from './bezier';

// 试验台上每个场景都摆几条「同一种动画、不同速度曲线」的变体，让人对着比较。
//
// 每条变体只描述两件事：**用哪条曲线**、**走多久**。场景自己的结构（展开、入场、
// 逐条入场……）由组件决定，所以这里是个纯数据模块 —— 零 import（除了曲线类型），
// 后面把它搬进规范文档时也不用动。
//
// `stagger` 只有逐条入场类场景读，其它场景忽略；写成可选而不是必填，是为了让
// 「这个场景没有逐项延迟」这件事在类型上就成立，而不是塞一个 0。
export type ScenarioKind =
  | 'expand'
  | 'entrance'
  | 'stagger'
  | 'overlay'
  | 'hover'
  | 'segment'
  | 'counter'
  | 'progress'
  | 'fade';

export interface MotionVariant {
  /** 场景内唯一，用作 React key。 */
  key: string;
  /** 只写曲线名会让四列长得一样，所以标签写「这条变体想说明什么」。 */
  label: string;
  curveId: string;
  duration: number;
  /** 逐项入场的相邻两项延迟（ms）。 */
  stagger?: number;
}

export interface MotionScenario {
  id: ScenarioKind;
  title: string;
  /** 一行技术说明：动的是哪个属性、站点现在的取值是什么。 */
  meta: string;
  hint: string;
  variants: readonly MotionVariant[];
}

export const MOTION_SCENARIOS: readonly MotionScenario[] = [
  {
    id: 'expand',
    title: '展开 / 收起面板',
    meta: 'grid-template-rows 0fr → 1fr · 按内容实际高度伸展，不猜 max-height',
    hint: '站内所有展开面板（博客目录、下拉、设置项）都是这一格。看的是「起步那一下有多急」—— 曲线越靠左上，第一帧给人的反应越快。',
    variants: [
      { key: 'expressive', label: '展开档（现行）', curveId: 'expressive', duration: 480 },
      { key: 'swift', label: '快出缓停', curveId: 'swift-out', duration: 320 },
      { key: 'decelerate', label: '减速档', curveId: 'decelerate', duration: 360 },
      { key: 'in-out', label: '两头缓', curveId: 'ease-in-out', duration: 480 },
    ],
  },
  {
    id: 'entrance',
    title: '入场（位移 + 淡入）',
    meta: 'opacity + translateY(12px) · 区块与卡片从下方就位',
    hint: '位移距离一样、时长也一样时，只有曲线不同。展开档「先到再等」，减速档「慢慢收」，两头缓会显得启动发木。',
    variants: [
      { key: 'expressive', label: '展开档（现行）', curveId: 'expressive', duration: 480 },
      { key: 'out', label: 'ease-out 短', curveId: 'ease-out', duration: 240 },
      { key: 'decelerate', label: '减速档', curveId: 'decelerate', duration: 320 },
      { key: 'standard', label: '收起档', curveId: 'standard', duration: 300 },
    ],
  },
  {
    id: 'stagger',
    title: '逐条入场（stagger）',
    meta: '5 项 · 相邻延迟 0 / 20 / 28 / 55ms',
    hint: '站点现行是 28ms、最多 5 项（docs/frontend-styles.md §6.2）。间隔为 0 时五条一起动、看不出层次；55ms 已经能数出条数，长列表会拖尾。',
    variants: [
      { key: 'zero', label: '间隔 0ms', curveId: 'expressive', duration: 480, stagger: 0 },
      { key: 'current', label: '间隔 28ms（现行）', curveId: 'expressive', duration: 480, stagger: 28 },
      { key: 'tight', label: '间隔 20ms · 短时长', curveId: 'ease-out', duration: 260, stagger: 20 },
      { key: 'wide', label: '间隔 55ms · 收起档', curveId: 'standard', duration: 320, stagger: 55 },
    ],
  },
  {
    id: 'overlay',
    title: '弹层 / 下拉出现',
    meta: 'opacity + scale(0.96) · 从自身中心放大，不做从屏幕外飞入',
    hint: '弹层允许比卡片入场更快 —— 它挡着内容，慢一秒都在等人。这一格看的是短时长下曲线还分不分得出来。',
    variants: [
      { key: 'expressive', label: '展开档 220', curveId: 'expressive', duration: 220 },
      { key: 'standard', label: '收起档', curveId: 'standard', duration: 200 },
      { key: 'out', label: 'ease-out 160', curveId: 'ease-out', duration: 160 },
      { key: 'swift', label: '快出缓停 180', curveId: 'swift-out', duration: 180 },
    ],
  },
  {
    id: 'hover',
    title: '卡片悬停光晕',
    meta: 'box-shadow 透明度过渡 · 把鼠标移到四张卡上分别看',
    hint: '悬停反馈没有「结束时刻」，所以曲线只影响前半段：越快越像「立刻亮」，越缓越像「慢慢渗」。这一格不能重播，用鼠标试。',
    variants: [
      { key: 'ease', label: 'ease 200（现行）', curveId: 'ease', duration: 200 },
      { key: 'standard', label: '收起档 250', curveId: 'standard', duration: 250 },
      { key: 'out', label: 'ease-out 150', curveId: 'ease-out', duration: 150 },
    ],
  },
  {
    id: 'segment',
    title: '分段滑块的滑块位移',
    meta: 'transform: translateX · 点一下切换，看滑块走位',
    hint: '滑块位移是「有明确起止的短位移」，站内现行 250ms ease。短位移用过冲或两头缓都会让人觉得「卡了半拍」。点选项比较。',
    variants: [
      { key: 'ease', label: 'ease 250（现行）', curveId: 'ease', duration: 250 },
      { key: 'standard', label: '收起档 250', curveId: 'standard', duration: 250 },
      { key: 'swift', label: '快出缓停 220', curveId: 'swift-out', duration: 220 },
      { key: 'in-out', label: '两头缓 320', curveId: 'ease-in-out', duration: 320 },
    ],
  },
  {
    id: 'counter',
    title: '数字递增',
    meta: '0 → 1000 · 由 JS 按同一条曲线算中间值',
    hint: '数字滚动不是 CSS 过渡，但中间值必须走同一条曲线，否则「数字走完了、进度条还没到」。右列是回弹档，能看到过冲会把数字顶过 1000 再回落 —— 数字场景绝不能采用。',
    variants: [
      { key: 'ease', label: 'ease 300', curveId: 'ease', duration: 300 },
      { key: 'out', label: 'ease-out 300', curveId: 'ease-out', duration: 300 },
      { key: 'standard', label: '收起档 300', curveId: 'standard', duration: 300 },
      { key: 'overshoot', label: '回弹 500（对照）', curveId: 'overshoot', duration: 500 },
    ],
  },
  {
    id: 'progress',
    title: '进度条 / 加载条',
    meta: 'width 增长 · 时间本身就是信息',
    hint: '进度条与循环动画只该用匀速：进度条的宽度就是「已完成多少」，用缓动会让人高估前期进度。其余三列是对照，看它们怎么把「还没开始」演成「快好了」。',
    variants: [
      { key: 'linear', label: 'linear 1200', curveId: 'linear', duration: 1200 },
      { key: 'ease', label: 'ease 1200', curveId: 'ease', duration: 1200 },
      { key: 'standard', label: '收起档 700', curveId: 'standard', duration: 700 },
      { key: 'out', label: 'ease-out 400', curveId: 'ease-out', duration: 400 },
    ],
  },
  {
    id: 'fade',
    title: '切页 / 内容替换淡入',
    meta: '只动 opacity · 整页切换允许的唯一位移是「不动」',
    hint: '切页动效只做透明度（见 docs/plan/page-transition-plan.md）：幅度小、时长短，曲线差异本来就弱。这一格用来确认「160ms 就够」，别再往上加。',
    variants: [
      { key: 'ease', label: 'ease 160', curveId: 'ease', duration: 160 },
      { key: 'standard', label: '收起档 160', curveId: 'standard', duration: 160 },
      { key: 'out', label: 'ease-out 120', curveId: 'ease-out', duration: 120 },
      { key: 'expressive', label: '展开档 240', curveId: 'expressive', duration: 240 },
    ],
  },
];
