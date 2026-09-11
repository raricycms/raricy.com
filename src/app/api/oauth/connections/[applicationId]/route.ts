import { getCurrentUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { revokeUserApplicationTokens } from '@/lib/oauth';

// DELETE /api/oauth/connections/[applicationId]
// 解除当前用户与某个应用的**整个**绑定：撤销该用户名下该应用的全部存活 token。
//
// 【为什么按应用而不是按 token】设置页聚合展示（一应用一行），按钮文案是
// 「解除与 X 的绑定」。若只吊销一条 token，重复授权过 N 次的用户点完之后
// 应用手里还剩 N-1 条有效凭证 —— 静默越权。见 lib/oauth.ts 的说明。
//
// 不存在的绑定 → 404；重复点击（已全部撤销）→ 200 且 revokedCount=0（幂等）。

/** applicationId 由 generateShortId(12) 生成（[a-z0-9]），这里只做粗校验挡住垃圾查询。 */
const APPLICATION_ID_RE = /^[a-z0-9]{1,64}$/;

export async function DELETE(_req: Request, ctx: { params: Promise<{ applicationId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { applicationId } = await ctx.params;
  if (!applicationId || !APPLICATION_ID_RE.test(applicationId)) {
    return apiErr(400, 'applicationId 不合法');
  }

  const res = await revokeUserApplicationTokens(user.id, applicationId);
  if (!res.found) return apiErr(404, '绑定不存在');

  return apiOk({ revoked: true, revokedCount: res.revoked });
}
