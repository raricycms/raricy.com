import { listVotes, createVote } from '@/lib/vote-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/votes — 投票列表（ignore=false，最新在前；需核心用户）
//
// 对齐 Flask /vote/ menu 的 @authenticated_required。此前完全没判权，
// 未认证用户 curl 就能拿到全站投票列表 —— 页面挡了 core，接口漏了。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const votes = await listVotes();
  return Response.json({
    code: 200,
    message: 'ok',
    votes: votes.map((v) => ({
      id: v.id,
      title: v.title,
      author_id: v.authorId,
      author_name: v.authorName,
      is_locked: v.isLocked,
      created_at: v.createdAt ? v.createdAt.toISOString() : null,
      option_count: v.optionCount,
      total_votes: v.totalVotes,
    })),
  });
}

// POST /api/votes — 创建投票（需登录，内存限频 voteCreateHourly）
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 对齐 Flask @authenticated_required：需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const body = (await req.json().catch(() => null)) as
    | { title?: unknown; options?: unknown }
    | null;
  if (!body) return apiErr(400, '请求格式错误');

  const title = typeof body.title === 'string' ? body.title : '';
  const options = Array.isArray(body.options)
    ? body.options.filter((o): o is string => typeof o === 'string')
    : null;
  if (options === null) return apiErr(400, '请提供选项列表');

  const res = await createVote(user.id, title, options);
  if ('rateLimited' in res) return apiErr(429, '创建频率过高，请稍后再试');
  if ('error' in res) return apiErr(400, res.error);

  return Response.json({ code: 200, message: 'success', data: { id: res.id } });
}
