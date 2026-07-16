import { listItems, placeItem } from '@/lib/photowall-service';
import { getCurrentUser, isCurrentlyBanned } from '@/lib/auth';
import { apiOk, apiErr } from '@/lib/format';

// GET /api/photowall — 列出全部未软删的照片墙条目（公开，含图片回源 url）
export async function GET() {
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
