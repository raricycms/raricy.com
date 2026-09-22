import { getCurrentUser, isOwner } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getAudioForServe, hardDeleteAudio } from '@/lib/audio-service';
import { sendNotification } from '@/lib/notification-service';

// 文件路由需 Node 运行时（硬删要 fs.unlink 删磁盘文件）
export const runtime = 'nodejs';

// DELETE /api/audio/admin/:id — 管理端硬删除（站长专属；硬删只有这一条路径）
//   · 仅站长可用（API 返回 JSON 403，而非 403 页面）
//   · 硬删除：物理删除磁盘文件 + 删库行
//   · 删的不是自己的音频 → 给上传者发通知（force=true，绕过通知偏好）
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isOwner(user)) return apiErr(403, '无权访问');

  const { id } = await ctx.params;

  // 不过滤 ignore：**已软删的也要能硬删**（软删只是标 ignore，磁盘文件还在）。
  const audio = await getAudioForServe(id);
  if (!audio) return apiErr(400, '音频不存在');

  const authorId = audio.authorId;
  const filename = audio.filename;

  await hardDeleteAudio(id);

  // 通知被删音频的上传者（非站长本人上传时）；force 绕过对方的通知偏好设置
  if (authorId !== user.id) {
    await sendNotification({
      recipientId: authorId,
      action: '音频删除',
      actorId: user.id,
      objectType: 'audio',
      objectId: id,
      detail: `你上传的音频 "${filename}" 因违规被站长删除`,
      force: true,
    });
  }

  return apiOk({}, '已永久删除');
}
