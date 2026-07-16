// ─────────────────────────────────────────────────────────────────────────────
// photowall-service.ts — 照片墙业务逻辑（对齐 Flask app/web/photowall/service.py）
//
// 与 blog/vote-service 风格一致：纯函数 + 显式参数。软删除：ignore = true 排除。
// 限频复用共享内存限频器 rateLimit()，但配额是照片墙特有（贴 30/时、改 300/时），
// 不写进 rate-limit.ts 的 RULES（那是共享文件），在此本地声明。
//
// ⚠️ 图片 URL：Flask 的图片字节由 `/image/i/<id>` 提供（见 image_hosting 蓝图
//    serve_image 与 get_all_items 里 `/image/i/{image_id}`），经 next.config 的
//    `/image/:path*` rewrite 回源。故这里用 `/image/i/{imageId}`。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { rateLimit, type RateRule } from './rate-limit';

// 与 Flask 常量对齐
const WALL_WIDTH = 4000;
const WALL_HEIGHT = 3000;
const MAX_ITEMS_PER_USER = 30;
const SCALE_MIN = 0.25;
const SCALE_MAX = 5.0;

// 照片墙特有限频（对齐 Flask _PLACE_RATE_MAX / _UPDATE_RATE_MAX，窗口 1 小时）
const PLACE_RULE: RateRule = { limit: 30, windowMs: 60 * 60 * 1000 };
const UPDATE_RULE: RateRule = { limit: 300, windowMs: 60 * 60 * 1000 };

/** 图片字节：走 Next 原生分发 /api/images/<id>/raw（不再依赖 Flask）。 */
export function imageUrl(imageId: string): string {
  return `/api/images/${imageId}/raw`;
}

function clampCoords(x: number, y: number): [number, number] {
  return [
    Math.max(-200, Math.min(WALL_WIDTH + 200, x)),
    Math.max(-200, Math.min(WALL_HEIGHT + 200, y)),
  ];
}

function clampScale(s: number): number {
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, s));
}

export interface WallItem {
  id: string;
  imageId: string;
  x: number;
  y: number;
  rotation: number;
  zIndex: number;
  scale: number;
  authorId: string;
  authorName: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  url: string; // '' 表示图片已删除/丢失
}

function serialize(item: {
  id: string;
  imageId: string;
  x: number;
  y: number;
  rotation: number;
  zIndex: number;
  scale: number;
  authorId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  author?: { username: string } | null;
  image?: { ignore: boolean | null } | null;
}): WallItem {
  const imageOk = !!item.image && !item.image.ignore;
  return {
    id: item.id,
    imageId: item.imageId,
    x: item.x,
    y: item.y,
    rotation: item.rotation,
    zIndex: item.zIndex,
    scale: item.scale,
    authorId: item.authorId,
    authorName: item.author?.username ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    url: imageOk ? imageUrl(item.imageId) : '',
  };
}

/** 列出全部未软删的照片墙条目（z_index 升序、createdAt 升序），对齐 get_all_items。 */
export async function listItems(): Promise<WallItem[]> {
  const items = await prisma.photoWallItem.findMany({
    where: { ignore: false },
    orderBy: [{ zIndex: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      imageId: true,
      x: true,
      y: true,
      rotation: true,
      zIndex: true,
      scale: true,
      authorId: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { username: true } },
      image: { select: { ignore: true } },
    },
  });
  return items.map(serialize);
}

export type PlaceResult =
  | { rateLimited: true }
  | { error: string }
  | { item: WallItem };

/**
 * 把一张图片贴到墙上（对齐 place_image）：
 * 每人上限 30 张；图片须存在且未删除；同一图片不可重复上墙；
 * 坐标/缩放/旋转做边界处理；z_index 取当前最大 +1（除非显式传入）。
 */
export async function placeItem(
  authorId: string,
  input: {
    imageId: string;
    x?: number;
    y?: number;
    rotation?: number;
    scale?: number;
    zIndex?: number;
  }
): Promise<PlaceResult> {
  if (!rateLimit(`pw:place:${authorId}`, PLACE_RULE).allowed) {
    return { rateLimited: true };
  }

  const imageId = input.imageId.trim();
  if (!imageId) return { error: '请选择一张图片' };

  const count = await prisma.photoWallItem.count({
    where: { authorId, ignore: false },
  });
  if (count >= MAX_ITEMS_PER_USER) {
    return { error: `你最多只能贴 ${MAX_ITEMS_PER_USER} 张照片，请先摘除一些` };
  }

  const image = await prisma.imageHosting.findUnique({
    where: { id: imageId },
    select: { id: true, ignore: true },
  });
  if (!image || image.ignore) return { error: '图片不存在或已被删除' };

  const existing = await prisma.photoWallItem.findFirst({
    where: { imageId, ignore: false },
    select: { id: true },
  });
  if (existing) return { error: '这张图片已经在墙上了' };

  const [x, y] = clampCoords(input.x ?? 2000, input.y ?? 1500);
  const scale = clampScale(input.scale ?? 1.0);
  const rotation = ((input.rotation ?? 0) % 360 + 360) % 360;

  let zIndex = input.zIndex;
  if (zIndex == null) {
    const agg = await prisma.photoWallItem.aggregate({
      where: { ignore: false },
      _max: { zIndex: true },
    });
    zIndex = (agg._max.zIndex ?? 0) + 1;
  }

  const now = new Date();
  const created = await prisma.photoWallItem.create({
    data: {
      id: crypto.randomUUID(),
      imageId,
      authorId,
      x,
      y,
      rotation,
      scale,
      zIndex,
      ignore: false,
      createdAt: now,
      updatedAt: now,
    },
    select: {
      id: true,
      imageId: true,
      x: true,
      y: true,
      rotation: true,
      zIndex: true,
      scale: true,
      authorId: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { username: true } },
      image: { select: { ignore: true } },
    },
  });
  return { item: serialize(created) };
}

export type UpdateResult =
  | { rateLimited: true }
  | { notFound: true }
  | { forbidden: true }
  | { error: string }
  | { item: WallItem };

/**
 * 更新一个条目的位置/旋转/缩放/层级（对齐 update_item，但权限收紧为“属主或管理员”）。
 * 只接受 x/y/rotation/scale/zIndex；坐标与缩放做边界处理。
 */
export async function updateItem(
  itemId: string,
  actor: { id: string; isAdmin: boolean },
  patch: {
    x?: number;
    y?: number;
    rotation?: number;
    scale?: number;
    zIndex?: number;
  }
): Promise<UpdateResult> {
  if (!rateLimit(`pw:update:${actor.id}`, UPDATE_RULE).allowed) {
    return { rateLimited: true };
  }

  const item = await prisma.photoWallItem.findUnique({
    where: { id: itemId },
    select: { id: true, authorId: true, ignore: true, x: true, y: true },
  });
  if (!item || item.ignore) return { notFound: true };
  if (item.authorId !== actor.id && !actor.isAdmin) return { forbidden: true };

  const data: {
    x?: number;
    y?: number;
    rotation?: number;
    scale?: number;
    zIndex?: number;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  let nextX = item.x;
  let nextY = item.y;
  if (patch.x != null) nextX = patch.x;
  if (patch.y != null) nextY = patch.y;
  [data.x, data.y] = clampCoords(nextX, nextY);

  if (patch.rotation != null) data.rotation = ((patch.rotation % 360) + 360) % 360;
  if (patch.scale != null) data.scale = clampScale(patch.scale);
  if (patch.zIndex != null) data.zIndex = Math.trunc(patch.zIndex);

  const updated = await prisma.photoWallItem.update({
    where: { id: itemId },
    data,
    select: {
      id: true,
      imageId: true,
      x: true,
      y: true,
      rotation: true,
      zIndex: true,
      scale: true,
      authorId: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { username: true } },
      image: { select: { ignore: true } },
    },
  });
  return { item: serialize(updated) };
}
