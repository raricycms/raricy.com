// ─────────────────────────────────────────────────────────────────────────────
// types.ts — 双影（/game/twinshade）的词表与关卡形状
//
// 【这个游戏是什么】
// 一次操作，两个身体。按一次方向键，**右边那个（本体）**与**左边那个（影子）**同时
// 朝同一个方向走一格。任何一侧走不动，这次操作就整体不成立 —— 于是「往哪走」这件事
// 从「选一条路」变成「找一条两边都成立的路」。
//
// 【全部机制只有四条】（关卡一条一条地教，见 levels.ts 的 act）
//   M1 同时移动：方向键让两个身体各走一格，两侧都成立才动。
//   M2 石块：走进石头就推它一格；石头后面还有石头就一起推；推不动则这一步不成立。
//   M3 同纹石块：带同一个花纹（1–9）的石头**永远一起动、动同一个方向**。
//      推其中任何一块 = 推整组，整组的落点都得空着，否则这一步不成立。
//   M4 冰面（~）：站上冰面的身体会在同一方向上一直滑，直到撞墙 / 撞石头 / 撞另一个身体
//      才停。**石头自己不会滑**（只有身体滑）—— 这条让冰面只制造「距离差」，
//      不会制造「石头漂移」那种没法预判的连锁。滑行只算一步（moves +1）。
//
// 【为什么坐标用线性下标而不是 {x,y}】
// 引擎要频繁做「格子占用」查表与状态去重（solver 的 BFS 键），线性下标直接当
// Set / Map 的键，别在热路径里造对象。渲染层要 x/y 时用 cellXY() 现算。
//
// 【刻意不做的机制】钥匙门 / 传送 / 敌人 / 计时。四条规则已经能撑起三章关卡，
// 而且每一条都能用一句话讲清 —— 「讲不清的机制」是这个品类最常见的劝退点。
// ─────────────────────────────────────────────────────────────────────────────

/** 四个方向。顺序固定（上下左右），UI 与 solver 都按这个顺序枚举以便结果可复现。 */
export const DIRS = ['up', 'down', 'left', 'right'] as const;
export type Dir = (typeof DIRS)[number];

/** 方向增量（x 向右为正，y 向下为正，与 ASCII 行序一致）。 */
export const DIR_DELTA: Readonly<Record<Dir, { readonly dx: number; readonly dy: number }>> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

/** 该方向的反方向（撤销的方向提示、气泡文案用得到）。 */
export const OPPOSITE: Readonly<Record<Dir, Dir>> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

/** 中文方向名（提示气泡 / 状态行文案的唯一来源，别在组件里另抄一份）。 */
export const DIR_LABEL: Readonly<Record<Dir, string>> = {
  up: '上',
  down: '下',
  left: '左',
  right: '右',
};

/** 地形。目标格不算地形 —— 它叠在地板上，单独用 goals 集合表示。 */
export const TERRAIN = { floor: 0, wall: 1, ice: 2 } as const;
export type Terrain = (typeof TERRAIN)[keyof typeof TERRAIN];

// ─────────────────────────────────────────────────────────────────────────────
// 关卡：作者写 ASCII，引擎编译成 CompiledLevel
//
// 每张关卡是一组等长字符串，字符表：
//   `#` 墙            `.` 地板          `~` 冰面
//   `o` 灯（目标格）   `A` 本体出生点     `B` 影子出生点
//   `1`–`9` 同纹石块（数字 = 花纹组，同组共进退）
//   `a`–`z` 普通石块（每个字母一块；字母只用来给渲染层一个稳定身份，
//           引擎与 solver 把它们当可互换的同类）
//
// 布局约束（tests/unit/twinshade-levels.test.ts 全部逐条校验）：
//   · 每行等长、恰有一个 A 与一个 B、至少两个灯；
//   · 出生点与灯都在地板上（不能压在墙里）；
//   · par 必须等于 solver 算出来的最优步数（否则星级会变成「不可能拿到三星」）。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个关卡的定义（作者手写的那份）。 */
export interface LevelDef {
  /** 稳定 id，进度存档的键。改 id = 抹掉所有人的该关成绩，别随手改。 */
  readonly id: string;
  /** 章节号，1 起。关卡选择按它分组。 */
  readonly act: number;
  /** 关卡名（两到五个字，显示在 HUD 与关卡选择里）。 */
  readonly name: string;
  /** ASCII 布局。 */
  readonly rows: readonly string[];
  /** 最优步数（由 solver 校验，见文件头约束）。 */
  readonly par: number;
  /** 首次进入时的教学气泡（一句话，讲这一关新出现的规则或这一关的坑）。 */
  readonly coach?: string;
  /** 点「提示」时给出的作者提示（一句话，指方向而不是给答案）。 */
  readonly hint: string;
  /** 这一关引入的机制标签（关卡选择里的小角标，如 '石头' / '同纹' / '冰面'）。 */
  readonly teach?: string;
}

/** 编译后的关卡：引擎与渲染层共用的只读形状。 */
export interface CompiledLevel {
  readonly id: string;
  readonly act: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** 长度 width*height 的地形数组。 */
  readonly terrain: readonly Terrain[];
  /** 灯（目标格）的线性下标集合。 */
  readonly goals: ReadonlySet<number>;
  /** 两个身体的出生点。 */
  readonly start: { readonly a: number; readonly b: number };
  /** 石块的初始摆放。id 稳定（渲染层拿它当动画身份）。 */
  readonly blocks: readonly BlockSpec[];
  /** 同纹组号 → 该组的石块 id 列表；只含至少两块的组。 */
  readonly groups: ReadonlyMap<number, readonly number[]>;
  /** 同纹组号，升序。solver 生成状态键时按这个顺序拼，结果才可复现。 */
  readonly groupIds: readonly number[];
  readonly def: LevelDef;
}

/** 一块石头的定义。 */
export interface BlockSpec {
  /** 渲染身份，从 0 起，按 ASCII 扫描顺序分配。 */
  readonly id: number;
  /** 出生格。 */
  readonly cell: number;
  /** 同纹组号；普通石块为 null。 */
  readonly group: number | null;
}

/** 一局的可变状态（引擎里只读地产生新状态，不改旧状态）。 */
export interface GameState {
  /** 本体所在格。 */
  readonly a: number;
  /** 影子所在格。 */
  readonly b: number;
  /** 石块所在格，下标与 CompiledLevel.blocks 对齐。 */
  readonly blocks: readonly number[];
  /** 已经走了几步（滑行整段算一步）。 */
  readonly moves: number;
}

/** 一步走不成立的原因。UI 直接按这个表说人话，**别在组件里另写一套判定**。 */
export type BlockReason = 'wall' | 'block' | 'self';

/** 走不成立时的结果。两侧分别为 null 表示那一侧本来就走得动。 */
export interface MoveBlocked {
  readonly ok: false;
  readonly blocked: { readonly a: BlockReason | null; readonly b: BlockReason | null };
}

/** 走成了之后给渲染层与音效用的事件（不含「算出来的新状态」以外的真相）。 */
export interface MoveEvents {
  /** 两个身体各自的位移：from → to，slide 为滑行格数（0 = 只走一格）。 */
  readonly selves: {
    readonly a: { readonly from: number; readonly to: number; readonly slide: number };
    readonly b: { readonly from: number; readonly to: number; readonly slide: number };
  };
  /** 这一步行进过的格（按顺序，含起点），渲染层画拖尾用。 */
  readonly trail: { readonly a: readonly number[]; readonly b: readonly number[] };
  /** 被推动的石块。 */
  readonly pushes: readonly { readonly block: number; readonly from: number; readonly to: number }[];
}

/** 一步的完整结果。 */
export interface MoveAccepted {
  readonly ok: true;
  readonly state: GameState;
  readonly events: MoveEvents;
  /** 走完这一步之后是否通关。 */
  readonly solved: boolean;
}

export type MoveOutcome = MoveBlocked | MoveAccepted;

/** 结果里那句人话：谁被什么挡住了。文案的唯一来源。 */
export function blockedText(blocked: MoveBlocked['blocked']): string {
  const side = (reason: BlockReason) =>
    reason === 'wall' ? '墙' : reason === 'block' ? '石头' : '另一个身体';
  if (blocked.a && blocked.b) return `两边都被${side(blocked.a)}挡住了`;
  const who = blocked.a ? '本体' : '影子';
  return `${who}被${side((blocked.a ?? blocked.b)!)}挡住了`;
}
