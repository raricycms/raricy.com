import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getImageForServe, softDeleteImage } from '@/lib/image-service';

// DELETE /api/images/:id — 删除图片（**一律软删**，ignore = true，保留磁盘文件）
//
// 对齐 Flask 的分工：
//   · 图床蓝图 `/image/<id>` DELETE → ImageService.soft_delete_image（本路由）
//   · admin 蓝图 `/image/admin/<id>` DELETE → 站长专属硬删（→ /api/images/admin/[id]）
//
// 【曾经的 bug】本路由里写了 `if (isOwner(user)) hardDelete(...)`，导致
// **站长永远无法软删** —— 连删自己的图都是物理删除、不可恢复，且与 Flask 的
// 两条独立路径不符。硬删应当只发生在管理端那条显式路由上。
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  const img = await getImageForServe(id);
  if (!img) return apiErr(404, '图片不存在');

  const isAuthor = img.authorId === user.id;
  if (!isAuthor && !hasAdminRights(user)) {
    return apiErr(403, '无权删除此图片');
  }

  if (img.ignore) return apiErr(400, '图片已被删除');
  await softDeleteImage(id);
  return apiOk({}, '已删除');
}
