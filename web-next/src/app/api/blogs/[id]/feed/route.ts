import { getCurrentUser, isCurrentlyBanned, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { feedBlog } from '@/lib/feed-service';
import { AccountServiceError } from '@/lib/account-client';

// fernet / node:crypto 需 Node 运行时（非 Edge）。
export const runtime = 'nodejs';

// POST /api/blogs/:id/feed { amount } — 投喂小鱼干（需登录、非禁言）。
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 对齐 Flask @authenticated_required：需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，暂时无法投喂');

  const { id } = await ctx.params;

  let amount: number;
  try {
    const body = await req.json();
    amount = Number(body?.amount);
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  try {
    const res = await feedBlog(id, user.id, amount);
    if (!res.ok) return apiErr(res.code, res.message);

    return apiOk({
      message: '投喂成功！',
      fed_total: res.fedTotal,
      remaining: res.remaining,
      fish_count: res.fishCount,
      balance: res.balance,
      author_income: res.authorIncome,
    });
  } catch (e) {
    if (e instanceof AccountServiceError) {
      // fail-closed：远端账户服务不可用 → 503，本地已回滚，未扣鱼干。
      return apiErr(503, '账户服务暂不可用，投喂失败，请稍后再试');
    }
    console.error('[api/blogs/:id/feed] 未预期错误:', e);
    return apiErr(500, '服务器错误');
  }
}
