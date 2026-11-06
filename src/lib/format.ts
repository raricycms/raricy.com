// 序列化 / 展示辅助

import type { Category } from '@prisma/client';

/**
 * 统一 API 响应格式：{ code, message, ...data }。
 *
 * 一律 no-store：这些响应大多按 cookie 现算（当前用户 / 未读 / 会话列表），
 * 不该被浏览器或中间缓存留下副本 —— 讨论、通知这类私有数据尤其如此。
 */
export function apiOk<T extends object>(data: T = {} as T, message = 'ok') {
  return Response.json(
    { code: 200, message, ...data },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
export function apiErr(code: number, message: string, extra: object = {}) {
  return Response.json({ code, message, ...extra }, { status: code, headers: { 'Cache-Control': 'no-store' } });
}

/** 分类完整路径：`父分类 > 子分类`；没有父分类时就是自身名称。 */
export function categoryFullPath(
  cat: Pick<Category, 'name' | 'parentId'> & { parent?: { name: string } | null }
): string {
  if (cat.parentId == null || !cat.parent) return cat.name;
  return `${cat.parent.name} > ${cat.name}`;
}

/** 列表展示用日期：库里墙上时间的 `YYYY-MM-DD` 部分。 */
export function ymd(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * 库里墙上时间的 `YYYY-MM-DD HH:MM:SS` 文本形态。
 *
 * 用 toISOString 切片而非 toLocaleString：库里存的已经是 UTC+8 墙上时间
 * （见 db-time.ts），toISOString 按 UTC 解读正好把那个墙上时间原样吐回来。
 * 换成 toLocaleString 会按运行机器的时区再平移一次 —— 服务器不在 UTC+8 时就错 8 小时。
 */
export function ymdhms(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 库里墙上时间的 `YYYY-MM-DD HH:MM`（**分钟级**，流水/最近记录列表用）。
 *
 * 与 `ymdhms` 同一套「toISOString 按 UTC 解读」的理由；差在精度：列表里秒没有信息量，
 * 反而把行撑长。入参接受 ISO 文本或 Date（DTO 里两种都有）；null / 无效值回空串
 *（页面既有口径：宁可不显示，也不显示 `Invalid Date`）。
 */
export function ymdhm(input: Date | string | null | undefined): string {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
