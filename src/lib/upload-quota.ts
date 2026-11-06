/** 网络上传落库时的存储配额拒绝；路由映射为现有的 400 文案。 */
export class UploadQuotaError extends Error {
  constructor() { super('上传超过存储配额'); this.name = 'UploadQuotaError'; }
}

/** 配额视图：`/api/images/quota` 与 `/api/audio/quota` 的 `quota` 字段、以及两个媒体页配额条共用的形状。 */
export interface QuotaView {
  used_mb: number;
  limit_mb: number;
  remaining_mb: number;
  usage_percent: number;
}

/**
 * 配额显示的**唯一公式**（R3-379）。
 *
 * 【为什么算对外契约】`used_mb` / `remaining_mb` 两位小数、`usage_percent` 一位小数、
 * 配额为 0 时百分比直接给 100（不除零）—— 这是 `docs/bot/image-bot.md` 与
 * `docs/bot/audio-bot.md` 逐字段向外承诺的输出。此前两条 quota 路由与两个媒体页
 * 各内联一遍同一公式，改精度时漏一处就是「页面显示 80%、接口显示 80.0%」这类静默不一致。
 *
 * ⚠️ 只做**展示取整**，不做权限判断：图床按 `isCoreUser`、音频按 `limitMb === 0` 的
 * 鉴权差异留在各自路由里（那是两个域刻意不同的地方，别收进这里）。
 */
export function quotaView(usedBytes: number, limitMb: number): QuotaView {
  const limitBytes = limitMb * 1024 * 1024;
  const remaining = Math.max(0, limitBytes - usedBytes);
  return {
    used_mb: Math.round((usedBytes / (1024 * 1024)) * 100) / 100,
    limit_mb: limitMb,
    remaining_mb: Math.round((remaining / (1024 * 1024)) * 100) / 100,
    usage_percent: limitBytes > 0 ? Math.round((usedBytes / limitBytes) * 1000) / 10 : 100,
  };
}
