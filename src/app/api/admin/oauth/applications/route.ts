import { getCurrentUser, isOwner } from '@/lib/auth';
import { apiErr, apiOk } from '@/lib/format';
import { createOAuthApplication, listOAuthApplications } from '@/lib/oauth';

// GET  /api/admin/oauth/applications — owner-only
// POST /api/admin/oauth/applications — owner-only；返回一次性 clientSecret

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isOwner(user)) return apiErr(403, '仅站长可访问');

  const apps = await listOAuthApplications();
  return apiOk({
    applications: apps.map((a) => ({
      id: a.id,
      clientId: a.clientId,
      name: a.name,
      description: a.description,
      homepageUrl: a.homepageUrl,
      redirectUris: safeParse(a.redirectUris),
      createdAt: a.createdAt?.toISOString() ?? null,
      disabledAt: a.disabledAt?.toISOString() ?? null,
    })),
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isOwner(user)) return apiErr(403, '仅站长可访问');

  let body: Partial<{
    name: string;
    description: string;
    homepageUrl: string;
    redirectUris: string[];
  }>;
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }
  if (!body.name || typeof body.name !== 'string') return apiErr(400, '缺少 name');
  if (!Array.isArray(body.redirectUris) || body.redirectUris.length === 0) {
    return apiErr(400, '至少需要一个 redirect_uri');
  }

  try {
    const created = await createOAuthApplication(
      {
        name: body.name,
        description: body.description,
        homepageUrl: body.homepageUrl,
        redirectUris: body.redirectUris.map((u) => String(u)),
      },
      user.id
    );
    return apiOk({
      application: {
        id: created.application.id,
        clientId: created.clientId,
        name: created.application.name,
        description: created.application.description,
        homepageUrl: created.application.homepageUrl,
        redirectUris: safeParse(created.application.redirectUris),
        createdAt: created.application.createdAt?.toISOString() ?? null,
      },
      clientId: created.clientId,
      clientSecret: created.clientSecret, // 仅一次
    });
  } catch (e) {
    return apiErr(400, e instanceof Error ? e.message : '创建失败');
  }
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}