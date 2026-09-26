// ─────────────────────────────────────────────────────────────────────────────
// market-math.ts — 练手盘结算的**唯一公式**（含杠杆与爆仓）
//
// 【为什么单独一个模块】这条算术有两个调用方，而它们**必须给出同一个数**：
//   · 服务端 `market-service.closePosition` —— 真结算，写进 payout_units 与那条流水
//   · 页面 `TradePanel` 的「涨跌幅 / 手续费 / 预计到手」—— 用户按下「确认卖出」之前
//     看着做决定的几个数
// 两处各写一遍 = 谁改了服务端那份，页面就**静默地开始骗人**（而屏幕上那几个数看起来
// 完全合理）。所以公式只此一处，两边 import 同一个函数。
//
// 【零依赖】与 fish-units / fish-amount 同款：页面是客户端组件，而 market-service
// 拖着 prisma 进不了客户端包。这个模块**不 import 任何东西**，两边都能用。
//
// ── 结算（杠杆版）────────────────────────────────────────────────────────────
//   notionalUnits  = stakeUnits × leverage                    ← 名义本金
//   rawEquityUnits = stakeUnits + notionalUnits × (平仓价/开仓价 − 1)
//   grossUnits     = max(0, rawEquityUnits)                   ← 「毛额」
//   payoutUnits    = max(0, floor(rawEquityUnits − notionalUnits × 平仓价/开仓价 × 费率))
//
//   ★ 那个 max(0, …) 就是爆仓 ★
//     权益在「开仓价 × (1 − 1/杠杆)」处归零，再跌下去公式给出负数 —— 而负数在这个
//     账本里**没有表示法**（postEntry 只收非零整数、users.driedFish 不许为负、余额必须
//     等于流水之和）。于是 0 截断。用户亏光投入、一分不多欠 —— 这就是爆仓的定义。
//     换句话说：**爆仓不是加在借贷之上的一道安全措施，它是账本形态逼出来的唯一形态。**
//     ⚠️ 手动平仓与强制平仓走**同一个 max(0, …)**，所以价格穿过爆仓价之后两条路给出
//     同一个数（都是 0）。这不是巧合，是必需的：若手动平能亏穿，账本当场撕裂；若强制
//     平能多留一点给用户，理性策略就变成「别平，等它爆我」—— 那是个鼓励用户等待的产品。
//
//   · **杠杆是借来的钱，但没有任何一行账**：它只放大了「凭空加进余额 / 少发给他」这个
//     原本就存在的量（那个「无限水池」是账外概念，见 market-service 文件头）。
//     所以没有利息、没有还款路径、没有可借的账户 —— 它们都不需要存在。
//
//   · **费率乘在「平仓时的名义本金」上**（notionalUnits × 平仓价/开仓价），三个理由：
//       1. 现实中手续费按成交金额收，而平仓这一笔的成交金额正是它；
//       2. 杠杆越高摩擦越大 —— 10 倍的仓位平价进出也要付 10 倍的钱。这是杠杆最自然的
//          一道刹车（手续费是速度刹不是护城河，见 market-service 头部）；
//       3. **杠杆=1 时逐位退回改动前的算式** floor(stake × 平仓价/开仓价 × (1 − 费率))。
//          这一条不是洁癖：存量仓位、钉死结算数的用例、e2e 里那个「涨一倍 = 1.9996 条」
//          都建立在旧算式上，而它们钉的是「用户到手多少」。
//          （实测：两者在 1 倍下数学等价，20 万组随机样本里只有 1 组差 1 个存储单位
//          —— 0.0001 条，且发生在价格翻 300 万倍的荒谬输入上。所以这里**不留特判分支**，
//          一条公式到底；分两条路才是真的会 drift。）
//
//   · 仍然**最后只 floor 一次**，仍然**朝系统一侧**（宁可少发一个存储单位也不凭空多铸）。
//     零头上界 = 存储精度 0.0001 条，见 fish-units.ts 文件头。
//
// 【leverage 是必填项，刻意没有默认值】不给 `leverage?: number = 1` 那种默认 —— 一个
// 忘了传杠杆的调用点会**静默地按 1 倍结算**（10 倍的仓位结算成 1 倍），而屏幕上那个数
// 看起来完全合理。必填让 tsc 在每个调用点问一次「这里的杠杆从哪来」。
//
// 【屏幕上那个「手续费」包含什么】feeUnits = 毛额 − 实发，于是
// 「毛额 − 手续费 = 到手」在弹窗里**逐字对得上**。它比真实费率多出的那一丁点是 floor
// 的零头（上界一个存储单位 = 0.0001 条），刻意不单列一行：那是给用户看的账，
// 不是给对账看的账。
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseSettleInput {
  /** 投入的**存储单位**数（> 0）。业务鱼干 × FISH_UNIT_SCALE，见 fish-units.ts */
  stakeUnits: number;
  /** 开仓价（USDT）。仓位行上那一列就是它 */
  entryPrice: number;
  /**
   * 平仓价（USDT）。服务端那边是下单**那一刻现取**的价 —— 不是展示缓存价。
   * 强制平仓时传的是那行上写死的**爆仓价**（见 liquidationPrice），于是实发恒为 0。
   */
  exitPrice: number;
  /** 费率，0.0002 = 0.02%。来源是 market-service 的 MARKET_FEE_RATE（平仓侧只收这一次） */
  feeRate: number;
  /** 杠杆倍数，1 = 无杠杆。**必填**（理由见文件头最后一节） */
  leverage: number;
}

export interface CloseSettle {
  /**
   * 毛额（**未 floor**）= 权益（负数截断到 0）。
   * 杠杆 > 1 时它**不是**名义本金也不是持仓市值 —— 它就是「这一笔现在值多少鱼干」。
   */
  grossUnits: number;
  /** 实发（floor 过）。服务端写进 `payout_units` 与流水的那一个数 */
  payoutUnits: number;
  /** 手续费 + floor 扔掉的零头（见文件头最后一节） */
  feeUnits: number;
  /** 行情涨跌幅（%）。**不含**手续费 —— 与 profitPercent 差一个费率×杠杆，别互相替代 */
  changePercent: number;
  /** 盈亏率（%）：(实发 − 投入) / 投入。10 倍仓涨 1% 时它约等于 +10%，而 changePercent 是 1 */
  profitPercent: number;
}

/**
 * 保证金归零的价 —— 归零即爆仓。**多头**：开仓价 × (1 − 1/杠杆)。
 *
 * 【为什么与 settleClose 拆成两个函数】它是**开仓那一刻**就要写进仓位行的数（用户
 * 按买入之前也要看到它），而 settleClose 要等到平仓。两者钉在同一个零点上：把这个
 * 返回值当 exitPrice 喂给 settleClose，实发恒为 0（用例钉着这条，别让它漂）。
 *
 * 【1 倍返回 0】不是「还没算」也不是哨兵值 —— 价格到不了 0 以下，所以 1 倍仓位永远
 * 碰不到它，字面意思就是「不会爆仓」。页面对 1 倍显示「—」而不是显示「0 USDT」。
 * ⚠️ 别把 0 改成 null / NaN 去表达「不适用」：库里那一列是 NOT NULL DEFAULT 0 的实数，
 *   而强平引擎的判据是 `现价 <= 爆仓价` —— 0 在这个判据下天然正确。
 */
export function liquidationPrice(entryPrice: number, leverage: number): number {
  // 写成 !(leverage > 1) 而不是 leverage <= 1：NaN 也落到这一档，返回 0 比返回 NaN 安全
  if (!(leverage > 1)) return 0;
  return entryPrice * (1 - 1 / leverage);
}

/**
 * 费率 → 页面上的百分比文本（`0.0002` → `"0.02%"`）。
 *
 * 【为什么它是一个函数】页面上那两处「手续费 X%」原先各自写着
 * `(feeRate * 100).toFixed(1)` —— 而「保留几位小数」是**跟着费率走的量**：费率是
 * 0.1% 时它对，换成 0.02% 就渲染出「手续费 0.0%」，屏幕上那句话读起来仍然通顺，
 * **不报任何错**。所以位数在这里定死（至少两位小数），页面只负责插值。
 * 放这个模块是因为它零依赖 —— 页面（客户端组件）与任何服务端调用方都能 import
 * 同一个（同 `settleClose` 的理由，见文件头）。
 */
export function formatFeeRate(feeRate: number): string {
  // 先给足位数再去尾零：0.0002 → '0.0200' → 0.02；0.001 → '0.1000' → 0.1
  const pct = Number((feeRate * 100).toFixed(4));
  const decimals = Math.max(2, `${pct}`.split('.')[1]?.length ?? 0);
  return `${pct.toFixed(decimals)}%`;
}

export function settleClose(input: CloseSettleInput): CloseSettle {
  const { stakeUnits, entryPrice, exitPrice, feeRate, leverage } = input;
  const ratio = exitPrice / entryPrice;
  const notionalUnits = stakeUnits * leverage;
  // 未截断的权益：跌破爆仓价之后它是**负数**，而负数在这里是有意义的中间量 ——
  // 下面两处 max(0, …) 才做截断。别提前截，那样就分不清「亏光」与「亏穿」。
  const rawEquityUnits = stakeUnits + notionalUnits * (ratio - 1);
  const feeUnitsRaw = notionalUnits * ratio * feeRate;
  const payoutUnits = Math.max(0, Math.floor(rawEquityUnits - feeUnitsRaw));
  // 毛额也截断到 0，否则弹窗里会出现「毛额 −123 → 手续费 −123 → 到手 0」这种账，
  // 而「毛额 − 手续费 = 到手」必须逐字对得上（见文件头最后一节）。亏光时三行是 0/0/0。
  const grossUnits = Math.max(0, rawEquityUnits);
  return {
    grossUnits,
    payoutUnits,
    feeUnits: grossUnits - payoutUnits,
    // 涨跌幅仍按原式算（不写 (ratio-1)*100）：两者数学等价，但原式在「平价」时逐位是 0
    changePercent: ((exitPrice - entryPrice) / entryPrice) * 100,
    profitPercent: ((payoutUnits - stakeUnits) / stakeUnits) * 100,
  };
}
