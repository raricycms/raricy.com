// GET  /api/favorites          — 列出当前用户的收藏夹（可选 ?blogId= 带上归属）
// POST /api/favorites          — 新建收藏夹（登录必需，core+）
//
// 页面挡了 core，接口也必须挡 —— 未认证用户用不了界面，却 curl 得动。

import { apiOk, apiErr } from '@/lib/format';
import { createFavorite, listOwnFavorites } from '@/lib/favorite-service';
import { favoriteFail, readJsonBody, requireCoreUser } from './_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  // blogId 只影响 contains 这一项，形态不对就当没传，不为它 400
  const blogId = new URL(req.url).searchParams.get('blogId') ?? undefined;
  const favorites = await listOwnFavorites(auth.user.id, blogId || undefined);

  return apiOk({
    favorites: favorites.map((f) => ({
      id: f.id,
      // ⚠️ publicId 只对公开收藏夹非空。这个接口是**所有者**视角，所以带上它是安全的
      // （自己的私密收藏夹自己知道它没有句柄）。给别人的接口绝不能带这列。
      public_id: f.publicId,
      title: f.title,
      is_public: f.isPublic,
      item_count: f.itemCount,
      created_at: f.createdAt?.toISOString() ?? null,
      ...(f.contains === undefined ? {} : { contains: f.contains }),
    })),
  });
}

export async function POST(req: Request) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const body = await readJsonBody(req);
  if (!body) return apiErr(400, '请求体格式错误');

  // 公私**必须在创建时显式给出**：性质一经创建不可改，所以不给默认值 ——
  // 少传一个字段就静默建出私密（或公开）收藏夹，是这里最不该有的行为。
  if (typeof body.isPublic !== 'boolean') {
    return apiErr(400, '必须显式指定 isPublic（创建后不可修改）');
  }

  const res = await createFavorite(auth.user.id, body.title, body.isPublic);
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
