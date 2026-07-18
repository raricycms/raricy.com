import { getCurrentUser, isOwner } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getImageForServe, hardDeleteImage } from '@/lib/image-service';
import { sendNotification } from '@/lib/notification-service';

// 文件路由需 Node 运行时（硬删要 fs.unlink 删磁盘文件）
export const runtime = 'nodejs';

// DELETE /api/images/admin/:id — 管理端硬删除（站长专属，对齐 Flask image.admin_delete_image）
//   · @owner_required：仅站长可用（API 返回 JSON 403，而非 403 页面）
//   · 硬删除：物理删除磁盘文件 + 删库行
//   · 删的不是自己的图 → 给上传者发通知（force=True，绕过通知偏好）
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isOwner(user)) return apiErr(403, '无权访问');

  const { id } = await ctx.params;

  // 对齐 Flask get_image_by_id：不过滤 ignore，取到即可硬删。
  const img = await getImageForServe(id);
  if (!img) return apiErr(400, '图片不存在');

  const authorId = img.authorId;
  const filename = img.filename;

  await hardDeleteImage(id);

  // 通知被删图片的上传者（非站长本人上传时），对齐 Flask 的 send_notification(force=True)
  if (authorId !== user.id) {
    await sendNotification({
      recipientId: authorId,
      action: '图片删除',
      actorId: user.id,
      objectType: 'image',
      objectId: id,
      detail: `你上传的图片 "${filename}" 因违规被站长删除`,
      force: true,
    });
  }

  return apiOk({}, '已永久删除');
}
