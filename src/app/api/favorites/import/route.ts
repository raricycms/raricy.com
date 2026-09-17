// POST /api/favorites/import — 从 JSON 导入成一个**新**收藏夹
//
// 【为什么走 JSON body 而不是 multipart 文件上传】
// 本站的请求体上限有三道闸（nginx client_max_body_size 12m / next.config 的
// middlewareClientMaxBodySize / 路由层的常量），三者的失败模式还不一样（nginx 回
// 413 HTML 页、Next **静默截断**）。前端用 FileReader 把文件读成文本再 POST，
// 就把这三道闸全部绕开了 —— 唯一的体积约束落在应用层（导入条数封顶 1000），
// 不需要动任何部署配置。
//
// 【为什么导入总是新建，而不是并入已有收藏夹】
// 性质（公开/私密）创建时定、此后不可改，所以导入必须问一次「建成哪种」；
// 若允许并入，就会撞上「目标夹是公开的、但文件作者以为是私密」这类语义冲突。
//
// ⚠️ 文件里的 isPublic / publicId / 收藏夹 id **一律忽略**，性质由请求体决定 ——
//    否则一个手改过的文件就能指定新行的对外句柄或可见性。

import { apiOk, apiErr } from '@/lib/format';
import { importFavorite } from '@/lib/favorite-service';
import { favoriteFail, readJsonBody, requireCoreUser } from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const body = await readJsonBody(req);
  if (!body) return apiErr(400, '请求体格式错误');
  if (typeof body.isPublic !== 'boolean') {
    return apiErr(400, '必须显式指定 isPublic（创建后不可修改）');
  }

  const res = await importFavorite(auth.user.id, body.isPublic, body.data);
  if (!res.ok) return favoriteFail(res.reason);

  return apiOk({
    favorite: {
      id: res.favorite.id,
      public_id: res.favorite.publicId,
      title: res.favorite.title,
      is_public: res.favorite.isPublic,
      created_at: res.favorite.createdAt?.toISOString() ?? null,
    },
    created: res.created,
    skipped: res.skipped,
  });
}
