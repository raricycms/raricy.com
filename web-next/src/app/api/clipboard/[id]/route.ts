// GET /api/clipboard/:id — 单个剪贴板正文
//
// 对齐 Flask detail 路由：软删除 → 404；私有且非作者 → 403。

import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';
import { getClip } from '@/lib/clipboard-service';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();

  const result = await getClip(id, user?.id);
  if (!result.ok) {
    if (result.reason === 'forbidden') return apiErr(403, '该剪贴板为私有内容');
    return apiErr(404, '剪贴板不存在');
  }

  const { clip } = result;
  return Response.json({
    code: 200,
    message: 'ok',
    clip: {
      id: clip.id,
      title: clip.title,
      author_id: clip.authorId,
      author_name: clip.authorName,
      publicity: clip.publicity,
      content: clip.content,
      created_at: clip.createdAt?.toISOString() ?? null,
    },
  });
}
