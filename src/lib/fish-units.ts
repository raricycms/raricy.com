// ─────────────────────────────────────────────────────────────────────────────
// fish-units.ts — 鱼干的存储单位 ↔ 业务单位换算
//
// 【为什么要整数化】driedFish / FishTransaction.amount / BlogFeed.amount 原是 Float
// （REAL），类货币账目用 IEEE754 逐笔累加必有舍入漂移：0.1 + 0.2 = 0.30000000000000004，
// 千万笔流水后对账差一截；余额比较（gte 防超扣、上限判定）也可能被 4.999999999 坑。
//
// 【约定】
//   • 存储（Prisma Int，列语义 = 整数个 0.1 鱼干）：1 鱼干 = 10 单位。
//     需一次性数据迁移：prisma/migrations/3_fish_integer_units/migration.sql（×10）。
//     SQLite 列保持 REAL 亲和但值全为整数（动态类型，无损存取；prisma db pull 会
//     显示 Float，以本注释与迁移文件注释为准）。
//   • 业务（服务层入参/返回、DTO、前端）：以「鱼干」为单位，最多 1 位小数
//     （唯一的小数来源是投喂分成 0.8×n）。
//
// 换算只发生在数据库边界（各 service 的 Prisma 调用点），业务层代码继续用鱼干。
// ─────────────────────────────────────────────────────────────────────────────

/** 存储放大系数：1 鱼干 = 10 存储单位。 */
export const FISH_UNIT_SCALE = 10;

/**
 * 鱼干 → 存储单位。**只接受 ≤1 位小数**：静默 round 会把 0.05 级的账目误差
 * 吞进整数里，这里宁可 fail-loud（上层 500 / 503）也不写错账。
 */
export function fishToUnits(fish: number): number {
  if (!Number.isFinite(fish)) {
    throw new Error(`鱼干金额非法（非有限数）: ${fish}`);
  }
  const scaled = fish * FISH_UNIT_SCALE;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new Error(`鱼干金额超过 1 位小数精度: ${fish}`);
  }
  return rounded;
}

/** 存储单位 → 鱼干（读路径统一出口）。 */
export function unitsToFish(units: number): number {
  return units / FISH_UNIT_SCALE;
}
