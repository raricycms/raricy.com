import { getPublicProfile } from '@/lib/user-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/users/[id] — 公开资料（绝不含 email —— 这是任何访客都能读的接口）。
//
// 【鉴权】**刻意不设档**：`/u/:id` 是匿名可达的公开主页（主页画报的二维码要把站外人
// 引到这里），接口与页面必须同档，不能一个能进一个进不去。
// 但「能读」不等于「什么都能读」—— 内容按查看者收敛在 getPublicProfile 里判：role 徽章
// 与最近文章/评论只给本人或 core+，游客只拿 username / 头像 / 简介。所以这里必须把
// 登录态**显式解析出来传进去**，漏传即越权（见该函数注释）。
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getCurrentUser();
  const profile = await getPublicProfile(
    id,
    viewer ? { id: viewer.id, isCore: isCoreUser(viewer) } : null
  );
  if (!profile) return apiErr(404, '用户不存在');
  return Response.json({ code: 200, message: 'ok', user: profile });
}
