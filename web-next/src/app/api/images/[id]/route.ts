import { getCurrentUser, hasAdminRights, isOwner } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getImageForServe, softDeleteImage, hardDeleteImage } from '@/lib/image-service';

// 文件路由需 Node 运行时（硬删要 fs.unlink）
export const runtime = 'nodejs';

// DELETE /api/images/:id — 删除图片
//   作者 / 管理员 → 软删除（ignore = true，保留磁盘文件）
//   站长（owner）→ 硬删除（连同磁盘文件），对齐 Flask owner 专属硬删
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

  if (isOwner(user)) {
    await hardDeleteImage(id);
    return apiOk({}, '已永久删除');
  }

  if (img.ignore) return apiErr(400, '图片已被删除');
  await softDeleteImage(id);
  return apiOk({}, '已删除');
}
