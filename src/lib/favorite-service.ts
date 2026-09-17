// ─────────────────────────────────────────────────────────────────────────────
// favorite-service.ts — 收藏夹业务逻辑
//
// 与 blog-service / clipboard-service 风格一致：纯函数 + 显式参数。
// 软删除：`deleted` / `deletedAt`（对齐 BlogLike），**永不物理删**。
// 限频复用共享内存限频器（RULES.favoriteCreateHourly / favoriteImportHourly，
// 条目的增删则复用 likeHourly / likeDaily 的数值、另起键前缀）。
//
// ═══════════════════════════════════════════════════════════════════════════
// 六条不变量 —— 本文件的正确性核心，改动前先读完
// ═══════════════════════════════════════════════════════════════════════════
//
// 【1】publicId 非空 ⟺ isPublic 为真。
//   只有 createFavorite / copyFavorite 两条写路径能造出收藏夹，两处都只在公开时
//   生成 publicId，且复制时显式重建（公开→私密必须置 NULL，私密→公开必须新生成）。
//   ⚠️ 反向不成立：判「对外可见」**永远用 isPublic，绝不用 publicId != null** ——
//   只判句柄非空会给「isPublic=0 但 publicId 还在」的活口放行。
//
// 【2】一切对外读取都必须过 PUBLIC_FAVORITE_WHERE（isPublic + deleted）。
//   用同一个常量，避免某条路由漏写一半。
//
// 【3】所有权守卫照 clipboard-service.getClip 的口径：**调用方必须显式传 viewerId，
//   不给默认放行的参数** —— 默认放行的参数一旦漏传就是越权。
//
// 【4】不继承站长的越权读。getClip 让 owner 角色能读别人的私密剪贴板；收藏夹
//   **刻意不设这个后门** —— 私密收藏夹只有创建者本人能读到，没有例外。
//
// 【5】「私密」与「不存在」对外同为 404，不区分（不确认存在性）。
//
// 【6】复制与导入都用**显式字段白名单**构造新行，绝不 `{...source}` 展开
//   （展开会把 id / publicId 一起搬过去，轻则撞唯一约束、重则公开了私密的内容）。
//
// 另：attachItems 用 upsert 而**不是** createMany({ skipDuplicates: true }) ——
//   后者会在撞上墓碑行时静默变成 no-op 却返回成功，于是「移出后再加入」和
//   「复制一个我移除过条目的收藏夹」都变成「点了没反应」。唯一约束
//   (favorite_id, blog_id) 是物理的、包含墓碑行，所以复活必须翻转 deleted。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { rateLimit, RULES } from './rate-limit';
import { FAVORITE_ID_LEN, isFavoriteId } from './favorite-refs';

/**
 * 每个用户可创建的收藏夹总数上限。
 *
 * ⚠️ **刻意与剪贴板的先例相反**：CLIP_PER_USER_MAX 的注释写明「按 authorId 统计总数
 * （**含软删除**）」。那套口径照搬过来会是这样：用户加满 200 条又全删掉，UI 显示
 * 「一个收藏夹都没有」，却再也建不出新的 —— 而且是静默的、没有任何提示。
 * 这里只数未删除的：删除能回收配额，符合直觉。
 */
export const FAVORITE_PER_USER_MAX = 200;

/** 单个收藏夹的条目上限。导入与逐个加入共用这一个数。 */
export const FAVORITE_ITEMS_MAX = 1000;

/** 收藏夹标题上限（与 vote / clipboard 的标题口径一致）。 */
export const FAVORITE_TITLE_MAX = 60;

/** 公开收藏夹的查询条件 —— 对外读取只允许用这个（不变量 2）。 */
export const PUBLIC_FAVORITE_WHERE = { isPublic: true, deleted: false } as const;

export type FavoriteFailReason =
  | 'notfound' // 不存在 / 无权看 / 私密（三者对外同形，不变量 5）
  | 'rateLimited'
  | 'limit' // 超出 FAVORITE_PER_USER_MAX
  | 'itemsLimit' // 超出 FAVORITE_ITEMS_MAX
  | 'badinput'
  | 'nogenerate'; // 6 位 ID 连撞 10 次（理论上近乎不可能）

export type FavoriteResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; reason: FavoriteFailReason };

// ── 6 位数字 ID ───────────────────────────────────────────────────────────────

/**
 * 生成 6 位**纯数字** ID。
 *
 * 【为什么不是 generateShortId】那个是 base36（小写字母 + 数字）。收藏夹的对外
 * 句柄要能手打（`[@123456]`）、能念出来、能写在纸上，所以收窄到数字。
 *
 * 【为什么必须拒绝采样】`byte % 10` 在 0..255 上不是均匀的（0..5 各出现 26 次、
 * 6..9 各 25 次），直接取模会让前几位数字偏多。上界取 250 = 最大的 10 的倍数。
 */
export function generateFavoriteId(): string {
  const chars: string[] = [];
  const max = Math.floor(256 / 10) * 10; // 250 —— 拒绝采样上界
  while (chars.length < FAVORITE_ID_LEN) {
    const buf = new Uint8Array(FAVORITE_ID_LEN - chars.length);
    crypto.getRandomValues(buf);
    for (const byte of buf) {
      if (byte < max) chars.push(String(byte % 10));
      if (chars.length === FAVORITE_ID_LEN) break;
    }
  }
  return chars.join('');
}

/**
 * 生成一个不撞的 6 位 ID。
 *
 * 【为什么必须查重】空间只有 10^6，比剪贴板的 36^8 小 1000 倍以上。
 * 剪贴板那条 `generateShortId(8)` 是**不查重**的（靠空间大蒙混），收藏夹不能照抄。
 * 重试 10 次，对齐 vote-service 的写法；连撞 10 次返回 null。
 */
async function generateUniquePublicId(): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    const candidate = generateFavoriteId();
    const clash = await prisma.favorite.findUnique({
      where: { publicId: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  return null;
}

// ── 标题校验 ──────────────────────────────────────────────────────────────────

/** 归一化并校验标题。返回 null 表示不合法。 */
export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw.trim();
  if (title.length === 0 || title.length > FAVORITE_TITLE_MAX) return null;
  return title;
}

// ── 配额 ─────────────────────────────────────────────────────────────────────

/** 数自己**未软删**的收藏夹（见 FAVORITE_PER_USER_MAX 处的说明）。 */
async function countOwnFavorites(userId: string): Promise<number> {
  return prisma.favorite.count({ where: { userId, deleted: false } });
}

// ── 创建 ─────────────────────────────────────────────────────────────────────

export interface FavoriteRow {
  id: string;
  publicId: string | null;
  title: string;
  isPublic: boolean;
  createdAt: Date | null;
}

/** 创建收藏夹。配额、限频、ID 生成、publicId 规则全在这一条路径上（不变量 1）。 */
export async function createFavorite(
  userId: string,
  rawTitle: unknown,
  isPublic: boolean
): Promise<FavoriteResult<{ favorite: FavoriteRow }>> {
  const gate = rateLimit(`fav:create:${userId}`, RULES.favoriteCreateHourly);
  if (!gate.allowed) return { ok: false, reason: 'rateLimited' };

  const title = normalizeTitle(rawTitle);
  if (!title) return { ok: false, reason: 'badinput' };

  if ((await countOwnFavorites(userId)) >= FAVORITE_PER_USER_MAX) {
    return { ok: false, reason: 'limit' };
  }

  // publicId 只在公开时生成 —— 私密收藏夹**没有**对外句柄（不变量 1）
  let publicId: string | null = null;
  if (isPublic) {
    publicId = await generateUniquePublicId();
    if (!publicId) return { ok: false, reason: 'nogenerate' };
  }

  const favorite = await prisma.favorite.create({
    data: {
      id: crypto.randomUUID(),
      publicId,
      userId,
      title,
      isPublic,
      createdAt: nowForDb(),
    },
    select: { id: true, publicId: true, title: true, isPublic: true, createdAt: true },
  });
  return { ok: true, favorite };
}

// ── 读取：自己的 ───────────────────────────────────────────────────────────────

export interface FavoriteListItem extends FavoriteRow {
  itemCount: number;
  /** 只在传了 blogId 时给出：这个收藏夹是否含该博客（选择器一次请求拿全）。 */
  contains?: boolean;
}

/**
 * 列出某用户自己的收藏夹（含私密）。
 *
 * `blogId` 传入时额外给出 `contains` —— 博客详情页的收藏选择器要「列表 + 我的归属」
 * 一次拿全，而不是先列列表再逐个问。
 */
export async function listOwnFavorites(
  userId: string,
  blogId?: string
): Promise<FavoriteListItem[]> {
  const rows = await prisma.favorite.findMany({
    where: { userId, deleted: false },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      publicId: true,
      title: true,
      isPublic: true,
      createdAt: true,
      _count: { select: { items: { where: { deleted: false } } } },
      // 只在需要时带上归属判断，避免无谓的 join
      items: blogId
        ? { where: { blogId, deleted: false }, select: { id: true }, take: 1 }
        : false,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    publicId: r.publicId,
    title: r.title,
    isPublic: r.isPublic,
    createdAt: r.createdAt,
    itemCount: r._count.items,
    ...(blogId ? { contains: Array.isArray(r.items) && r.items.length > 0 } : {}),
  }));
}

/** 该用户是否有**任一**收藏夹含这篇博客 —— 博客详情页星标按钮的初始态。 */
export async function isBlogFavorited(userId: string, blogId: string): Promise<boolean> {
  const hit = await prisma.favoriteItem.findFirst({
    where: { blogId, deleted: false, favorite: { userId, deleted: false } },
    select: { id: true },
  });
  return !!hit;
}

// ── 读取：所有者视图 / 公开视图 ────────────────────────────────────────────────

export interface FavoriteItemView {
  blogId: string;
  title: string;
}

export interface FavoriteDetail {
  id: string;
  publicId: string | null;
  title: string;
  isPublic: boolean;
  createdAt: Date | null;
  /** 收藏夹创建者的用户名（公开视图要显示「谁的收藏夹」）。 */
  authorName: string;
  items: FavoriteItemView[];
}

/** 取条目（跳过软删的条目与软删的博客 —— 软删即从列表消失）。 */
async function loadItems(favoriteId: string): Promise<FavoriteItemView[]> {
  const rows = await prisma.favoriteItem.findMany({
    where: { favoriteId, deleted: false, blog: { ignore: false } },
    orderBy: { createdAt: 'desc' },
    select: { blogId: true, blog: { select: { title: true } } },
  });
  return rows.map((r) => ({ blogId: r.blogId, title: r.blog.title }));
}

/**
 * 所有者视图：**只有创建者本人**能拿到（不变量 4 —— 站长也没有例外）。
 * 私密收藏夹只有这条路径能读，所以这里的 userId 判定是全部的防线。
 */
export async function getOwnFavorite(
  id: string,
  userId: string
): Promise<FavoriteResult<{ favorite: FavoriteDetail }>> {
  const row = await prisma.favorite.findFirst({
    where: { id, userId, deleted: false },
    select: {
      id: true,
      publicId: true,
      title: true,
      isPublic: true,
      createdAt: true,
      user: { select: { username: true } },
    },
  });
  if (!row) return { ok: false, reason: 'notfound' };
  return {
    ok: true,
    favorite: {
      id: row.id,
      publicId: row.publicId,
      title: row.title,
      isPublic: row.isPublic,
      createdAt: row.createdAt,
      authorName: row.user.username,
      items: await loadItems(row.id),
    },
  };
}

/**
 * 公开视图（按 6 位句柄）。**免认证**，所以这是全功能里唯一无会话的读路径，
 * 必须严格过 PUBLIC_FAVORITE_WHERE（不变量 2）—— 少一个条件就是私密收藏夹裸奔。
 */
export async function getPublicFavorite(
  publicId: string
): Promise<FavoriteResult<{ favorite: FavoriteDetail }>> {
  // 形态先挡一道：非 6 位数字直接 notfound，不去查库
  if (!isFavoriteId(publicId)) return { ok: false, reason: 'notfound' };
  const row = await prisma.favorite.findFirst({
    where: { publicId, ...PUBLIC_FAVORITE_WHERE },
    select: {
      id: true,
      publicId: true,
      title: true,
      isPublic: true,
      createdAt: true,
      user: { select: { username: true } },
    },
  });
  if (!row) return { ok: false, reason: 'notfound' };
  return {
    ok: true,
    favorite: {
      id: row.id,
      publicId: row.publicId,
      title: row.title,
      isPublic: row.isPublic,
      createdAt: row.createdAt,
      authorName: row.user.username,
      items: await loadItems(row.id),
    },
  };
}

// ── 改名 / 软删 ───────────────────────────────────────────────────────────────

/**
 * 改名。
 *
 * ⚠️ **只接受标题**。没有任何接口能改 isPublic —— 性质创建时定、此后不可变
 * （要改只能靠复制）。若哪天有人照着 clipboard 的 PUT（它接受 publicity）给这里
 * 也加一个字段，就会造出「is_public=1 但 public_id 为 NULL」的死状态，
 * 或「is_public=0 但 public_id 还在」的活口，两种都会撕开不变量 1。
 */
export async function renameFavorite(
  id: string,
  userId: string,
  rawTitle: unknown
): Promise<FavoriteResult<{ favorite: FavoriteRow }>> {
  const title = normalizeTitle(rawTitle);
  if (!title) return { ok: false, reason: 'badinput' };

  const existing = await prisma.favorite.findFirst({
    where: { id, userId, deleted: false },
    select: { id: true },
  });
  if (!existing) return { ok: false, reason: 'notfound' };

  const favorite = await prisma.favorite.update({
    where: { id },
    data: { title },
    select: { id: true, publicId: true, title: true, isPublic: true, createdAt: true },
  });
  return { ok: true, favorite };
}

/** 软删收藏夹（条目行不动 —— 永不物理删）。 */
export async function softDeleteFavorite(
  id: string,
  userId: string
): Promise<FavoriteResult> {
  const existing = await prisma.favorite.findFirst({
    where: { id, userId, deleted: false },
    select: { id: true },
  });
  if (!existing) return { ok: false, reason: 'notfound' };

  await prisma.favorite.update({
    where: { id },
    data: { deleted: true, deletedAt: nowForDb() },
  });
  return { ok: true };
}

// ── 条目增删 ─────────────────────────────────────────────────────────────────

/** 确认收藏夹归此人且未删 —— 所有条目写路径的第一步。 */
async function assertOwned(id: string, userId: string): Promise<boolean> {
  const row = await prisma.favorite.findFirst({
    where: { id, userId, deleted: false },
    select: { id: true },
  });
  return !!row;
}

/** 数未软删的条目。 */
async function countItems(favoriteId: string): Promise<number> {
  return prisma.favoriteItem.count({ where: { favoriteId, deleted: false } });
}

/**
 * 把一批博客挂到收藏夹上（复制 / 导入 / 单条加入共用这一份实现）。
 *
 * ★ upsert 而不是 createMany({ skipDuplicates: true }) ★
 * 唯一约束 (favorite_id, blog_id) 是**物理**的、包含墓碑行。createMany 撞上墓碑时
 * 会静默跳过并返回成功 —— 表现为「移出过的博客再也加不回来」，或「复制出来的收藏夹
 * 少了几条，但接口说成功」。upsert 才会复活旧行（不变量 8 那条注释的落地）。
 */
async function attachItems(favoriteId: string, blogIds: string[]): Promise<void> {
  if (blogIds.length === 0) return;
  const now = nowForDb();
  await prisma.$transaction(
    blogIds.map((blogId) =>
      prisma.favoriteItem.upsert({
        where: { uq_favorite_item: { favoriteId, blogId } },
        create: { favoriteId, blogId, createdAt: now },
        update: { deleted: false, deletedAt: null },
      })
    )
  );
}

/** 把一篇博客加入收藏夹。 */
export async function addItem(
  id: string,
  userId: string,
  blogId: unknown
): Promise<FavoriteResult<{ itemCount: number }>> {
  const gateH = rateLimit(`fav:item:h:${userId}`, RULES.likeHourly);
  const gateD = rateLimit(`fav:item:d:${userId}`, RULES.likeDaily);
  if (!gateH.allowed || !gateD.allowed) return { ok: false, reason: 'rateLimited' };

  if (typeof blogId !== 'string' || blogId.length === 0) {
    return { ok: false, reason: 'badinput' };
  }
  if (!(await assertOwned(id, userId))) return { ok: false, reason: 'notfound' };

  // 文章必须存在且未软删（与点赞的「先查存在再限频」同向：对被删的文章不该新增引用）
  const blog = await prisma.blog.findFirst({
    where: { id: blogId, ignore: false },
    select: { id: true },
  });
  if (!blog) return { ok: false, reason: 'badinput' };

  // 已在夹里就是幂等成功（不占配额、不报错）—— 选择器里反复勾选不该被 1000 卡住
  const already = await prisma.favoriteItem.findFirst({
    where: { favoriteId: id, blogId, deleted: false },
    select: { id: true },
  });
  if (already) return { ok: true, itemCount: await countItems(id) };

  if ((await countItems(id)) >= FAVORITE_ITEMS_MAX) {
    return { ok: false, reason: 'itemsLimit' };
  }

  await attachItems(id, [blogId]);
  return { ok: true, itemCount: await countItems(id) };
}

/** 把一篇博客移出收藏夹（软删条目）。 */
export async function removeItem(
  id: string,
  userId: string,
  blogId: string
): Promise<FavoriteResult<{ itemCount: number }>> {
  const gateH = rateLimit(`fav:item:h:${userId}`, RULES.likeHourly);
  const gateD = rateLimit(`fav:item:d:${userId}`, RULES.likeDaily);
  if (!gateH.allowed || !gateD.allowed) return { ok: false, reason: 'rateLimited' };

  if (!(await assertOwned(id, userId))) return { ok: false, reason: 'notfound' };

  await prisma.favoriteItem.updateMany({
    where: { favoriteId: id, blogId, deleted: false },
    data: { deleted: true, deletedAt: nowForDb() },
  });
  return { ok: true, itemCount: await countItems(id) };
}

// ── 复制（快照）──────────────────────────────────────────────────────────────

/**
 * 把 `id` 解析成「可复制的源」。
 *
 * 两种 id 形态由调用方给，**互不相交**（UUID 含连字符且 36 字符；公开句柄恰好 6 位
 * 数字），所以这里的分支是结构性正确的，而不是靠一条 if 记得写全：
 *   · 6 位公开句柄 → 只能命中**公开**收藏夹，于是「用句柄读到私密」不可能发生；
 *   · UUID → **只在自己名下**找，于是「拿别人的 UUID 复制他的私密收藏夹」不可能发生。
 *
 * 这是全功能唯一允许非所有者进来的写路径（从分享页复制别人的公开合辑），
 * 所以判定逻辑单独放一个函数、单独注释，不要内联进路由。
 */
async function resolveCopySource(id: string, viewerId: string) {
  const select = { id: true, title: true, userId: true, isPublic: true } as const;
  if (isFavoriteId(id)) {
    return prisma.favorite.findFirst({
      where: { publicId: id, ...PUBLIC_FAVORITE_WHERE },
      select,
    });
  }
  return prisma.favorite.findFirst({
    where: { id, userId: viewerId, deleted: false },
    select,
  });
}

/**
 * 复制一个收藏夹（**快照**：复制那一刻的标题与条目，之后两边各走各的）。
 *
 * UI 必须把「快照」这件事说出来 —— 用户很容易以为是活链接。
 */
export async function copyFavorite(
  id: string,
  viewerId: string,
  isPublic: boolean
): Promise<FavoriteResult<{ favorite: FavoriteRow; itemCount: number }>> {
  const gate = rateLimit(`fav:create:${viewerId}`, RULES.favoriteCreateHourly);
  if (!gate.allowed) return { ok: false, reason: 'rateLimited' };

  const source = await resolveCopySource(id, viewerId);
  if (!source) return { ok: false, reason: 'notfound' };

  if ((await countOwnFavorites(viewerId)) >= FAVORITE_PER_USER_MAX) {
    return { ok: false, reason: 'limit' };
  }

  let publicId: string | null = null;
  if (isPublic) {
    publicId = await generateUniquePublicId();
    if (!publicId) return { ok: false, reason: 'nogenerate' };
  }

  const blogIds = (
    await prisma.favoriteItem.findMany({
      where: { favoriteId: source.id, deleted: false, blog: { ignore: false } },
      select: { blogId: true },
    })
  ).map((r) => r.blogId);

  // 显式字段白名单（不变量 6）：新行只从源取标题，id / userId / publicId 全部重建
  const favorite = await prisma.favorite.create({
    data: {
      id: crypto.randomUUID(),
      publicId,
      userId: viewerId,
      title: source.title,
      isPublic,
      createdAt: nowForDb(),
    },
    select: { id: true, publicId: true, title: true, isPublic: true, createdAt: true },
  });
  await attachItems(favorite.id, blogIds);
  return { ok: true, favorite, itemCount: blogIds.length };
}

// ── 导出 / 导入 ───────────────────────────────────────────────────────────────

export interface FavoriteExport {
  version: 1;
  title: string;
  blogs: { id: string; title: string }[];
}

/**
 * 导出用的数据（**所有者限定**）。
 *
 * 内容只有标题 + 博客列表 —— **不含收藏夹 id、不含是否公开**。私密收藏夹也能导出，
 * 且导出物里没有任何能反推出它身份的字段（这正是「私密可导出 JSON」与「私密不泄 id」
 * 能同时成立的原因）。站点域名不在这里拼，交给路由层（服务层不碰 site-url）。
 */
export async function exportFavorite(
  id: string,
  userId: string
): Promise<FavoriteResult<{ data: FavoriteExport }>> {
  const own = await getOwnFavorite(id, userId);
  if (!own.ok) return { ok: false, reason: own.reason };
  return {
    ok: true,
    data: {
      version: 1,
      title: own.favorite.title,
      blogs: own.favorite.items.map((i) => ({ id: i.blogId, title: i.title })),
    },
  };
}

/** 从导出物里取博客 id：优先 `id` 字段，兼容手写的、只给了 url 的文件。 */
function pickBlogId(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null;
  const obj = entry as Record<string, unknown>;
  if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  if (typeof obj.url === 'string') {
    // 末尾一段就是博客 UUID（/blog/<uuid>）
    const seg = obj.url.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
    if (seg && seg.length > 0) return seg;
  }
  return null;
}

/**
 * 从导出物导入成一个**新**收藏夹。
 *
 * 三处刻意：
 *   · **总是新建**（性质创建时定，所以导入时由调用方选公私），不并入已有收藏夹；
 *   · 文件里的 `isPublic` / `publicId` / 收藏夹 `id` 一律**忽略**（不变量 6）——
 *     否则一个手改的文件就能指定新行的对外句柄或可见性；
 *   · 不存在的 / 已软删的博客跳过并计数，不因此整单失败。
 */
export async function importFavorite(
  userId: string,
  isPublic: boolean,
  payload: unknown
): Promise<FavoriteResult<{ favorite: FavoriteRow; created: number; skipped: number }>> {
  const gate = rateLimit(`fav:import:${userId}`, RULES.favoriteImportHourly);
  if (!gate.allowed) return { ok: false, reason: 'rateLimited' };

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'badinput' };
  }
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.blogs)) return { ok: false, reason: 'badinput' };

  const title = normalizeTitle(typeof raw.title === 'string' ? raw.title : '导入的收藏夹');
  if (!title) return { ok: false, reason: 'badinput' };

  // 去重后逐个取 id（去重在前，避免同一篇被数两次）
  const candidates: string[] = [];
  for (const entry of raw.blogs) {
    const id = pickBlogId(entry);
    if (id && !candidates.includes(id)) candidates.push(id);
  }

  // 一次查全部，避免 N 次往返
  const existing = new Set(
    (
      await prisma.blog.findMany({
        where: { id: { in: candidates }, ignore: false },
        select: { id: true },
      })
    ).map((b) => b.id)
  );
  const blogIds = candidates.filter((id) => existing.has(id)).slice(0, FAVORITE_ITEMS_MAX);
  const skipped = candidates.length - blogIds.length;
  if (blogIds.length === 0) return { ok: false, reason: 'badinput' };

  if ((await countOwnFavorites(userId)) >= FAVORITE_PER_USER_MAX) {
    return { ok: false, reason: 'limit' };
  }

  let publicId: string | null = null;
  if (isPublic) {
    publicId = await generateUniquePublicId();
    if (!publicId) return { ok: false, reason: 'nogenerate' };
  }

  const favorite = await prisma.favorite.create({
    data: {
      id: crypto.randomUUID(),
      publicId,
      userId,
      title,
      isPublic,
      createdAt: nowForDb(),
    },
    select: { id: true, publicId: true, title: true, isPublic: true, createdAt: true },
  });
  await attachItems(favorite.id, blogIds);
  return { ok: true, favorite, created: blogIds.length, skipped };
}
