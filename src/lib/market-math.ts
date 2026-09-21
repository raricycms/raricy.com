// ─────────────────────────────────────────────────────────────────────────────
// market-math.ts — 练手盘平仓结算的**唯一公式**
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
// 【结算】payoutUnits = floor(stakeUnits × 平仓价 / 开仓价 × (1 − 手续费率))
//   · 先算毛额、乘完费率、**最后只 floor 一次**。别先把毛额 floor 掉 —— 那会多丢一次
//     零头，算出来的数与服务端差一个单位，而这点差额恰好落在「到手多少」上。
//   · floor 是刻意的：舍入永远朝系统一侧，宁可少发一个存储单位也不凭空多铸。代价是
//     每次结算扔掉不到一个单位的零头（上界 = 存储精度 0.0001 条，见 fish-units.ts
//     文件头「为什么是 0.0001」）。
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
  /** 平仓价（USDT）。服务端那边是下单**那一刻现取**的价 —— 不是展示缓存价 */
  exitPrice: number;
  /** 费率，0.001 = 0.1%。来源是 market-service 的 MARKET_FEE_RATE（平仓侧只收这一次） */
  feeRate: number;
}

export interface CloseSettle {
  /** 毛额（**未 floor**）：投入单位数 × 平仓价 / 开仓价 */
  grossUnits: number;
  /** 实发（floor 过）。服务端写进 `payout_units` 与流水的那一个数 */
  payoutUnits: number;
  /** 手续费 + floor 扔掉的零头（见文件头最后一节） */
  feeUnits: number;
  /** 行情涨跌幅（%）。**不含**手续费 —— 与 profitPercent 差一个费率，别互相替代 */
  changePercent: number;
  /** 盈亏率（%）：(实发 − 投入) / 投入 */
  profitPercent: number;
}

export function settleClose(input: CloseSettleInput): CloseSettle {
  const grossUnits = (input.stakeUnits * input.exitPrice) / input.entryPrice;
  const payoutUnits = Math.floor(grossUnits * (1 - input.feeRate));
  return {
    grossUnits,
    payoutUnits,
    feeUnits: grossUnits - payoutUnits,
    changePercent: ((input.exitPrice - input.entryPrice) / input.entryPrice) * 100,
    profitPercent: ((payoutUnits - input.stakeUnits) / input.stakeUnits) * 100,
  };
}
