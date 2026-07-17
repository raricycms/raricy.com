// 序列化 / 展示辅助

import type { Category } from '@prisma/client';

/** 统一 API 响应格式，对齐 Flask 的 { code, message, ...data }。 */
export function apiOk<T extends object>(data: T = {} as T, message = 'ok') {
  return Response.json({ code: 200, message, ...data });
}
export function apiErr(code: number, message: string, extra: object = {}) {
  return Response.json({ code, message, ...extra }, { status: code });
}

/** 分类完整路径，对齐 Category.get_full_path()。 */
export function categoryFullPath(
  cat: Pick<Category, 'name' | 'parentId'> & { parent?: { name: string } | null }
): string {
  if (cat.parentId == null || !cat.parent) return cat.name;
  return `${cat.parent.name} > ${cat.name}`;
}

/** 博客列表用日期（对齐 Blog.to_dict 的 '%Y-%m-%d'）。 */
export function ymd(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * 'YYYY-MM-DD HH:MM:SS'（对齐 Flask 的 .strftime('%Y-%m-%d %H:%M:%S')）。
 *
 * 用 toISOString 切片而非 toLocaleString：库里存的已经是 UTC+8 墙上时间
 * （见 db-time.ts），toISOString 按 UTC 解读正好把那个墙上时间原样吐回来。
 * 换成 toLocaleString 会按运行机器的时区再平移一次 —— 服务器不在 UTC+8 时就错 8 小时。
 */
export function ymdhms(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
