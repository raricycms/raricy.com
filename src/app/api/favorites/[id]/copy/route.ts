// POST /api/favorites/:id/copy — 复制一个收藏夹为私密/公开（**快照**）
//
// `:id` 既可能是内部 UUID（自己的收藏夹，含私密），也可能是 6 位公开句柄
// （别人的公开收藏夹，从分享页复制）。两种形态互不相交，安全性由服务层的
// resolveCopySource 结构性保证 —— 不要在路由里再判一次所有权，那会让
// 「从二维码复制别人的公开合辑」失效。
//
// 复制是**快照**：复制那一刻的标题与条目，之后两边各走各的。
// 前端必须把这件事说出来 —— 用户很容易以为是活链接。

import { apiOk, apiErr } from '@/lib/format';
import { copyFavorite } from '@/lib/favorite-service';
import { favoriteFail, readJsonBody, requireCoreUser } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const { id } = await ctx.params;
  const body = await readJsonBody(req);
  if (!body) return apiErr(400, '请求体格式错误');
  // 复制出来的那份是私密还是公开 —— 同样要求显式指定（创建后不可改）
  if (typeof body.isPublic !== 'boolean') {
    return apiErr(400, '必须显式指定 isPublic（创建后不可修改）');
  }

  const res = await copyFavorite(id, auth.user.id, body.isPublic);
  if (!res.ok) return favoriteFail(res.reason);

  return apiOk({
    favorite: {
      id: res.favorite.id,
      public_id: res.favorite.publicId,
      title: res.favorite.title,
      is_public: res.favorite.isPublic,
      created_at: res.favorite.createdAt?.toISOString() ?? null,
    },
    item_count: res.itemCount,
  });
}
