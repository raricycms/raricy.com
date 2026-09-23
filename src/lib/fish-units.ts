// ─────────────────────────────────────────────────────────────────────────────
// fish-units.ts — 鱼干的存储单位 ↔ 业务单位换算
//
// 【为什么要整数化】driedFish / FishTransaction.amount / BlogFeed.amount 原是 Float
// （REAL），类货币账目用 IEEE754 逐笔累加必有舍入漂移：0.1 + 0.2 = 0.30000000000000004，
// 千万笔流水后对账差一截；余额比较（gte 防超扣、上限判定）也可能被 4.999999999 坑。
//
// 【约定】
//   • 存储（Prisma Int，列语义 = 整数个 0.0001 鱼干）：1 鱼干 = 10000 单位。
//     数据迁移见 prisma/migrations/3_fish_integer_units（×10，历史）
//     与 21_fish_units_1e4（×1000，把 0.1 抬到 0.0001）。
//     SQLite 列保持 REAL 亲和但值全为整数（动态类型，无损存取；prisma db pull 会
//     显示 Float，以本注释与迁移文件注释为准）。
//   • 业务（服务层入参/返回、DTO、前端）：以「鱼干」为单位，最多 4 位小数。
//
// 【为什么是 0.0001 而不是 0.1】练手盘的结算是
//   payoutUnits = floor(stakeUnits × 平仓价 / 开仓价 × (1 − 手续费))（见 market-service）。
//   floor 是刻意的（舍入永远朝系统一侧），代价是每次结算都朝系统丢一点点。粒度 0.1 条时
//   那一「点」最大是 0.1 条 —— 投 1 条、价格不涨过 0.1% 就必然结算成 0（那个阈值就是
//   当时的费率，0.1%），是个几乎必赔的陷阱。粒度提到 0.0001 后同样的舍入只丢 0.0001 条，
//   **损耗降 1000 倍**。见
//   docs/architecture.md §6.13。
//
// 【存储上限：Prisma Int 是 32 位有符号】上限 2^31−1 = 2,147,483,647 单位，
// 即单账户 214,748.3647 条。⚠️ 别把它只当「余额上限」算 —— fish_transactions.amount
// 是**历史累计成交量**（练手盘可反复买卖放大），同一个上界。实测 dev 库改后最大约
// 2.0×10^7 单位，余量约 105×。写超了不会静默：Prisma 在 increment 的参数与读回时
// 都会抛 32 位溢出错误。真要冲破这个量级时，正确的做法是把这几列换成 BigInt
// （64 位），并同步解决 BigInt 不能直接 JSON 序列化的问题 —— 而不是悄悄调小 scale。
//
// 【唯一的例外：Blog.fishCount】它**不参与本文件的换算** —— 该列本来就是鱼干口径的
// 整数（投喂累加 `{ increment: amount }`，amount 是鱼干不是单位），没有过 Float 时代，
// 迁移 3 与 21 都没碰它。feedBlog 只接受 1~5 的**整数**投喂额，所以喂给那个 Int 列的
// 恒是整数。feed-service 里它和 driedFish 的处理长得不一样，**不是漏改** ——
// 别为了「统一」把它也 ×10000。
//
// 换算只发生在数据库边界（各 service 的 Prisma 调用点），业务层代码继续用鱼干。
// ─────────────────────────────────────────────────────────────────────────────

/** 业务侧（鱼干）允许的小数位数，与下面的标度同源 —— 改一个另一个自动跟随。 */
export const FISH_DECIMALS = 4;

/** 存储放大系数：1 鱼干 = 10000 存储单位。 */
export const FISH_UNIT_SCALE = 10 ** FISH_DECIMALS;

/**
 * 单值的存储上限（Prisma `Int` 的 32 位有符号上界）。
 * 只作为台账与断言用，不在转换时强制 —— 理由见文件头「存储上限」段。
 */
export const MAX_FISH_UNITS = 2_147_483_647;

/**
 * 鱼干 → 存储单位。**只接受 ≤4 位小数**：静默 round 会把 0.00005 级的账目误差
 * 吞进整数里，这里宁可 fail-loud（抛普通 Error，由调用方按场景翻成 400 或 500）
 * 也不写错账。
 *
 * ⚠️ 容差是**量级自适应**的，别改回固定的 `1e-6`：`scaled` 在 i32 量级（~2.1e9）时
 * double 的 ULP 已有 ~4.8e-7，固定 1e-6 只剩几倍余量。这个常量隐含了一个适用的
 * 量程上限 —— **只调大 FISH_UNIT_SCALE 而不动它，会在最大户身上出现「合法金额被误拒」**
 * （表现为 400/500，且小号复现不出来）。
 */
export function fishToUnits(fish: number): number {
  if (!Number.isFinite(fish)) {
    throw new Error(`鱼干金额非法（非有限数）: ${fish}`);
  }
  const scaled = fish * FISH_UNIT_SCALE;
  const rounded = Math.round(scaled);
  const tol = Math.max(1e-6, Math.abs(scaled) * 4 * Number.EPSILON);
  if (Math.abs(scaled - rounded) > tol) {
    throw new Error(`鱼干金额超过 ${FISH_DECIMALS} 位小数精度: ${fish}`);
  }
  return rounded;
}

/** 存储单位 → 鱼干（读路径统一出口）。 */
export function unitsToFish(units: number): number {
  return units / FISH_UNIT_SCALE;
}
