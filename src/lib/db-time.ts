// ─────────────────────────────────────────────────────────────────────────────
// db-time.ts —— 写库时间戳的统一约定
//
// 【必读：本库的时间戳语义是「UTC+8 墙上时间，贴 Z 标签」】
//
// 来龙去脉：
//   1. Flask 用 `datetime.now()` 写 naive datetime（无时区），生产服务器 TZ = UTC+8。
//      → 库里存的是 UTC+8 的墙上时间，如 "2025-08-09 20:48:45.776483"。
//      （服务器时区由数据反推证实：daily_checkins 中显式按 UTC+8 计算的 checkin_date
//        与 date(created_at) 2170/2170 全等；若服务器为 UTC，UTC 16:00–23:59 的
//        548 条签到必然跨日不等。另有「零点签到」尖峰佐证。）
//   2. scripts/normalize-datetimes.mjs 把它转成 ISO 时**只补 'T'/'Z'、不做时区平移**
//      → "2025-08-09T20:48:45.776Z"。墙上时间被原样保留，只是被贴上了 UTC 标签。
//   3. 于是全库 31 万个时间戳的语义统一为：**数字 = UTC+8 墙上时间，时区标签 = Z（假的）**。
//
// 后果：如果 Next 用 `new Date()`（真实 UTC 瞬间）写库，新数据的语义就和老数据差 8 小时，
// 同一列出现两套语义 —— 表现为「UTC+8 凌晨 00:00–07:59 发的内容显示成前一天」、
// 按日期分组/取区间时新老数据对不齐。
//
// 因此：**所有写入 DateTime 列的地方都应使用本文件的 nowForDb()**，而不是 new Date()。
//
// 长期建议（需专门的数据迁移，不在本次范围）：把全库时间戳平移 -8h 变成真实 UTC，
// 展示层再按 Asia/Shanghai 格式化。那才是干净的做法，但要动 31 万行历史数据，
// 且展示层每一处都要改，风险与收益需另行评估。
// ─────────────────────────────────────────────────────────────────────────────

/** 本站时区偏移（UTC+8）。Flask 侧签到逻辑亦硬编码同一值。 */
export const SITE_TZ_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 写库用的“当前时间”：UTC+8 墙上时间，贴 Z 标签。
 *
 * 与 Flask `datetime.now()`（服务器 TZ=UTC+8）写出的值语义一致，
 * 从而与全部历史数据对齐。**不要用 new Date() 直接写库。**
 */
export function nowForDb(): Date {
  return new Date(Date.now() + SITE_TZ_OFFSET_MS);
}

/** UTC+8 当天的 "YYYY-MM-DD"（与 checkin-service.todayUtc8 同义）。 */
export function todayStr(): string {
  return nowForDb().toISOString().slice(0, 10);
}

/**
 * 把 "YYYY-MM-DD" 转成该墙上日期的零点（贴 Z 标签）。
 * 用于按天取区间：[dayStart(d), dayStart(d) + 24h)。
 */
export function dayStart(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}
