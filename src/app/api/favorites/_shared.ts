// 收藏夹 API 的共用守卫与错误映射。
//
// 为什么要有这个文件：收藏夹有 7 条会话路由，每条都要「取用户 → 判档位 → 把服务层的
// 失败原因映射成中文文案」。散在 7 个文件里各写一遍，迟早有一条漏掉档位判定
// （CLAUDE.md 的档位阶梯红线：页面与接口必须同档，**每层都自己判**）。
// 与 fish/market/_auth.ts 同构 —— 路由私有目录下的下划线文件，不是 src/lib 的一部分。

import { getCurrentUser, isCoreUser, type SafeUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import type { FavoriteFailReason } from '@/lib/favorite-service';
import { FAVORITE_PER_USER_MAX, FAVORITE_ITEMS_MAX } from '@/lib/favorite-service';

/** 需要 core+ 的会话。返回 Response 表示已拦下，调用方直接 return。 */
export async function requireCoreUser(): Promise<{ user: SafeUser } | { denied: Response }> {
  const user = await getCurrentUser();
  if (!user) return { denied: apiErr(401, '请先登录') };
  if (!isCoreUser(user)) return { denied: apiErr(403, '需要核心用户权限') };
  return { user };
}

/**
 * 把服务层的失败原因映射成响应。
 *
 * 文案里的**数字一律从常量插值**，不写死 —— 改了配额而文案没跟着改，就是一次静默
 * 的 drift（comment-service.ts 记着同一条纪律）。
 */
export function favoriteFail(reason: FavoriteFailReason): Response {
  switch (reason) {
    case 'rateLimited':
      return apiErr(429, '操作过于频繁，请稍后再试');
    case 'limit':
      return apiErr(400, `一个用户最多创建 ${FAVORITE_PER_USER_MAX} 个收藏夹`);
    case 'itemsLimit':
      return apiErr(400, `一个收藏夹最多收录 ${FAVORITE_ITEMS_MAX} 篇博客`);
    case 'badinput':
      return apiErr(400, '请求参数有误');
    case 'nogenerate':
      return apiErr(500, '无法生成唯一ID，请重试');
    // 不存在 / 不是我的 / 是私密的 —— 三者对外**同为 404**，不确认存在性。
    // 私密收藏夹尤其不能回 403：那等于确认「这个 id 确实存在，只是你看不了」。
    case 'notfound':
      return apiErr(404, '收藏夹不存在');
  }
}

/** 解析 JSON 请求体，失败返回 null（调用方映射成 400）。 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}
