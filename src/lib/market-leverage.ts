// ─────────────────────────────────────────────────────────────────────────────
// market-leverage.ts — 练手盘的**杠杆与方向词表**（零依赖）
//
// 【为什么单独一个模块、为什么零依赖】这份词表有两个必须共用它的地方，而它们住不到
// 一起：服务端（`market-service.ts` 校验入参、开局落库）与**客户端组件**
// （`TradePanel.tsx` 渲染档位与方向开关）。后者进不了客户端包 —— `market-service.ts`
// 拖着 prisma。所以词表住这里，两边 import 同一份（同 `market-math.ts` /
// `blog-visibility.ts` 的做法）。
//
// 【方向与杠杆是两个维度，别互相推】方向决定爆仓价在开仓价的哪一侧、结算公式取哪一支；
// 杠杆只决定距离。它们**都**是仓位的形状，都在开仓那一刻写死（同 `liquidation_price`
// 的先例：事后重算会让「当时到底为什么爆的」变成一道无解的题）。
//
// ── ★ 「1 倍永不爆仓」只对多头成立 ★ ────────────────────────────────────────
// 加杠杆那一版里 `liquidationPrice` 对 `leverage <= 1` 返回 0，字面意思是「价格到不了
// 0 以下，所以 1 倍多头永远不会爆」。**做空把这句话证伪了**：1× 空头在价格翻到 2 倍时
// 保证金归零，那是一个完全可达的价。于是：
//   · `0` 这个哨兵的准确含义收窄成「**1× 多头** —— 结构上不可能被强平」；
//   · 「要不要强平引擎」的判据**不能**再用 `leverage > 1`（见 `needsLiquidator`）——
//     它会把 1× 空头漏在闸门与扫描之外，而漏了不报任何错。
//
// ── 杠杆：从「固定白名单」改成「整数区间」 ───────────────────────────────────
// 原来是 `[1,2,3,5,10,20] + 100`。2026-10 改成**整数 1–100 自由输入**：
//   · `MIN_LEVERAGE` / `MAX_LEVERAGE` 是**唯一**的上下界，别把 100 抄到路由、UI、
//     文案三处（改了一处漏两处 = 静默的不一致）；
//   · `LEVERAGE_PRESETS` 是**纯 UI 快捷档**，服务端一视同仁（它同时被统计页当作
//     「恒定占一行的展示档」，见 `market-stats-service.ts`）—— 它**不再**是合法集；
//   · `HIGH_RISK_LEVERAGE` 是**警告带**的下端（不是上限）。25× 起的爆仓距离只有 4%，
//     实测「以昨收开仓、当天就被打穿」的交易日跳到 9.6%（20× 是 4.4%，见
//     `docs/architecture.md` §6.13 那张表）。档位放开之后不能靠「档位即难度」表达这件事，
//     只能靠**值本身的警告**。它只影响文案，服务端照收 1–100 的每一个整数。
// ─────────────────────────────────────────────────────────────────────────────

/** 方向。`long` = 做多（价涨赚），`short` = 做空（价跌赚）。 */
export const DIRECTIONS = ['long', 'short'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * 两张**人话表**：`Record<Direction, string>`，加第三个方向时 tsc 会因缺键报错
 *（同 `blog-visibility.ts` 的做法）。展示层一律查表，别在 JSX 里写三元。
 */
/** 完整名（「做多 / 做空」）—— 表单、弹窗、流水描述用。 */
export const DIRECTION_LABELS: Record<Direction, string> = {
  long: '做多',
  short: '做空',
};
/** 单字徽标（「多 / 空」）—— 持仓行、结清行那枚角标用。 */
export const DIRECTION_BADGES: Record<Direction, string> = {
  long: '多',
  short: '空',
};

/** 盈亏方向的符号：多头 +1、空头 −1。 */
export function dirSign(direction: Direction): 1 | -1 {
  return direction === 'short' ? -1 : 1;
}

/**
 * 解析调用方给的方向。**没给 = 'long'**（存量客户端与 bot 不传这个字段，行为不变 ——
 * 这一条是向后兼容的地基，把它改成必填就等于让所有旧调用方开仓变 400）。
 * 给了但不认识 → null，调用方转 400（**不猜、不夹**，同 parseLeverage）。
 */
export function parseDirection(raw: unknown): Direction | null {
  if (raw === undefined || raw === null || raw === '') return 'long';
  return typeof raw === 'string' && (DIRECTIONS as readonly string[]).includes(raw)
    ? (raw as Direction)
    : null;
}

/** 杠杆下界。1 = 无杠杆。 */
export const MIN_LEVERAGE = 1;
/** 默认档（不传杠杆时用的那个）。 */
export const DEFAULT_LEVERAGE = 1;

/**
 * 杠杆**硬上限**。
 *
 * 【为什么是 100 而不是更高】它受两条约束，任何一条都不是审美：
 *   1. **数学硬顶**：费率乘在名义本金上，所以「开仓那一刻实发为正」要求
 *      `1 − L × MARKET_FEE_RATE > 0`，即 `L < 1 / 0.0002 = 5000`。到 5000 倍时开仓即归零。
 *      100 离它很远 —— 这一条只是说明「为什么不能无限放开」，不是 100 的来由。
 *   2. **爆仓带宽**：带宽 = `1/L`。100× 时是 1%，已经落在一根普通日内波动之内（实测
 *      58.4% 的交易日会走到），所以 100 是「买一枚几小时见分晓的硬币」那一档。再往上
 *      每一档都只是把硬币抛得更快，不产生新的玩法。
 *   改它要同步：`docs/bot/trade-bot.md`（对外契约）、页面文案、以及那几个钉死边界
 *   的用例（route/service 各一条）。
 */
export const MAX_LEVERAGE = 100;

/**
 * 警告带的下端（**不是上限**）。选中或输入 ≥ 它的倍数时，页面常驻一条危险说明。
 *
 * 【25 是实测出来的，不是整数好看】以昨收开仓的多头、当天就被打穿的交易日占比：
 * 20×（距离 5%）4.4% → **25×（距离 4%）9.6%** → 50× 34.8% → 100× 58.4%。
 * 25× 正是那条曲线拐出「小概率」的地方。它**只影响文案**：服务端照收 1–100 的每一个整数，
 * 不因为跨过 25 就变档（「档位」这个概念在自由输入下已经不存在了）。
 */
export const HIGH_RISK_LEVERAGE = 25;

/**
 * **UI 快捷档**（一排 chip）。服务端不认它 —— 它只决定哪几个值摆在按钮上，
 * 以及统计页「按杠杆」拆解表里哪几个值恒定占一行（哪怕没交易过）。
 *
 * ⚠️ 保留 1：它是不碰杠杆的人唯一会走的那一档，也是默认档。
 * ⚠️ 往这里加值**不需要**迁移（库里那一列是整数，不是枚举也不是外键）。
 */
export const LEVERAGE_PRESETS = [1, 2, 3, 5, 10, 20, 50, 100] as const;

/**
 * 解析调用方给的杠杆。**没给 = 1**（存量客户端与 bot 不传这个字段，行为不变）。
 * 给了但不是 **1–100 的整数** → null，调用方转 400。
 *
 * 【接受的形状严格】数字，或**纯十进制整数字符串**。字符串走 `/^\d+$/` 而不是裸
 * `Number()`，因为后者会把这些一起收下：`'0x10' → 16`、`'1e2' → 100`、`'2.5' → 2.5`。
 * 前两个是「用户打了别的东西、我们却当他真要 16 / 100 倍」的静默失配 —— 而失误的
 * 方向正好是**放大**（把 1e2 读成 100 倍）。
 *
 * ⚠️ **别在这里「就近取整」或夹到上限**：用户要 101 倍却静默拿到 100，而页面文案
 *（如果它按 101 渲染）与实际仓位就分了家。越界是一个**用户看得懂的错**，
 * 夹一下会把它变成一个看不见的对（同 `market-math.settleClose` 不给 leverage 默认值）。
 */
export function parseLeverage(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LEVERAGE;
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return null;
    n = Number(t);
  } else {
    return null;
  }
  if (!Number.isInteger(n) || n < MIN_LEVERAGE || n > MAX_LEVERAGE) return null;
  return n;
}

/**
 * 这一笔仓位**需不需要强平引擎**（= 它的爆仓价是不是一个可达的价）。
 *
 * 【为什么不是 `leverage > 1`】加杠杆那一版用 `leverage > 1` 表达这件事，因为那时只有
 * 多头，1 倍多头的爆仓价恒为 0（价格到不了 0 以下）。**空头把它证伪了**：任何杠杆的
 * 空头爆仓价都 > 0，1× 空头在 2× 开仓价归零。
 *
 * 【判据的两种写法等价，但这一种更贴语义】「方向是空」= 「杠杆 > 1」对多头成立；
 * 也可以用「算出来的爆仓价 > 0」，但那需要一个价。这个函数**不需要价**，因为它要回答的
 * 是开仓闸门那个问题（此刻还没取价）。
 *
 * ⚠️ 它与 `market-liquidator.ts` 扫描时的 `liquidation_price > 0` 筛选**必须同真同假**：
 * 闸门放行的仓位、扫描捞不到的仓位 = 一份没人清算的免费期权。两处都改了才一致。
 */
export function needsLiquidator(leverage: number, direction: Direction): boolean {
  return direction === 'short' || leverage > 1;
}
