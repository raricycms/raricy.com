// GET    /api/favorites/:id   — 读自己的收藏夹（含私密）
// PATCH  /api/favorites/:id   — 改名
// DELETE /api/favorites/:id   — 软删
//
// ⚠️ 这三条都是**所有者限定**（服务层的 getOwnFavorite / renameFavorite /
// softDeleteFavorite 都以 userId 收口，站长也没有例外）。
//   非所有者读公开收藏夹走 /api/spider/favorites/:publicId —— 全站只有那一条公开读路径，
//   这样「公开可以、私密不行」的判断只需要在一个地方写对。
//
// ⚠️ PATCH **只接受 title**。没有任何接口能改 isPublic：性质创建时定、此后不可变，
//   改性质只能靠复制。若照着 clipboard 的 PUT（它接受 publicity）给这里也加一个字段，
//   就会造出「is_public=1 但 public_id 为 NULL」的死状态，撕开服务层的不变量 1。

import { apiOk, apiErr } from '@/lib/format';
import { getOwnFavorite, renameFavorite, softDeleteFavorite } from '@/lib/favorite-service';
import { favoriteFail, readJsonBody, requireCoreUser } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const { id } = await ctx.params;
  const res = await getOwnFavorite(id, auth.user.id);
  if (!res.ok) return favoriteFail(res.reason);

  return apiOk({
    favorite: {
      id: res.favorite.id,
      public_id: res.favorite.publicId,
      title: res.favorite.title,
      is_public: res.favorite.isPublic,
      created_at: res.favorite.createdAt?.toISOString() ?? null,
      items: res.favorite.items.map((i) => ({ blog_id: i.blogId, title: i.title })),
    },
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const { id } = await ctx.params;
  const body = await readJsonBody(req);
  if (!body) return apiErr(400, '请求体格式错误');

  // 显式挡一下：改性质的请求不是「被忽略」而是**明确报错**，否则调用方会以为改成功了
  if ('isPublic' in body) {
    return apiErr(400, '收藏夹的公开/私密性质创建后不可修改');
  }

  const res = await renameFavorite(id, auth.user.id, body.title);
  if (!res.ok) return favoriteFail(res.reason);

  return apiOk({
    favorite: {
      id: res.favorite.id,
      public_id: res.favorite.publicId,
      title: res.favorite.title,
      is_public: res.favorite.isPublic,
      created_at: res.favorite.createdAt?.toISOString() ?? null,
    },
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const { id } = await ctx.params;
  const res = await softDeleteFavorite(id, auth.user.id);
  if (!res.ok) return favoriteFail(res.reason);
  return apiOk({}, '已删除');
}
