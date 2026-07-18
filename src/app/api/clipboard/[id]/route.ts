// GET /api/clipboard/:id — 单个剪贴板正文
//   对齐 Flask detail 路由：软删除 → 404；私有且非作者/非站长 → 403。
// PUT /api/clipboard/:id — 编辑剪贴板（登录必需）
//   对齐 Flask POST /clipboard/<id>/edit：软删除/不存在 → 404；非作者 → 403；
//   校验对齐 validator()；成功返回 { code: 200, message: 'success', id }。

import { getCurrentUser, isOwner, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import {
  getClip,
  updateClip,
  CLIP_TITLE_MAX,
  CLIP_CONTENT_MAX,
} from '@/lib/clipboard-service';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  // 对齐 Flask /clipboard/<id> 的 @authenticated_required：需核心用户。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  // 站长可看私有剪贴板（对齐 Flask 的 `and not current_user.is_owner`）
  const result = await getClip(id, user.id, isOwner(user));
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

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 对齐 Flask @authenticated_required：需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  const data = (body ?? {}) as Record<string, unknown>;

  // 校验，对齐 Flask validator()
  const { title, content, publicity } = data;
  if (typeof publicity !== 'boolean') {
    return apiErr(400, 'wrong publicity format');
  }
  if (typeof content !== 'string' || content.length > CLIP_CONTENT_MAX) {
    return apiErr(400, 'content too long');
  }
  if (typeof title !== 'string' || title.length < 1 || title.length > CLIP_TITLE_MAX) {
    return apiErr(400, 'title too long');
  }

  const result = await updateClip(id, user.id, { title, content, publicity });
  if (!result.ok) {
    if (result.reason === 'forbidden') return apiErr(403, '您不是该文章作者，无法编辑！');
    // 长度类原因在这里理论上不可达（上面已先校验过），但 service 现在也自己设防，
    // 把它们如实映射成与上面同样的文案，避免被误报成「剪贴板不存在」。
    if (result.reason === 'title_too_long') return apiErr(400, 'title too long');
    if (result.reason === 'content_too_long') return apiErr(400, 'content too long');
    return apiErr(404, '剪贴板不存在');
  }

  return apiOk({ id: result.id }, 'success');
}
