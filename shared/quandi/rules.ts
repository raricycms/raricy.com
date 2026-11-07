// ─────────────────────────────────────────────────────────────────────────────
// rules.ts — 圈地运动里「服务端与客户端必须一致」的规则数值（唯一来源）
//
// 客户端是 window 全局脚本（public/static/quandi/js/**），不能 import 这个模块，
// 所以这份文件同时是**给客户端抄的清单**：改这里的任何一个数，必须同步下面三处，
// 否则服务端与单机手感会分叉，而且不会有任何报错：
//   · public/static/quandi/js/Config.js   —— PLAYER_DEFAULTS / AI_DEFAULTS / DAYNIGHT
//   · public/static/quandi/js/modes/DayNight.js —— 相位模型与倒计时
//   · public/static/quandi/js/modes/Survive.js  —— AI dt 基准、追击 / 漫游、撞人半径
//
// 为什么把这些数抬到 shared/：以前服务端 managers 与客户端 Config.js 各写一份字面量，
// 「值相等」只是巧合，改一侧就是一次静默漂移（R3-596 昼夜、R3-598 AI 就是这么来的）。
// 服务端现在从这里取；客户端那份要由静态资源负责人按同一组值改。
// ─────────────────────────────────────────────────────────────────────────────

/** 昼夜循环：初始白天 → 渐暗 → 黑夜 → 渐亮，之后按 cycleTime 循环。 */
export const QUANDI_DAYNIGHT = {
  /** 夜间暗度（0–1），服务器与客户端都只读这一个值。 */
  darkness: 0.98,
  /** 渐暗 / 渐亮各自的时长（ms）。 */
  fadeTime: 5000,
  /** 全黑保持时长（ms）。 */
  darkTime: 10000,
  /** 一轮「渐暗 + 黑夜 + 渐亮」的总时长（ms）。 */
  cycleTime: 20000,
  /** 开局白天时长（ms）。 */
  initialTime: 10000,
} as const;

/**
 * 生存模式 AI 与撞人判定的规则数值。
 *
 * 注意 `dtMs` 与 `hitRadiusExtra`：数值同源之外，客户端的**公式**也必须按这两个值改写，
 * 否则数值一样、行为仍会漂移：
 *   · 位移 = speed × difficulty.multiplier × (deltaTime / dtMs)；
 *   · 撞人 = 距离 < player.size + enemy.size + hitRadiusExtra；
 *   · 追击 = 转向插值 chaseTurnLerp，速度 × (1 + max(0, 1 - d / detectionRadius))；
 *   · 漫游 = 每帧 2% 概率微调方向，速度不折半。
 */
export const QUANDI_AI = {
  /** AI 基础速度（像素/帧 @ dtMs）。 */
  speed: 1.5,
  /** 发现玩家的半径（像素）。 */
  detectionRadius: 150,
  /** 障碍物 / 身体碰撞的反弹距离（像素）。 */
  pushDistance: 6,
  /** 撞人判定的额外半径（像素）：player.size + enemy.size + 此值。 */
  hitRadiusExtra: 2,
  /** 位移归一用的时间基准（ms）。服务端固定 tick、客户端按真实 deltaTime 换算。 */
  dtMs: 16,
  /** 追击时每 tick 朝目标转过的比例（0–1）。 */
  chaseTurnLerp: 0.1,
  /** 被玩家撞到后进入 relax（不再追人）的时长（ms）。 */
  relaxAfterHitMs: 5000,
  /** 玩家被 AI 撞死后的无敌时长（ms）。 */
  shieldAfterHitMs: 3000,
  /** 身体 / AI 的半径（像素）。 */
  size: 8,
  /** 难度表：multiplier 速度倍率、count 初始数量、maxEnemies 上限、interval 生成间隔（ms）。 */
  difficulty: {
    slow: { multiplier: 0.9, count: 2, maxEnemies: 6, interval: 30000 },
    medium: { multiplier: 1.2, count: 3, maxEnemies: 7, interval: 20000 },
    fast: { multiplier: 1.4, count: 4, maxEnemies: 8, interval: 15000 },
    ultra: { multiplier: 2.0, count: 5, maxEnemies: 10, interval: 10000 },
  },
} as const;
