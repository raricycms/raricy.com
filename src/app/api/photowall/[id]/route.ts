import { updateItem } from '@/lib/photowall-service';
import { getCurrentUser, hasAdminRights, isCurrentlyBanned, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// PATCH /api/photowall/:id — 更新位置/旋转/缩放/层级（需登录，属主或管理员，禁言禁止）
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 对齐 Flask @authenticated_required：需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，无法操作照片墙');

  const { id } = await ctx.params;

  const body = (await req.json().catch(() => null)) as {
    x?: unknown;
    y?: unknown;
    rotation?: unknown;
    scale?: unknown;
    z_index?: unknown;
    zIndex?: unknown;
  } | null;
  if (!body) return apiErr(400, '请求数据无效');

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const res = await updateItem(
    id,
    { id: user.id, isAdmin: hasAdminRights(user) },
    {
      x: num(body.x),
      y: num(body.y),
      rotation: num(body.rotation),
      scale: num(body.scale),
      zIndex: num(body.z_index ?? body.zIndex),
    }
  );

  if ('rateLimited' in res) return apiErr(429, '操作太频繁，请稍后再试');
  if ('notFound' in res) return apiErr(404, '照片不存在或已被移除');
  if ('forbidden' in res) return apiErr(403, '无权修改此照片');
  if ('error' in res) return apiErr(400, res.error);

  const it = res.item;
  return apiOk({
    item: {
      id: it.id,
      image_id: it.imageId,
      x: it.x,
      y: it.y,
      rotation: it.rotation,
      z_index: it.zIndex,
      scale: it.scale,
      author_id: it.authorId,
      author_name: it.authorName,
      created_at: it.createdAt ? it.createdAt.toISOString() : null,
      updated_at: it.updatedAt ? it.updatedAt.toISOString() : null,
      url: it.url,
    },
  });
}
