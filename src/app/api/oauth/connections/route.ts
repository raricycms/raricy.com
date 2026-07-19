import { getCurrentUser } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { listUserConnections } from '@/lib/oauth';

// GET /api/oauth/connections
// 当前用户已绑定的应用列表（仅未过期、未吊销、未禁用应用）。
// 用于 settings 页「已绑定的应用」section。

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');

  const conns = await listUserConnections(user.id);
  return apiOk({
    connections: conns.map((c) => ({
      tokenId: c.tokenId,
      applicationId: c.applicationId,
      applicationName: c.applicationName,
      applicationHomepageUrl: c.applicationHomepageUrl,
      scopes: c.scopes,
      createdAt: c.createdAt.toISOString(),
      expiresAt: c.expiresAt.toISOString(),
    })),
  });
}