import { getCurrentUser, hasAdminRights } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { getAudioForServe, softDeleteAudio } from '@/lib/audio-service';

export const runtime = 'nodejs';

// DELETE /api/audio/:id — 删除音频（**一律软删**，ignore = true，保留磁盘文件）
//
// 删除分两条路径，别把它们合并：
//   · DELETE /api/audio/:id（本路由）→ 软删，音频床页走这条
//   · DELETE /api/audio/admin/:id    → 站长专属硬删
//
// 【曾经踩过的坑，照抄的是修正后的形状】图床那条路由里写过
// `if (isOwner(user)) hardDelete(...)`，导致**站长永远无法软删** —— 连删自己的图
// 都是物理删除、不可恢复，也架空了「硬删只走管理端那条显式路由」的分工。
// 硬删只发生在管理端那条路由上。
//
// 【R3-385 / D 桶已批准】不先判 core：失去核心资格的账号仍可软删自己上传的音频
// （历史数据可撤回）；上传侧的 core 门不变。
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  // 注意用 getAudioForServe（不按软删过滤）：换成任何「过滤掉 ignore 的元信息读法」
  // 都会让「已经被删过」伪装成 404「音频不存在」—— 这里要能分辨这两件事。
  const audio = await getAudioForServe(id);
  if (!audio) return apiErr(404, '音频不存在');

  const isAuthor = audio.authorId === user.id;
  if (!isAuthor && !hasAdminRights(user)) {
    return apiErr(403, '无权删除此音频');
  }

  if (audio.ignore) return apiErr(400, '音频已被删除');
  await softDeleteAudio(id);
  return apiOk({}, '已删除');
}
