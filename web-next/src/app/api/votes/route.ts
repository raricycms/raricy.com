import { listVotes, createVote } from '@/lib/vote-service';
import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/votes — 投票列表（ignore=false，最新在前）
export async function GET() {
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
