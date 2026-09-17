// DELETE /api/favorites/:id/items/:blogId — 把一篇博客移出收藏夹（所有者）
//
// 软删条目（翻转 favorite_items.deleted），**永不物理删**。
// 同一个博客可以同时待在同一个用户的多个收藏夹里 —— 这里只影响指定的那一个。

import { apiOk } from '@/lib/format';
import { removeItem } from '@/lib/favorite-service';
import { favoriteFail, requireCoreUser } from '../../../_shared';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; blogId: string }> }
) {
  const auth = await requireCoreUser();
  if ('denied' in auth) return auth.denied;

  const { id, blogId } = await ctx.params;
  const res = await removeItem(id, auth.user.id, blogId);
  if (!res.ok) return favoriteFail(res.reason);
  return apiOk({ item_count: res.itemCount });
}
