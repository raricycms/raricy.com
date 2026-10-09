import { getCurrentUser, isOwner } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { apiErr, apiOk } from '@/lib/format';
import { updateOAuthApplication, disableOAuthApplication } from '@/lib/oauth';

// PATCH  /api/admin/oauth/applications/[id]  owner-only（按 id 或 clientId）
// DELETE /api/admin/oauth/applications/[id]  owner-only → 软禁用

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isOwner(user)) return apiErr(403, '仅站长可访问');

  const { id: idOrCid } = await ctx.params;
  const app = await prisma.oAuthApplication.findFirst({
    where: { OR: [{ id: idOrCid }, { clientId: idOrCid }] },
  });
  if (!app) return apiErr(404, '应用不存在');

  let body: Partial<{
    name: string;
    description: string;
    homepageUrl: string;
    redirectUris: string[];
    disabled: boolean;
  }>;
  try {
    body = await req.json();
  } catch {
    return apiErr(400, '请求体格式错误');
  }

  try {
    const updated = await updateOAuthApplication(app.id, {
      name: body.name,
      description: body.description,
      homepageUrl: body.homepageUrl,
      redirectUris: body.redirectUris?.map(String),
      disabled: body.disabled,
    });
    return apiOk({
      application: {
        id: updated.id,
        clientId: updated.clientId,
        name: updated.name,
        description: updated.description,
        homepageUrl: updated.homepageUrl,
        redirectUris: safeParse(updated.redirectUris),
        disabledAt: updated.disabledAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    return apiErr(400, e instanceof Error ? e.message : '更新失败');
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isOwner(user)) return apiErr(403, '仅站长可访问');

  const { id: idOrCid } = await ctx.params;
  const app = await prisma.oAuthApplication.findFirst({
    where: { OR: [{ id: idOrCid }, { clientId: idOrCid }] },
  });
  if (!app) return apiErr(404, '应用不存在');

  const updated = await disableOAuthApplication(app.id);
  return apiOk({ application: { id: updated.id, name: updated.name, disabledAt: updated.disabledAt } });
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
