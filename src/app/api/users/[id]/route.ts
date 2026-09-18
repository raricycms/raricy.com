import { getPublicProfile } from '@/lib/user-service';
import { apiErr } from '@/lib/format';

// GET /api/users/[id] — 公开资料（绝不含 email —— 这是任何访客都能读的接口）。
// 附带最近文章/评论，受用户隐私开关（showRecentBlogs / showRecentComments）控制。
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await getPublicProfile(id);
  if (!profile) return apiErr(404, '用户不存在');
  return Response.json({ code: 200, message: 'ok', user: profile });
}
