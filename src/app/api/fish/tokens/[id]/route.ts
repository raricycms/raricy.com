// DELETE /api/fish/tokens/[id] — 吊销自己的一张只读凭据
//
// 用 DELETE 而不是 POST /revoke：语义就是「让这张凭据失效」，没有别的副作用。
// **幂等** —— 已吊销的再吊销仍然 200（见 fish-token-service.revokeFishToken）。
//
// 刻意**不要** step-up：吊销是**安全方向**的动作（fail-safe），给它加摩擦等于
// 在用户发现凭据泄露、最想立刻止损的那一刻多拦他一道。签发给摩擦，吊销不给。
//
// id 是自增整数（不是 tokenHash）—— 见 prisma/migrations/15_fish_api_tokens 头部。

import { getCurrentUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';
import { revokeFishToken } from '@/lib/fish-token-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  // 非整数 id 直接 404：别让它落到 Prisma 上变成 500
  if (!Number.isInteger(id) || id <= 0) return apiErr(404, '凭据不存在');

  const res = await revokeFishToken(user.id, id);
  if (res === 'not_found') return apiErr(404, '凭据不存在');
  if (res === 'forbidden') return apiErr(403, '不能吊销别人的凭据');

  return apiOk({ message: '凭据已吊销，立即失效' });
}
