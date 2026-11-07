import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getImageForServe, softDeleteImage } from '@/lib/image-service';

// DELETE /api/images/:id — 删除图片（**一律软删**，ignore = true，保留磁盘文件）
//
// 删除分两条路径，别把它们合并：
//   · DELETE /api/images/:id（本路由）→ 软删，图床页走这条
//   · DELETE /api/images/admin/:id    → 站长专属硬删，见 admin/[id]/route.ts
//
// 【曾经的 bug】本路由里写了 `if (isOwner(user)) hardDelete(...)`，导致
// **站长永远无法软删** —— 连删自己的图都是物理删除、不可恢复，也架空了
// 「硬删只走管理端那条显式路由」的分工。硬删应当只发生在管理端那条路由上。
//
// 【R3-385 / D 桶已批准】删除**不再先判 core**：失去 core 资格的历史作者仍能
// 撤回自己上传的媒体（软删、可恢复），否则媒体公开可读却永远撤不下来。
// 上传仍要求 core+（配额闸门在路由层），权限判定只看「登录 + 归属/管理权」。
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
