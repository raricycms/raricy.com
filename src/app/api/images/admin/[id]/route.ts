import { getCurrentUser, isOwner } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getImageForServe, hardDeleteImage } from '@/lib/image-service';
import { sendNotification } from '@/lib/notification-service';

// 文件路由需 Node 运行时（硬删要 fs.unlink 删磁盘文件）
export const runtime = 'nodejs';

// DELETE /api/images/admin/:id — 管理端硬删除（站长专属；硬删只有这一条路径）
//   · 仅站长可用（API 返回 JSON 403，而非 403 页面）
//   · 硬删除：物理删除磁盘文件 + 删库行
//   · 删的不是自己的图 → 给上传者发通知（force=True，绕过通知偏好）
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isOwner(user)) return apiErr(403, '无权访问');

  const { id } = await ctx.params;

  // 不过滤 ignore：**已软删的图也要能硬删**（软删只是标 ignore，磁盘文件还在）。
  const img = await getImageForServe(id);
  if (!img) return apiErr(400, '图片不存在');

  const authorId = img.authorId;
  const filename = img.filename;

  await hardDeleteImage(id);

  // 通知被删图片的上传者（非站长本人上传时）；force 绕过对方的通知偏好设置。
  // 【必须是「删除之后的尽力动作」】通知写失败不能把一次已经完成的硬删变成 500 ——
  // 前端只认 200，会把 500 当「删除失败」并保留行；站长重试只会拿到 400「不存在」，
  // 于是同一件事先报失败、再报不存在，没人知道到底删没删。
  if (authorId !== user.id) {
    try {
      await sendNotification({
        recipientId: authorId,
        action: '图片删除',
        actorId: user.id,
        objectType: 'image',
        objectId: id,
        detail: `你上传的图片 "${filename}" 因违规被站长删除`,
        force: true,
      });
    } catch (error) {
      console.warn(`[image] 硬删已提交，但通知上传者失败（不影响删除结果）id=${id}:`, error);
    }
  }

  return apiOk({}, '已永久删除');
}
