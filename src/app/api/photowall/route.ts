import { listItems, placeItem } from '@/lib/photowall-service';
import { getCurrentUser, isCurrentlyBanned, isCoreUser } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// GET /api/photowall — 列出全部未软删的照片墙条目（需核心用户，含图片回源 url）
//
// 此前标着「公开」且真的没判权 —— 但 Flask 的 /photowall/api/items 是
// @authenticated_required。照片墙是社区共创内容，未认证用户不该能 curl 走整面墙
// （含每张图的作者与回源 url）。页面 /photowall 本来就挡了 core，只有接口漏了。
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');

  const items = await listItems();
  return apiOk({
    items: items.map((it) => ({
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
    })),
  });
}

// POST /api/photowall — 贴一张图片到墙上（需登录；禁言禁止；每人上限 30）
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return apiErr(401, '请先登录');
  // 对齐 Flask @authenticated_required：需核心用户（core 及以上）。
  // 页面挡了 core，但接口没挡 —— 未认证用户用不了界面，却 curl 得动。
  if (!isCoreUser(user)) return apiErr(403, '需要核心用户权限');
  if (isCurrentlyBanned(user)) return apiErr(403, '你已被禁言，无法操作照片墙');

  const body = (await req.json().catch(() => null)) as {
    image_id?: unknown;
    imageId?: unknown;
    x?: unknown;
    y?: unknown;
    rotation?: unknown;
    scale?: unknown;
    z_index?: unknown;
    zIndex?: unknown;
  } | null;
  if (!body) return apiErr(400, '请求数据无效');

  const rawImageId = body.image_id ?? body.imageId;
  const imageId = typeof rawImageId === 'string' ? rawImageId : '';
  if (!imageId.trim()) return apiErr(400, '请选择一张图片');

  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const res = await placeItem(user.id, {
    imageId,
    x: num(body.x),
    y: num(body.y),
    rotation: num(body.rotation),
    scale: num(body.scale),
    zIndex: num(body.z_index ?? body.zIndex),
  });

  if ('rateLimited' in res) return apiErr(429, '贴照片太频繁，请稍后再试');
  if ('error' in res) return apiErr(400, res.error);

  const it = res.item;
  return apiOk(
    {
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
    },
    '已贴到墙上'
  );
}
