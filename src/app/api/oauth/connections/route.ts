import { getCurrentUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { listUserConnections } from '@/lib/oauth';

// GET /api/oauth/connections
// 当前用户已绑定的应用列表（仅未过期、未吊销、未禁用应用）。
// 用于 settings 页「已绑定的应用」section。
//
// 【一应用一行，不是一 token 一行】外部应用每次重新授权都会新签一条 token，
// 按 token 展开会让同一个网站重复出现 N 次。聚合口径见 lib/oauth.ts
// aggregateConnections()；`tokenCount` 即该应用名下的存活 token 条数。

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const conns = await listUserConnections(user.id);
  return apiOk({
    connections: conns.map((c) => ({
      applicationId: c.applicationId,
      applicationName: c.applicationName,
      applicationHomepageUrl: c.applicationHomepageUrl,
      scopes: c.scopes,
      tokenCount: c.tokenCount,
      firstAuthorizedAt: c.firstAuthorizedAt.toISOString(),
      lastAuthorizedAt: c.lastAuthorizedAt.toISOString(),
      expiresAt: c.expiresAt.toISOString(),
      lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
    })),
  });
}