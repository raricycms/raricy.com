import { TAIL_CURVES } from './curves';

// 试验台上每个场景都摆几条「同一种动画、不同速度曲线」的变体，让人对着比较。
//
// 每条变体只描述两件事：**用哪条曲线**、**走多久**。场景自己的结构（展开、入场、
// 逐条入场……）由组件决定，所以这里是个纯数据模块 —— 除曲线清单外不 import 组件，
// 后面把它搬进规范文档时也不用动。
//
// `stagger` 只有逐条入场类场景读，其它场景忽略；写成可选而不是必填，是为了让
// 「这个场景没有逐项延迟」这件事在类型上就成立，而不是塞一个 0。

/**
 * 交互产生的反馈动画统一用这条曲线 —— 即 curves.ts 里 id 为 `interaction` 的那条
 * （显示名「交互动画」）。站内原来按 150–250ms `ease` 走的按钮、悬停光晕、滑块位移，
 * 以及按 480ms 走的展开面板，都归到这一档。
 *
 * 默认时长 540ms：曲线本身前段极快（前 25% 已走完 60% 以上），所以数字上比原来的
 * 反馈档长得多，观感上「点了就有反应」那一下并不慢 —— 拉长的是尾巴。
 * 要改默认时长只改这一个数，下表里写 `INTERACTION_DURATION` 的变体跟着一起变。
 * 原来试过 600ms，觉得收尾稍拖，现在取 540ms；展开那格仍摆 480 / 600 两列作对照。
 */
export const INTERACTION_CURVE_ID = 'interaction';
export const INTERACTION_DURATION = 540;

export type ScenarioKind =
  | 'expand'
  | 'entrance'
  | 'stagger'
  | 'overlay'
  | 'hover'
  | 'segment'
  | 'counter'
  | 'progress'
  | 'fade'
  | 'dropdown'
  | 'expand-tail'
  | 'segment-tail';

export interface MotionVariant {
  /** 场景内唯一，用作 React key。 */
  key: string;
  /** 只写曲线名会让四列长得一样，所以标签写「这条变体想说明什么」。 */
  label: string;
  curveId: string;
  duration: number;
  /** 逐项入场的相邻两项延迟（ms）。 */
  stagger?: number;
  /**
   * 这一列是不是「统一取值」那一列（页面上加边框与角标标出来）。
   * 显式写而不是按「曲线 + 时长」推：逐条入场那格有两列都是 540ms，其中「间隔 0ms」
   * 是**对照件**（用来说明没有间隔就没有层次），它不该被打上「统一取值」。
   */
  adopted?: boolean;
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
    hint: '站内所有展开面板（博客目录、下拉、设置项）都是这一格。现在统一走交互动画 540ms；紧跟其后的两列把同一条曲线分别放回 480ms 与 600ms，用来对比「尾巴拉长」到底改变了什么。其余两列是别的曲线，看的是「起步那一下有多急」。',
    variants: [
      { key: 'interaction', label: '交互动画', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, adopted: true },
      { key: 'interaction-480', label: '交互动画 480', curveId: INTERACTION_CURVE_ID, duration: 480 },
      { key: 'interaction-600', label: '交互动画 600', curveId: INTERACTION_CURVE_ID, duration: 600 },
      { key: 'swift', label: '快出缓停', curveId: 'swift-out', duration: 320 },
      { key: 'decelerate', label: '减速档', curveId: 'decelerate', duration: 360 },
    ],
  },
  {
    id: 'entrance',
    title: '入场（位移 + 淡入）',
    meta: 'opacity + translateY(12px) · 区块与卡片从下方就位',
    hint: '位移距离一样、时长也一样时，只有曲线不同。交互动画「先到再等」，减速档「慢慢收」，两头缓会显得启动发木。',
    variants: [
      { key: 'interaction', label: '交互动画', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, adopted: true },
      { key: 'out', label: 'ease-out 短', curveId: 'ease-out', duration: 240 },
      { key: 'decelerate', label: '减速档', curveId: 'decelerate', duration: 320 },
      { key: 'standard', label: '收起档', curveId: 'standard', duration: 300 },
    ],
  },
  {
    id: 'stagger',
    title: '逐条入场（stagger）',
    meta: '5 项 · 相邻延迟 0 / 20 / 28 / 55ms',
    hint: '站内现行是 28ms、最多 5 项。间隔为 0 时五条一起动、看不出层次；55ms 已经能数出条数，长列表会拖尾。第一列是统一后的取值：交互动画 540ms + 28ms 间隔。',
    variants: [
      { key: 'interaction', label: '交互动画 · 间隔 28ms', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, adopted: true, stagger: 28 },
      { key: 'zero', label: '交互动画 · 间隔 0ms', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, stagger: 0 },
      { key: 'tight', label: '间隔 20ms · 短时长', curveId: 'ease-out', duration: 260, stagger: 20 },
      { key: 'wide', label: '间隔 55ms · 收起档', curveId: 'standard', duration: 320, stagger: 55 },
    ],
  },
  {
    id: 'overlay',
    title: '弹层 / 下拉出现',
    meta: 'opacity + scale(0.96) · 从自身中心放大，不做从屏幕外飞入',
    hint: '这一格是「统一之后最可能需要例外」的地方：540ms 的弹层挡着内容，会明显等人。第一列给统一取值，第二列同一条曲线压到 220ms —— 对着看差多少，再决定要不要为弹层单开一档。',
    variants: [
      { key: 'interaction', label: '交互动画', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, adopted: true },
      { key: 'interaction-short', label: '交互动画 220（压短）', curveId: INTERACTION_CURVE_ID, duration: 220 },
      { key: 'standard', label: '收起档 200', curveId: 'standard', duration: 200 },
      { key: 'out', label: 'ease-out 160', curveId: 'ease-out', duration: 160 },
    ],
  },
  {
    id: 'hover',
    title: '卡片悬停光晕',
    meta: 'box-shadow 透明度过渡 · 把鼠标移到四张卡上分别看',
    hint: '悬停反馈没有「结束时刻」，所以曲线只影响前半段：越快越像「立刻亮」，越缓越像「慢慢渗」。第一列是统一的 540ms —— 悬停这一格最容易看出「尾巴拖长」到底要不要收短。',
    variants: [
      { key: 'interaction', label: '交互动画', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, adopted: true },
      { key: 'ease', label: 'ease 200（原取值）', curveId: 'ease', duration: 200 },
      { key: 'standard', label: '收起档 250', curveId: 'standard', duration: 250 },
    ],
  },
  {
    id: 'segment',
    title: '分段滑块的滑块位移',
    meta: 'transform: translateX · 点一下切换，看滑块走位',
    hint: '滑块位移是「有明确起止的短位移」。第一列统一走交互动画 540ms；后两列是原来的短时长，用来判断滑块该不该跟着统一 —— 短位移用过冲或两头缓都会让人觉得「卡了半拍」。',
    variants: [
      { key: 'interaction', label: '交互动画', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, adopted: true },
      { key: 'ease', label: 'ease 250（原取值）', curveId: 'ease', duration: 250 },
      { key: 'standard', label: '收起档 250', curveId: 'standard', duration: 250 },
      { key: 'swift', label: '快出缓停 220', curveId: 'swift-out', duration: 220 },
    ],
  },
  {
    id: 'counter',
    title: '数字递增',
    meta: '0 → 1000 · 由 JS 按同一条曲线算中间值',
    hint: '数字滚动不是 CSS 过渡，但中间值必须走同一条曲线，否则「数字走完了、进度条还没到」。第一列是统一取值；最后一列是回弹档，能看到过冲会把数字顶过 1000 再回落 —— 数字场景绝不能采用。',
    variants: [
      { key: 'interaction', label: '交互动画', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, adopted: true },
      { key: 'ease', label: 'ease 300（原取值）', curveId: 'ease', duration: 300 },
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
    hint: '切页动效只做透明度（见 docs/plan/page-transition-plan.md）：幅度小、时长短，曲线差异本来就弱。前两列用来确认「160ms 就够」；最后一列是「把统一后的交互动画硬套到切页上」的样子 —— 它不在统一范围内，摆在这里就是为了看出套上去有多慢。',
    variants: [
      { key: 'ease', label: 'ease 160', curveId: 'ease', duration: 160 },
      { key: 'standard', label: '收起档 160', curveId: 'standard', duration: 160 },
      { key: 'out', label: 'ease-out 120', curveId: 'ease-out', duration: 120 },
      { key: 'interaction-240', label: '交互动画 240', curveId: INTERACTION_CURVE_ID, duration: 240 },
    ],
  },
];

// ── 尾巴长度对照 ─────────────────────────────────────────────────────────────
//
// 单独一组：交互反馈的 540ms 拖得太久 —— 最后 5% 行程要磨 310ms。这里摆四档「真的
// 更早结束」的版本：时长 480 / 420 / 360 / 300ms，各自都是三次贝塞尔，参数按「前段
// 墙钟位置尽量贴着现版」拟合，所以同一时刻看起来几乎一样，区别只在什么时候收住。
const TAIL_VARIANTS: readonly MotionVariant[] = [
  { key: INTERACTION_CURVE_ID, label: '交互动画 540（现版）', curveId: INTERACTION_CURVE_ID, duration: INTERACTION_DURATION, adopted: true },
  ...TAIL_CURVES.map((curve) => ({
    key: curve.id,
    label: curve.name,
    curveId: curve.id,
    duration: curve.duration,
  })),
];

export const TAIL_SCENARIOS: readonly MotionScenario[] = [
  {
    id: 'dropdown',
    title: '下拉面板 · 尾巴长度',
    meta: 'grid-template-rows 0fr → 1fr + 外壳宽度增长 · 复刻博客目录的「全部栏目」下拉',
    hint: '这一格把博客目录筛选条里的「全部栏目」下拉搬了过来（宽度增长、面板按内容高度伸展、选项随后淡入都在）。第一列是现版交互动画 540；后四列前段轨迹几乎贴着它走，只是分别在 480 / 420 / 360 / 300ms 就真的收住 —— 并排看时，谁还在磨那最后几像素一目了然。点开每一列，或点右上角「一起重播」让五列同时再演一遍。',
    variants: TAIL_VARIANTS,
  },
  {
    id: 'expand-tail',
    title: '展开面板 · 尾巴长度',
    meta: 'grid-template-rows 0fr → 1fr · 按内容实际高度伸展',
    hint: '同样一条交互动画的前段轨迹，换成更短的时长直接播完。注意面板贴底之后：现版还要用两百多毫秒磨最后几个百分点，短尾 300 已经停了。按「一起重播」五列会同时收起再展开，结束时刻的差别更容易看出来。',
    variants: TAIL_VARIANTS,
  },
  {
    id: 'segment-tail',
    title: '分段滑块 · 尾巴长度',
    meta: 'transform: translateX · 点一下切换，看滑块走位',
    hint: '滑块位移只有一次短距离移动，尾巴长的时候最容易看出「已经到了还在挪」。点选项切换，看后四列分别在哪一刻停稳；也可以按「一起重播」让五列滑块同时前进一格 —— 前段几乎同步，谁先收住一目了然。缓冲收到 88ms 会不会显得急，也在这一格判断。',
    variants: TAIL_VARIANTS,
  },
];
