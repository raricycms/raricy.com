// ─────────────────────────────────────────────────────────────────────────────
// profile-service.ts —— 个人主页「积木」的读写
//
// 【四条纪律，改之前先读】
//
// 1. **只出「本来就对外可读」的数据**。所有查询都叠 EXTERNAL_VISIBLE_BLOG_WHERE /
//    isPublic=true；这与「主页是匿名可达的名片」是同一件事的两面。不做「先查出来
//    再在渲染层挡」—— 值一旦进了内存就有忘挡的活口。
//
// 2. **存指针，读时重解析**。config 里只有 id；这里现查当前行。文章降档、被删、
//    作者归档 → 该块 view 为 null，访客视图整块不渲染。所以本文件里没有任何
//    「快照」字段被写进 config。
//
// 3. **写路径整页替换，且用「更新 + 翻墓碑」而不是「删了重插」**。id 由客户端带
//    回来，删了重插会撞主键（同一 id 正在被软删的那一行占着）。而且全站永不物理
//    删除 —— 少掉的块翻 deleted 墓碑。
//
// 4. **「保存时的归属校验」只查归属，不查档位**。档位是**读路径**的事（第 1 条）：
//    把校验写成「必须此刻对外可见」会让一个目标刚降档的人**整页都存不进去**
//    （报「有一篇文章不可见」），连删掉那一块都做不到 —— 而那块本来就会渲染成空。
//    归属必须查：不然可以把自己的块指向别人的 id，是一发越权指针。
//
// 【为什么 viewer 只用来决定「要不要给编辑清单」】对外可读的数据对游客 / core+ /
// 本人是同一份：博客有 external 档、图片音频有 isPublic。主页不再做「core+ 才看
// 内容」那套分档（那是旧档案页的口径），所以这里没有 canSeeContent。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb, isoWithOffset } from './db-time';
import { generateShortId } from './short-id';
import { EXTERNAL_VISIBLE_BLOG_WHERE } from './blog-service';
import { ymd } from './format';
import {
  isBlockKind,
  normalizeBlocks,
  type BlockCatalog,
  type BlockKind,
  type BlockView,
  type ProfileBlock,
  type StoredBlock,
} from './profile-blocks';

/** 默认布局：最近三篇对外可读的文章。用户没布置过时用它。 */
const DEFAULT_BLOG_TAKES = 3;
const CATALOG_BLOG_TAKES = 100;
const CATALOG_IMAGE_TAKES = 60;
const CATALOG_AUDIO_TAKES = 30;

export interface ProfilePageData {
  blocks: ProfileBlock[];
  /** 只有本人（且有编辑权限）才拿得到；访客拿到 null。 */
  catalog: BlockCatalog | null;
  /** true = 这个用户还没布置过，页面正在用默认布局。本人视图据此显示引导。 */
  isDefault: boolean;
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toStored(row: {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: string;
}): StoredBlock | null {
  if (!isBlockKind(row.kind)) return null;
  return {
    id: row.id,
    kind: row.kind as BlockKind,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    config: parseConfig(row.config),
  };
}

/** 默认布局的位置：两篇并排，第三篇另起一行。 */
function defaultPositions(index: number): { x: number; y: number; w: number; h: number } {
  if (index === 0) return { x: 0, y: 0, w: 2, h: 1 };
  if (index === 1) return { x: 2, y: 0, w: 2, h: 1 };
  return { x: 0, y: index - 1, w: 2, h: 1 };
}

/** 统计块与签到块共用的那一组数（也作为本人编辑器的预览值）。 */
export interface ProfileStats {
  /** 对外可读（public / link）的文章数。 */
  blogs: number;
  likes: number;
  /** **累计**签到天数（不是连续 —— DailyCheckIn 只存每天一行，没有 streak 列）。 */
  checkins: number;
}

async function computeStats(userId: string): Promise<ProfileStats> {
  const [blogs, likeAgg, checkins] = await Promise.all([
    prisma.blog.count({ where: { authorId: userId, ignore: false, ...EXTERNAL_VISIBLE_BLOG_WHERE } }),
    prisma.blog.aggregate({
      where: { authorId: userId, ignore: false, ...EXTERNAL_VISIBLE_BLOG_WHERE },
      _sum: { likesCount: true },
    }),
    prisma.dailyCheckIn.count({ where: { userId } }),
  ]);
  return { blogs, likes: likeAgg._sum.likesCount ?? 0, checkins };
}

async function resolveViews(
  userId: string,
  blocks: StoredBlock[],
  stats: ProfileStats | null
): Promise<ProfileBlock[]> {
  const blogIds = blocks.filter((b) => b.kind === 'blog').map((b) => String(b.config.blogId ?? ''));
  const imageIds = blocks.filter((b) => b.kind === 'image').map((b) => String(b.config.imageId ?? ''));
  const audioIds = blocks.filter((b) => b.kind === 'audio').map((b) => String(b.config.audioId ?? ''));

  const needStats = blocks.some((b) => b.kind === 'stats' || b.kind === 'checkin');
  const resolvedStats = needStats ? stats ?? (await computeStats(userId)) : null;

  const [blogRows, imageRows, audioRows] = await Promise.all([
    blogIds.length
      ? prisma.blog.findMany({
          where: { id: { in: blogIds }, authorId: userId, ignore: false, ...EXTERNAL_VISIBLE_BLOG_WHERE },
          select: {
            id: true,
            title: true,
            description: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    imageIds.length
      ? prisma.imageHosting.findMany({
          where: { id: { in: imageIds }, authorId: userId, ignore: false, isPublic: true },
          select: { id: true, filename: true },
        })
      : Promise.resolve([]),
    audioIds.length
      ? prisma.audioHosting.findMany({
          where: { id: { in: audioIds }, authorId: userId, ignore: false, isPublic: true },
          select: { id: true, filename: true },
        })
      : Promise.resolve([]),
  ]);

  const blogMap = new Map(blogRows.map((b) => [b.id, b]));
  const imageMap = new Map(imageRows.map((i) => [i.id, i]));
  const audioMap = new Map(audioRows.map((a) => [a.id, a]));

  return blocks.map((block) => {
    let view: BlockView | null = null;
    switch (block.kind) {
      case 'blog': {
        const row = blogMap.get(String(block.config.blogId ?? ''));
        if (row) {
          view = {
            kind: 'blog',
            blogId: row.id,
            title: row.title,
            description: row.description ?? '',
            date: ymd(row.createdAt),
          };
        }
        break;
      }
      case 'image': {
        const row = imageMap.get(String(block.config.imageId ?? ''));
        if (row) {
          view = {
            kind: 'image',
            imageId: row.id,
            url: `/api/images/${row.id}/raw`,
            alt: row.filename,
            caption: typeof block.config.caption === 'string' ? block.config.caption : '',
          };
        }
        break;
      }
      case 'audio': {
        const row = audioMap.get(String(block.config.audioId ?? ''));
        if (row) {
          view = {
            kind: 'audio',
            audioId: row.id,
            url: `/api/audio/${row.id}/raw`,
            title:
              typeof block.config.title === 'string' && block.config.title
                ? block.config.title
                : row.filename,
          };
        }
        break;
      }
      case 'text': {
        const text = typeof block.config.text === 'string' ? block.config.text : '';
        if (text) {
          view = {
            kind: 'text',
            title: typeof block.config.title === 'string' ? block.config.title : '',
            text,
          };
        }
        break;
      }
      case 'link': {
        const url = typeof block.config.url === 'string' ? block.config.url : '';
        if (url) {
          view = {
            kind: 'link',
            url,
            label: typeof block.config.label === 'string' && block.config.label ? block.config.label : url,
          };
        }
        break;
      }
      case 'stats':
        if (resolvedStats) {
          view = {
            kind: 'stats',
            blogs: resolvedStats.blogs,
            likes: resolvedStats.likes,
            checkins: resolvedStats.checkins,
          };
        }
        break;
      case 'checkin':
        if (resolvedStats) view = { kind: 'checkin', days: resolvedStats.checkins };
        break;
    }
    return { ...block, view };
  });
}

/**
 * 主页要渲染的全部内容。
 *
 * 没有存过任何块 = 用默认布局（最近三篇对外可读的文章）。**不落库** —— 一旦落库，
 * 「默认」就变成了一份需要迁移的数据；而且用户第一次打开编辑器时看到的就是这份
 * 默认布局，保存才真正落库。
 */
export async function getProfilePageData(
  userId: string,
  opts: { isOwner: boolean; showRecentBlogs?: boolean }
): Promise<ProfilePageData> {
  const rows = await prisma.profileBlock.findMany({
    where: { userId, deleted: false },
    // sort 是手机端顺序（迁移 32）；老行全是 0，于是回落到旧的 (y, x) 顺序。
    orderBy: [{ sort: 'asc' }, { y: 'asc' }, { x: 'asc' }],
    select: { id: true, kind: true, x: true, y: true, w: true, h: true, config: true },
  });

  let stored = rows.map(toStored).filter((b): b is StoredBlock => b !== null);
  const isDefault = stored.length === 0;

  // 默认布局尊重「展示最近文章」这个旧开关：关掉它的人不该因为「还没布置」
  // 就被自动挂上三篇最近文章。**只影响默认布局** —— 亲手加的文章块照常显示。
  // 不传 = 按默认展示（测试与内部调用方少传一个参数时行为不变）。
  if (isDefault && (opts.showRecentBlogs ?? true)) {
    const recent = await prisma.blog.findMany({
      where: { authorId: userId, ignore: false, ...EXTERNAL_VISIBLE_BLOG_WHERE },
      orderBy: { createdAt: 'desc' },
      take: DEFAULT_BLOG_TAKES,
      select: { id: true },
    });
    stored = recent.map((b, i) => ({
      // 默认块的 id 也要过 BLOCK_ID_RE（保存时会被带回服务端）
      id: `defaultb${i}`.padEnd(10, '0'),
      kind: 'blog' as const,
      ...defaultPositions(i),
      config: { blogId: b.id },
    }));
  }

  // 本人要编辑清单，也就需要统计块的预览值；访客只在真的挂了统计块时才算。
  const needStats = stored.some((b) => b.kind === 'stats' || b.kind === 'checkin');
  const stats = opts.isOwner || needStats ? await computeStats(userId) : null;

  let blocks = await resolveViews(userId, stored, stats);

  // 访客视图：目标已不可对外展示的块**连指针都不下发**（它本来就不渲染）。
  // 本人才拿得到它们 —— 编辑器要显示「这块内容已不可用」并让人换掉。
  if (!opts.isOwner) {
    blocks = blocks.filter((b) => b.view !== null);
  }

  let catalog: BlockCatalog | null = null;
  if (opts.isOwner) {
    const [blogs, images, audios] = await Promise.all([
      prisma.blog.findMany({
        where: { authorId: userId, ignore: false, ...EXTERNAL_VISIBLE_BLOG_WHERE },
        orderBy: { createdAt: 'desc' },
        take: CATALOG_BLOG_TAKES,
        select: { id: true, title: true, visibility: true, createdAt: true },
      }),
      prisma.imageHosting.findMany({
        where: { authorId: userId, ignore: false, isPublic: true },
        orderBy: { createdAt: 'desc' },
        take: CATALOG_IMAGE_TAKES,
        select: { id: true, filename: true },
      }),
      prisma.audioHosting.findMany({
        where: { authorId: userId, ignore: false, isPublic: true },
        orderBy: { createdAt: 'desc' },
        take: CATALOG_AUDIO_TAKES,
        select: { id: true, filename: true },
      }),
    ]);
    catalog = {
      blogs: blogs.map((b) => ({
        id: b.id,
        title: b.title,
        visibility: b.visibility,
        createdAt: isoWithOffset(b.createdAt),
      })),
      images: images.map((i) => ({ id: i.id, url: `/api/images/${i.id}/raw`, filename: i.filename })),
      audios: audios.map((a) => ({ id: a.id, url: `/api/audio/${a.id}/raw`, filename: a.filename })),
      // owner 分支里 stats 一定算过（见上面 needStats 那段）；这里只是收窄类型。
      stats: stats ?? { blogs: 0, likes: 0, checkins: 0 },
    };
  }

  return { blocks, catalog, isDefault };
}

export type SaveResult = { ok: true; count: number } | { ok: false; message: string };

/**
 * 保存整页布局。**服务端最后一道闸**：客户端做过一次 normalizeBlocks 只是体验，
 * 这里才是防线（请求可以被手工构造）。
 *
 * 写入策略：软删「这次没带的块」，其余按 id 更新（必要时复活墓碑行）。
 * ⚠️ 不要改成「全删再全插」—— 会撞主键，且会留下一堆没必要的墓碑。
 */
export async function saveProfileBlocks(userId: string, raw: unknown): Promise<SaveResult> {
  const parsed = normalizeBlocks(raw);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const blocks = parsed.blocks;

  // 归属校验：指针必须指向**自己的、未软删**的对象。
  //
  // 【刻意不查档位】档位在读路径里判（resolveViews 叠 EXTERNAL_VISIBLE_*）。这里若
  // 也要求「此刻对外可见」，目标刚降档的人会**整页都存不进去** —— 报「有一篇文章
  // 不可见」，而他想删掉那一块也删不掉（保存是整页提交）。那块本来就会渲染成空，
  // 编辑器里显示「已不可用」并让他换一个，这才是正确的手感。
  const blogIds = [...new Set(blocks.filter((b) => b.kind === 'blog').map((b) => String(b.config.blogId)))];
  const imageIds = [...new Set(blocks.filter((b) => b.kind === 'image').map((b) => String(b.config.imageId)))];
  const audioIds = [...new Set(blocks.filter((b) => b.kind === 'audio').map((b) => String(b.config.audioId)))];

  const [blogOk, imageOk, audioOk] = await Promise.all([
    blogIds.length
      ? prisma.blog.count({ where: { id: { in: blogIds }, authorId: userId, ignore: false } })
      : Promise.resolve(0),
    imageIds.length
      ? prisma.imageHosting.count({ where: { id: { in: imageIds }, authorId: userId, ignore: false } })
      : Promise.resolve(0),
    audioIds.length
      ? prisma.audioHosting.count({ where: { id: { in: audioIds }, authorId: userId, ignore: false } })
      : Promise.resolve(0),
  ]);
  if (blogOk !== blogIds.length) return { ok: false, message: '有一篇文章不存在或不属于你，刷新后再试' };
  if (imageOk !== imageIds.length) return { ok: false, message: '有一张图片不存在或不属于你，刷新后再试' };
  if (audioOk !== audioIds.length) return { ok: false, message: '有一段音频不存在或不属于你，刷新后再试' };

  const now = nowForDb();
  await prisma.$transaction(async (tx) => {
    const owned = await tx.profileBlock.findMany({ where: { userId }, select: { id: true } });
    const ownedIds = new Set(owned.map((o) => o.id));

    // 客户端带来的 id 只在本人的行里认；其余一律重新发号（防「借别人的 id 撞主键」）。
    const withIds = blocks.map((b) => ({
      ...b,
      id: b.id && ownedIds.has(b.id) ? b.id : generateShortId(12),
    }));
    const keep = new Set(withIds.map((b) => b.id));

    const stale = [...ownedIds].filter((id) => !keep.has(id));
    if (stale.length) {
      await tx.profileBlock.updateMany({
        where: { userId, id: { in: stale }, deleted: false },
        data: { deleted: true, updatedAt: now },
      });
    }

    for (const [index, b] of withIds.entries()) {
      const data = {
        kind: b.kind,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        // 手机端顺序 = 客户端数组下标（迁移 32）。桌面位置仍由 x/y 决定，两者互不干扰。
        sort: index,
        config: JSON.stringify(b.config),
        updatedAt: now,
        deleted: false,
      };
      if (ownedIds.has(b.id)) {
        await tx.profileBlock.update({ where: { id: b.id }, data });
      } else {
        await tx.profileBlock.create({ data: { id: b.id, userId, createdAt: now, ...data } });
      }
    }
  });

  return { ok: true, count: blocks.length };
}
