import { getVoteDetail } from '@/lib/vote-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiErr } from '@/lib/format';

// GET /api/votes/:id — 投票详情（选项计数 + 当前用户已投项）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  // 对齐 Flask /vote/<id> 的 @authenticated_required：需核心用户。
  // 此前这个 GET 完全没判权 —— 任何人 curl 就能拿到投票结果。唯二的调用方
  // （投票页、博客里的投票嵌入）都在 core 门槛之后，加这道不影响任何合法场景。
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const vote = await getVoteDetail(id, user.id);
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
