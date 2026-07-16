// GET  /api/clipboard        — 列出当前用户的剪贴板
// POST /api/clipboard        — 新建剪贴板（登录必需）
//
// 对齐 Flask app/web/clipboard/__init__.py 的 menu / upload 路由与 validator()。

import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import {
  createClip,
  listUserClips,
  CLIP_TITLE_MAX,
  CLIP_CONTENT_MAX,
} from '@/lib/clipboard-service';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const clips = await listUserClips(user.id);
  return apiOk({
    clips: clips.map((c) => ({
      id: c.id,
      title: c.title,
      publicity: c.publicity,
      created_at: c.createdAt?.toISOString() ?? null,
    })),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

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

  const result = await createClip(user.id, { title, content, publicity });
  if (!result.ok) {
    // 长度类原因在这里理论上不可达（上面已先校验过），但 service 现在也自己设防，
    // 把它们如实映射成与上面同样的文案，避免被误报成「超过 200 篇」。
    if (result.reason === 'title_too_long') return apiErr(400, 'title too long');
    if (result.reason === 'content_too_long') return apiErr(400, 'content too long');
    return apiErr(400, '一个用户只能发布200篇云剪贴板！');
  }

  return apiOk({ id: result.id }, 'success');
}
