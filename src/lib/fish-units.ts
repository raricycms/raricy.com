// ─────────────────────────────────────────────────────────────────────────────
// fish-units.ts — 鱼干的存储单位 ↔ 业务单位换算
// 【约定】存储（Prisma Int，列语义 = 整数个 0.0001 鱼干）：1 鱼干 = 10000 单位。
//   业务（服务层入参/返回、DTO、前端）：以「鱼干」为单位，最多 4 位小数。
//   换算只发生在数据库边界（各 service 的 Prisma 调用点），业务层代码继续用鱼干。
//   SQLite 列保持 REAL 亲和但值全为整数（动态类型，无损存取；prisma db pull 会显示 Float，
//   以本注释与迁移文件注释为准）。迁移见 prisma/migrations/3_fish_integer_units（×10，历史）
//   与 21_fish_units_1e4（×1000，把 0.1 抬到 0.0001）。
// 【存储上限】Prisma Int 是 32 位有符号：2^31−1 = 2,147,483,647 单位 = 单账户 214,748.3647 条。
//   fish_transactions.amount 是历史累计成交量（练手盘反复买卖放大），同一个上界。
//   写超了不会静默（Prisma 在 increment 参数与读回时都抛 32 位溢出）；真要冲破就把这几列
//   换成 BigInt（64 位）并解决 BigInt 不能直接 JSON 序列化的问题，而不是悄悄调小 scale。
// 【唯一例外：Blog.fishCount】不参与本文件换算 —— 该列本来就是鱼干口径的整数（投喂累加
//   { increment: amount }，amount 是鱼干不是单位），没有过 Float 时代，迁移 3 与 21 都没碰它。
//   feedBlog 只接受 1~5 的整数投喂额。feed-service 里它和 driedFish 处理得不一样不是漏改。
// 设计背景与取舍：docs/source-design-notes.md §8
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
