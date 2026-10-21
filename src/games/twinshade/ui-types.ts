// ─────────────────────────────────────────────────────────────────────────────
// ui-types.ts — 双影的「渲染层契约」：组件 props、存档形状、音效句柄、class 名清单
//
// 这个文件**只有类型**（零运行时代码、零 import 副作用），所以谁都能安全地 import：
// 容器（TwinShade.tsx）按它接人，渲染层各文件按它实现。改这里的形状 = 改三处，
// 好处是接口漂移会在 tsc 那一步当场炸掉，而不是在浏览器里静悄悄地错位。
//
// ── class 名清单（scss 在 src/styles-scss/pages/game/_twinshade.scss，唯一实现处）──
// 外壳      .tw-page  .tw-shell  .tw-board-card  .tw-keys
// HUD       .tw-hud  .tw-hud__back  .tw-hud__title  .tw-hud__level  .tw-hud__meta
//           .tw-hud__actions  .tw-btn  .tw-btn--primary  .tw-btn--soft  .tw-btn--icon
//           .tw-stat  .tw-stat__label  .tw-stat__value  .tw-stat--moves  .tw-stars
//           .tw-coach  .tw-status（role=status，文案由容器给）
// 棋盘      .tw-board-wrap  .tw-board  .tw-board__bg  .tw-cell  .tw-cell--wall
//           .tw-cell--ice  .tw-cell--goal  .tw-ice-sheen  .tw-goal  .tw-goal--lit
//           .tw-goal-ring  .tw-goal-halo  .tw-trail  .tw-link-line
//           .tw-token  .tw-token--a  .tw-token--b  .tw-token--blocked
//           .tw-token__core  .tw-token__glow  .tw-token__ring
//           .tw-block  .tw-block--linked  .tw-block__face  .tw-block__mark
//           .tw-aim  .tw-spark
// 方向键    .tw-dpad  .tw-dpad__btn  .tw-dpad__up/-down/-left/-right
// 关卡选择  .tw-levels  .tw-levels__panel  .tw-levels__head  .tw-act  .tw-level-item
//           .tw-level-item--current  .tw-level-item--done  .tw-level-item__no
//           .tw-level-item__name  .tw-stars
// 通关      .tw-result  .tw-result__panel  .tw-result__stars  .tw-result__stats
//           .tw-result__actions
// 首屏引导  .tw-onboard  .tw-onboard__panel  .tw-onboard__rules  .tw-rule
//           .tw-rule__icon
// ── data-* 钩子（e2e 靠它们取数，别改名）──────────────────────────────────────
//   .tw-board[data-level-id][data-solved]     棋盘的身份与「这一刻是否通关」
//   .tw-cell[data-cell="x,y"]                 一格的坐标
//   .tw-token[data-token="a|b"]               两个身体
//   .tw-block[data-block="id"][data-cell=…]   石块
//   .tw-stat--moves .tw-stat__value           步数读数
//   .tw-level-item[data-level-id]             关卡条目
//   .tw-result[data-stars]                    通关面板
//
// ── 棋盘 DOM（Board.tsx 产出，scss 按这个结构写；两边都别自作主张改层级）────────
//   <svg class="tw-board" role="img" aria-label data-level-id data-solved viewBox>
//     <defs>                              渐变 / 滤镜，id 一律以 tw- 开头
//     <rect class="tw-board__bg" />
//     <g class="tw-cells">                每格一个 rect.tw-cell，按地形叠 --wall / --ice
//     <g class="tw-goals">                每盏灯一个 g.tw-goal[data-cell]，内含
//                                         circle.tw-goal-ring + circle.tw-goal-halo
//     <g class="tw-trails">               上一步的滑行拖尾（circle.tw-trail）
//     <g class="tw-blocks">               先画 line.tw-link-line（同纹块之间），
//                                         再画 g.tw-block[data-block][data-cell]
//                                         （rect.tw-block__face + path.tw-block__mark）
//     <g class="tw-tokens">               两个 g.tw-token[data-token]，内含
//                                         circle.tw-token__glow / __core / __ring
//     <g class="tw-aims">                 提示箭头 g.tw-aim（每个身体一个）
//     <g class="tw-sparks">               通关粒子 circle.tw-spark
//   </svg>
//   棋盘**只产出这一个 svg**；外框、面板背景与覆盖层由容器与 HUD 负责。
// ─────────────────────────────────────────────────────────────────────────────

import type { BlockReason, CompiledLevel, Dir, GameState, LevelDef, MoveEvents } from './types';

/** 棋盘（纯展示，不持有任何游戏状态）。 */
export interface BoardProps {
  level: CompiledLevel;
  state: GameState;
  /** 上一步的事件；null 表示没有「刚发生的一步」（刚进关 / 撤销 / 重置）。 */
  events: MoveEvents | null;
  /**
   * 每次「发生了一件事」（走成一步 / 撤销 / 重置 / 换关）就 +1 的序号。
   * 渲染层拿它当 key 重启一次性动画（拖尾、粒子）—— 不能拿坐标当 key：
   * 原地重复同一步时坐标一模一样，动画就不会重播。
   */
  serial: number;
  /** 提示方向：两块身体上各显示一个脉冲箭头。容器在 1.8 秒后清回 null。 */
  hintDir: Dir | null;
  /** 刚被挡住的一步：当场给两侧闪红（哪一侧被挡只闪哪一侧）。 */
  blocked: { readonly a: BlockReason | null; readonly b: BlockReason | null } | null;
  /** 通关：灯全部点亮、身体合成光晕。 */
  solved: boolean;
}

/** HUD 的一行状态文案（容器算，HUD 只显示 —— 判定逻辑不许进展示层）。 */
export interface StatusLine {
  readonly text: string;
  /** 'info' 普通提示 / 'warn' 走不动 / 'good' 通关或收集。 */
  readonly tone: 'info' | 'warn' | 'good';
}

export interface HudProps {
  /** 返回玩具区的链接（宿主给，HUD 不自己拼路由）。 */
  backHref: string;
  backLabel: string;
  def: LevelDef;
  /** 当前是第几关（1 起，显示用）。 */
  index: number;
  total: number;
  moves: number;
  par: number;
  /** 按当前步数能拿到的星数（通关后才是最终值）。 */
  stars: 1 | 2 | 3;
  soundOn: boolean;
  canUndo: boolean;
  /** 教学气泡：首次进关显示 def.coach；点「知道了」后容器清成 null。 */
  coach: string | null;
  status: StatusLine;
  /** 这一关是否已经有通关记录（决定「重来」按钮的文案与副标题）。 */
  cleared: boolean;
  onUndo(): void;
  onRestart(): void;
  onHint(): void;
  onToggleSound(): void;
  onOpenLevels(): void;
  onDismissCoach(): void;
}

/** 触屏方向键（桌面端也可以点，不藏）。 */
export interface DpadProps {
  onMove(dir: Dir): void;
  disabled: boolean;
}

export interface LevelSelectProps {
  open: boolean;
  levels: readonly LevelDef[];
  currentId: string;
  /** 已通关的最好步数，键是 level id。 */
  best: Readonly<Record<string, number>>;
  onSelect(id: string): void;
  onClose(): void;
}

export interface ResultProps {
  open: boolean;
  def: LevelDef;
  moves: number;
  par: number;
  stars: 1 | 2 | 3;
  isLast: boolean;
  onNext(): void;
  onReplay(): void;
  onLevels(): void;
}

export interface OnboardingProps {
  open: boolean;
  onStart(): void;
  onDismiss(): void;
}

// ── 存档 ────────────────────────────────────────────────────────────────────
// 只进 localStorage（玩具区对匿名访客开放，不进库、不发请求）。
export interface ProgressState {
  readonly version: 1;
  /** level id → 历史最好步数。 */
  readonly best: Readonly<Record<string, number>>;
  /** 首屏引导是否看过。 */
  readonly seenIntro: boolean;
  /** 静音开关。 */
  readonly muted: boolean;
  /** 上次玩到的关卡（下次进来直接续上）。 */
  readonly lastLevelId: string | null;
}

// ── 音效 ────────────────────────────────────────────────────────────────────
// 全部用 WebAudio 现场合成（不引第三方音频素材，见 AGENTS.md 的素材纪律）。
export interface SoundHandle {
  /** 走一格：轻、短、两个音高交替，避免长时间游玩变噪音。 */
  move(): void;
  /** 推石头：低一档的闷响。 */
  push(): void;
  /** 走不动：短促的下行钝音（不是刺耳的报错音）。 */
  blocked(): void;
  /** 冰面滑行：气声，长度随滑行格数增长。 */
  slide(tiles: number): void;
  /** 通关：上行琶音；isLast 时多收一个高音。 */
  solve(isLast: boolean): void;
  /** 撤销：反向上行的小音。 */
  undo(): void;
  /** 界面点击（按钮 / 打开关卡选择）。 */
  ui(): void;
  setMuted(muted: boolean): void;
}
