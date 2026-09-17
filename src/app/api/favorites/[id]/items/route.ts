// POST /api/favorites/:id/items — 把一篇博客加入收藏夹（所有者）
//
// 幂等：已经在该收藏夹里就返回成功（选择器里反复勾选不该报错、也不该重复计数）。

import { apiOk, apiErr } from '@/lib/format';
import { addItem } from '@/lib/favorite-service';
import { favoriteFail, readJsonBody, requireCoreUser } from '../../_shared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const { id } = await ctx.params;
  const body = await readJsonBody(req);
  if (!body) return apiErr(400, '请求体格式错误');

  const res = await addItem(id, auth.user.id, body.blogId);
  if (!res.ok) return favoriteFail(res.reason);
  return apiOk({ item_count: res.itemCount });
}
