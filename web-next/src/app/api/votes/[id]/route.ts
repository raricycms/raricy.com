import { getVoteDetail } from '@/lib/vote-service';
import { getCurrentUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/votes/:id — 投票详情（选项计数 + 当前用户已投项）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();

  const vote = await getVoteDetail(id, user?.id ?? null);
  if (!vote) return apiErr(404, '投票不存在');

  return Response.json({
    code: 200,
    message: 'ok',
    data: {
      id: vote.id,
      title: vote.title,
      author_id: vote.authorId,
      author_name: vote.authorName,
      is_creator: vote.isCreator,
      is_locked: vote.isLocked,
      created_at: vote.createdAt ? vote.createdAt.toISOString() : null,
      total_votes: vote.totalVotes,
      user_voted: vote.userVoted,
      options: vote.options.map((o) => ({
        id: o.id,
        label: o.label,
        count: o.count,
        percentage: o.percentage,
      })),
    },
  });
}
