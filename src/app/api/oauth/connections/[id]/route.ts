import { getCurrentUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { revokeOwnTokenByHash } from '@/lib/oauth';

// DELETE /api/oauth/connections/[id]
// id 是 tokenHash（来自 GET /api/oauth/connections）。
// 仅自己的 token 可解除；非自己的 → 403，不存在 → 404。

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id } = await ctx.params;
  if (!id || id.length !== 64) return apiErr(400, 'token id 不合法');

  // 先查再删以区分 403 / 404
  const ok = await revokeOwnTokenByHash(id, user.id);
  if (!ok) return apiErr(404, '绑定不存在或不属于你');
  return apiOk({ revoked: true });
}