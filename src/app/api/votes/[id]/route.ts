import { getVoteDetail, setVoteLocked, softDeleteVote } from '@/lib/vote-service';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// GET /api/votes/:id — 投票详情（选项计数 + 当前用户已投项）
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  // 需核心用户。
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

// PATCH /api/votes/:id — 锁定 / 解锁（创建者本人；需 core+ 登录）
//
// 这一条与下面的 DELETE 是把 `/vote/[id]` 页面上的 server action 收编进来的结果：
// 那三个动作此前**只有浏览器那一条路**（RSC 协议、action id 随构建变），
// 站外机器人建得了投票却锁不了、删不掉。口径与 `POST /api/votes` 一致 ——
// 同样 core+、同样**不判禁言**（锁自己的投票不是发言）。
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { locked?: unknown } | null;
  // 只认真布尔：`"true"` / `1` 一律 400。静默按 truthy 解释会让
  // 「locked=0」这类调用把投票锁上（PATCH 是幂等覆盖，写错就是不报错的错账）。
  if (!body || typeof body.locked !== 'boolean') {
    return apiErr(400, 'locked 必须是 true 或 false');
  }

  const res = await setVoteLocked(id, user.id, body.locked);
  if ('error' in res) return apiErr(res.status, res.error);

  return apiOk({ id, is_locked: res.isLocked }, res.isLocked ? '已锁定' : '已解锁');
}

// DELETE /api/votes/:id — 软删除（创建者本人；需 core+ 登录）
//
// 软删：`ignore = true`，已投的票留在库里。删过的再删 → 404（与「不存在」同形）。
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const { id } = await ctx.params;
  const res = await softDeleteVote(id, user.id);
  if ('error' in res) return apiErr(res.status, res.error);

  return apiOk({ id, redirect: '/vote' }, '投票已删除');
}
