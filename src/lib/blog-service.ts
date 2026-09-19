// ─────────────────────────────────────────────────────────────────────────────
// blog-service.ts — 博客业务逻辑
//
// 纯函数 + 显式参数，方便测试与复用。
// 软删除：Blog.ignore = true 的一律排除（对齐 CLAUDE.md 的软删除约定）。
//
// ── 可见性四条不变量（`Blog.visibility`）─────────────────────────────────────
//
// 三档是 'private' / 'link' / 'public'，**只对非 core 的查看者生效** —— core+ 在
// 博客域是全读的，压根不看这一列。所以这一列对任何 core+ 入口都是零行为变化。
//
// 【1】判「对外可见」**永远**用 EXTERNAL_VISIBILITIES / EXTERNAL_VISIBLE_BLOG_WHERE，
//   绝不写 `visibility !== 'private'`，也别写 `not: 'private'`。那两种写法在加第四档
//   时会**静默把新档一起放出去** —— 而「放出去」是不可逆的（搜索引擎与第三方存档会
//   抓走副本）。有静态守卫盯着这条：tests/unit/blog-visibility-guard.test.ts。
//
// 【2】不判档位的读口必须过共享出口，别各自手写 where：
//   · 对外读一篇（游客视角）→ getExternallyVisibleBlog(id)
//   · 对外列清单（可索引）  → listIndexableBlogs()（sitemap） / listPublicBlogs()（/explore 页面）
//   · 带查看者读一篇        → getBlogDetail(id, viewer)
//   这几个名字本身就说明了「这里做了可见性判定」，静态守卫的台账认得它们。
//
// 【3】「对外可读」与「可列举 / 可索引」是**两件事**：link 档读得到，但不进 sitemap、
//   不许索引。所以判可达用 EXTERNAL_*，sitemap 用 INDEXABLE_*，别混用。
//
// 【4】private 的语义是「仅站内 core+ 可见」，**不是「不存在」**：访客拿到的是登录页。
//   由此推出两件刻意的事：
//   · **管理员 / 站长不需要豁免** —— 他们本来就在 core+ 里，压根不走可见性判定。
//     这不是「忘了给管理员开后门」，是结构性豁免。
//   · **作者不设后门** —— 被降权（core→user）的作者读不到自己当年的 private 文章。
//     档位回答的是「你现在还配不配用这个区」，归属回答不了这个问题
//     （见 `docs/architecture.md` §8「档位 vs 归属是两层」）。想加「作者可见自己」
//     之前，先回去读那张表。
//
// 【5】（第 2 期）对外列表只有一个出口 `listPublicBlogs`，且它**必须**与 sitemap 的
//   `listIndexableBlogs` 列同一个集合（都用 `INDEXABLE_BLOG_WHERE`）。这不是洁癖：
//   「可发现」的整个承诺就是「爬虫抓得到 ⟺ 公开列表上找得到」。若列表多一层过滤，
//   就会出现「搜索引擎收录了一篇，读者在公开列表上翻不到」——而这两条路径的差异
//   不会有任何报错。有静态守卫盯：tests/unit/explore-visibility-guard.test.ts。
//   另一条：对外列表的行**不带任何计数**（点赞/评论/鱼干）—— 对外视图没有评论区，
//   卡片上写「评论 12」却翻不到评论是自相矛盾的。由 select 保证，不靠渲染层自觉。
//
// 【6】（第 2 期）`exclude_from_all` 与 `focus_hidden` **不作用于对外列表**。它们分别是
//   站内「全部文章」的陈列规则与账号级浏览偏好，而对外列表的资格只有一条：
//   `visibility = public`。混合它们会直接破坏【5】。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb, dayStart, todayStr, hoursUntil } from './db-time';
import { ymdhms, categoryFullPath } from './format';
import { rateLimit, RULES } from './rate-limit';
import { sendNotification } from './notification-service';
import {
  BLOG_VISIBILITIES,
  EXTERNAL_VISIBILITIES,
  INDEXABLE_VISIBILITIES,
  VISIBILITY_LABEL,
  parseVisibility,
} from './blog-visibility';
import type { BlogVisibility } from './blog-visibility';
import type { Prisma } from '@prisma/client';

// 服务端调用方（route / 页面 / 测试）从这里取就行。**客户端组件例外**：它们必须直接
// import `./blog-visibility` —— 本模块拖着 prisma，值导出进不了客户端包。
export {
  BLOG_VISIBILITIES,
  EXTERNAL_VISIBILITIES,
  INDEXABLE_VISIBILITIES,
  VISIBILITY_LABEL,
  parseVisibility,
} from './blog-visibility';
export type { BlogVisibility } from './blog-visibility';

export type BlogSort = 'created' | 'updated';

/** 可搜字段。`content` 是正文（1:1 的 BlogContent），代价见 ListParams.searchFields。 */
export type SearchField = 'title' | 'description' | 'author' | 'content';

/** 全部可搜字段（HTTP 层的 `search_fields` 白名单就取这个）。 */
export const ALL_SEARCH_FIELDS = ['title', 'description', 'author', 'content'] as const;

/** 缺省搜索范围 = 标题 / 简介 / 作者名，与 2026-09 之前的公开搜索逐字一致。 */
export const DEFAULT_SEARCH_FIELDS: readonly SearchField[] = ['title', 'description', 'author'];

/** 列表排序参数解析：只认显式 'updated'，其余（缺省/非法）一律回退 'created'（默认按发布时间）。 */
export function parseSortParam(raw: unknown): BlogSort {
  return raw === 'updated' ? 'updated' : 'created';
}

// ── 可见性判定（词汇本身在 ./blog-visibility，不变量见文件头）──────────────────
//
// 词汇（三档的名字 / 白名单 / parseVisibility / 人话标签）住在 `./blog-visibility` ——
// 那是个**零依赖**模块，因为发文表单是客户端组件，而本文件拖着 prisma、进不了客户端包。
// 判定与闸门留在本文件。

/**
 * 对外可见的 where 片段（link + public）。
 *
 * ⚠️ **不能用 `as const`**（收藏夹的 `PUBLIC_FAVORITE_WHERE` 能用，是因为它只有布尔）。
 * `as const` 会把 `in` 冻成 `readonly`，而 Prisma 的 `in:` 要的是可变数组 → TS2322；
 * 更坑的是：**那条错误会让 `findFirst` 的重载解析失败，于是 `select` 被静默忽略**，
 * 在调用点炸出一整片「Property 'author' does not exist」的假错误（本文件踩过，
 * 9 条报错全是同一条根因的级联）。所以这里用类型标注 + `Object.freeze`。
 *
 * 展开成新数组（`[...EXTERNAL_VISIBILITIES]`）也是必须的：readonly 元组塞不进 `in:`。
 */
export const EXTERNAL_VISIBLE_BLOG_WHERE: Prisma.BlogWhereInput = Object.freeze({
  visibility: { in: [...EXTERNAL_VISIBILITIES] },
});

/** 可索引的 where 片段（sitemap 用）。同上，不要写成 `as const`。 */
export const INDEXABLE_BLOG_WHERE: Prisma.BlogWhereInput = Object.freeze({
  visibility: { in: [...INDEXABLE_VISIBILITIES] },
});

/**
 * 查看者。`null` = 游客（未登录）—— **不是**「不判」，别把它当「跳过可见性」用。
 *
 * 与 user-service 的 `ProfileViewer` 同形：两处都是「查看者」，别各长各的。
 * **必传，没有默认值** —— 默认放行的参数一漏传就是越权。
 */
export interface BlogViewer {
  id: string;
  isCore: boolean;
}

export interface ListParams {
  page?: number;
  perPage?: number;
  categorySlug?: string | null;
  featured?: boolean;
  search?: string | null;
  sort?: BlogSort;
  /** 查看者开启了专注模式：过滤 focusHidden 栏目（含其子栏目）下的文章。 */
  focusMode?: boolean;
  /**
   * 搜索字段。**缺省 = DEFAULT_SEARCH_FIELDS（标题 / 简介 / 作者名）**，与既有行为逐字一致；
   * 传空数组也回退到这个默认值（避免 `OR: []` 静默变成「不过滤」而返回全站文章）。
   *
   * ⚠️ 含 `content` 是**重活**：正文合计约 48.6MB / 6193 篇，`LIKE '%q%'` 全表扫描实测
   * 约 68ms/遍，而 count + findMany 会走两遍（约 136ms）；元数据搜索只要 1~2ms。
   * service 层管不了鉴权，所以**每个调用方必须自己把住**：
   *   · `/blog` 页面 —— 在 requireCoreUser() 之后，另有限频闸（RULES.blogSearchMinute）
   *   · `/api/blogs` —— route 里对 content 做 core+ 校验 + 同一条限频
   * 绝不要把含 content 的默认值放给匿名调用方：那等于让每个访客每敲一个键就扫一遍全站
   * 正文，而且不报错、只是悄悄变慢。
   */
  searchFields?: readonly SearchField[];
}

const DEFAULT_PER_PAGE = 200;

/**
 * **站内**列表：不看 `visibility`。
 *
 * 【对外列表不走这里】本函数的两个调用方（`/blog` 页面、`GET /api/blogs`）都是 core+
 * 档，而 core+ 在博客域是全读的 —— 所以可见性在这里没有意义，返回全量是对的。
 *
 * 对外列表**另起了入口**（`listPublicBlogs`，见文件头不变量【5】），**本函数仍然不看
 * visibility**。**别给本函数加一个可选的 viewer 参数** —— 可选的参数一旦漏传，
 * 方向就是「把全站 private 文章喂给访客」，而这里没有任何编译期的东西能挡住它。
 * tests/service/blog-service.test.ts 有一条钉现状的用例：存在 private 文章时本函数
 * **照旧返回它**；谁哪天顺手加了过滤，那条会立刻变红。
 */
export async function listBlogs(params: ListParams) {
  const page = Math.max(1, params.page ?? 1);
  // 每页上限与默认一致（200 篇/页），仍防「?perPage=100000 拖库」
  const perPage = Math.min(200, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));

  const where: Prisma.BlogWhereInput = { ignore: false };

  // 精选筛选：**false 也生效**（筛出非精选）。
  // 写成 `if (params.featured)` 会让 featured=false 等同于不传，丢掉「只看非精选」的语义。
  if (params.featured !== undefined && params.featured !== null) {
    where.isFeatured = params.featured;
  }

  if (params.categorySlug) {
    // 指定栏目：命中该栏目或其子栏目。
    // isActive 过滤（栏目与子栏目都判）—— 停用栏目下的文章不应能通过 slug 直接访问。
    const cat = await prisma.category.findFirst({
      where: { slug: params.categorySlug, isActive: true },
      select: { id: true, children: { where: { isActive: true }, select: { id: true } } },
    });
    if (cat) {
      const ids = [cat.id, ...cat.children.map((c) => c.id)];
      where.categoryId = { in: ids };
    } else {
      where.categoryId = -1; // 不存在/已停用的栏目 → 空结果
    }
  } else {
    // 「全部文章」：排除 exclude_from_all 的栏目**及其子栏目** —— 取启用中的
    // exclude_from_all 栏目，把「它自己 + 它的启用子栏目」的 id 并成一个集合，
    // 再滤掉 category_id 落在这个集合里的文章。
    //
    // ⚠️ 两个易错点：
    //  1. **必须显式保住 category_id IS NULL** —— SQL 里 `NULL NOT IN (...)` 求值为 NULL，
    //     只写 notIn 会把「未分类」文章一并滤掉。实测：只要站内存在任意一个
    //     exclude_from_all 栏目，所有未分类文章就从首页消失。
    //  2. 该排除与 featured 无关（只看有没有传 category_slug）。写成
    //     `else if (!params.featured)` 会让精选页漏出被排除栏目的文章。
    const excluded = await prisma.category.findMany({
      where: { excludeFromAll: true, isActive: true },
      select: { id: true, children: { where: { isActive: true }, select: { id: true } } },
    });
    const excludedIds = excluded.flatMap((c) => [c.id, ...c.children.map((x) => x.id)]);
    if (excludedIds.length) {
      where.AND = [
        { OR: [{ categoryId: null }, { categoryId: { notIn: excludedIds } }] },
      ];
    }
  }

  // 专注模式（个人视图）：排除 focusHidden 栏目及其子栏目下的文章。
  // 与 exclude_from_all 的区别：
  //   • exclude 是全站生效、只认启用的栏目；focusHidden 对「开启专注模式的人」生效，
  //     含已停用栏目 —— 站长标记的是"栏目范畴"，停用与否不改变"这板子是水区"的语义。
  //   • categorySlug 指向被标记栏目时，slug 分支的 `in` 与这里的 `notIn` 交集为空，
  //     列表自然为空 —— URL 显式点进来也看不到。
  if (params.focusMode) {
    const flagged = await prisma.category.findMany({
      where: { focusHidden: true },
      select: { id: true, children: { select: { id: true } } },
    });
    const focusIds = flagged.flatMap((c) => [c.id, ...c.children.map((x) => x.id)]);
    if (focusIds.length) {
      // AND 语义可能与上面的 exclude 分支叠加；AND 类型是 where 对象或数组，
      // 与 search 分支同一写法（先展开既有元素再并新条件），避免互相覆盖。
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { OR: [{ categoryId: null }, { categoryId: { notIn: focusIds } }] },
      ];
    }
  }

  // 搜索词在 findMany 之后还要用（补正文片段），所以在函数作用域里留着。
  const q = params.search?.trim() || null;
  // 空数组回退默认 —— 否则 `OR: []` 在 Prisma 里等价于「不过滤」，会静默返回全站文章。
  const fields = params.searchFields?.length ? params.searchFields : DEFAULT_SEARCH_FIELDS;
  // 正文范围是重活（一次全表扫描），也是唯一需要补片段的场合。
  const withContent = fields.includes('content');

  if (q) {
    const or: Prisma.BlogWhereInput[] = [];
    if (fields.includes('title')) or.push({ title: { contains: q } });
    if (fields.includes('description')) or.push({ description: { contains: q } });
    if (fields.includes('author')) or.push({ author: { is: { username: { contains: q } } } });
    // 正文刻意存在独立的 blog_contents 表（列表查询不拖正文），
    // 所以这里必须显式穿一层 relation 才搜得到。
    if (withContent) or.push({ content: { is: { content: { contains: q } } } });

    // 用 AND 承载，避免与上面「保住 NULL」的 OR 互相覆盖（两者都写 where.OR 会后者胜出）。
    const searchOr: Prisma.BlogWhereInput = { OR: or };
    where.AND = Array.isArray(where.AND) ? [...where.AND, searchOr] : [searchOr];
  }

  // 排序：created=发布时间（默认）；updated=最后编辑时间（BlogContent.updatedAt，1:1 relation
  // orderBy，SQLite 对 NULL 的 DESC 语义是排最后 —— content 行缺失的文章退到最后，属防御分支，
  // 正常写入路径 createBlog/updateBlog 保证行必在）。次键 createdAt 锁同秒 updatedAt 的稳定性。
  const orderBy: Prisma.BlogOrderByWithRelationInput[] =
    params.sort === 'updated'
      ? [{ content: { updatedAt: 'desc' } }, { createdAt: 'desc' }]
      : [{ createdAt: 'desc' }];

  const [total, blogs] = await Promise.all([
    prisma.blog.count({ where }),
    prisma.blog.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        title: true,
        description: true,
        createdAt: true,
        likesCount: true,
        commentsCount: true,
        fishCount: true,
        isFeatured: true,
        authorId: true,
        author: { select: { username: true } },
        category: { select: { name: true, parentId: true, parent: { select: { name: true } } } },
        // 排序按 content.updatedAt，行数据也要带上（列表 API 出 updated_at 字段用）
        content: { select: { updatedAt: true } },
      },
    }),
  ]);

  // 补正文片段。映射无条件做一遍，让返回类型统一（blogs 始终带 snippet 字段，
  // 非正文搜索时为 null），调用方就不必区分两种形状。
  const rows =
    withContent && q
      ? await attachSnippets(blogs, q)
      : blogs.map((b) => ({ ...b, snippet: null as string | null }));

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { blogs: rows, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

/** 片段在命中处两侧各取的字符数。总长约 2×60，与 .blog-description 的两行截断相称。 */
const SNIPPET_RADIUS = 60;

/**
 * 给搜索结果补「命中处的正文片段」，让列表页能回答「这篇为什么被搜出来」。
 *
 * 形状照抄 chat-service 的 attachImagesAndReplies：空数组早退 → 去重 id → 一次批量查
 * → 建 Map → 挂载。**绝不把正文并进上面 findMany 的 select** —— 那会把每页最多 200 条
 * × 平均 5KB 的正文全拉回来，而列表根本不用；这里只查当页那几条，且只多一次查询。
 *
 * 只给**正文确实命中**的行片段：标题 / 简介 / 作者命中的文章，正文里并没有这个词，
 * 返回 null 让调用方回退到 description —— 否则卡片会顶出一段与关键词毫不相干的正文开头。
 *
 * ⚠️ 片段是**原始 markdown**（正文就是 md 原文，含代码块、链接、字面 HTML），
 * 调用方必须以纯文本插值渲染，绝不进 dangerouslySetInnerHTML。
 */
async function attachSnippets<T extends { id: string }>(
  rows: T[],
  q: string
): Promise<(T & { snippet: string | null })[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.id))];
  const contents = await prisma.blogContent.findMany({
    where: { blogId: { in: ids } },
    select: { blogId: true, content: true },
  });
  const byId = new Map(contents.map((c) => [c.blogId, c.content]));
  // 大小写口径：SQLite 的 LIKE 只对 ASCII 不敏感，而 toLowerCase 是 Unicode 感知的，
  // 两者域不同。最坏情况是极端字符下少给一个片段（退化成显示简介），不是错误答案。
  const needle = q.toLowerCase();
  return rows.map((r) => {
    const raw = byId.get(r.id);
    if (!raw) return { ...r, snippet: null };
    const at = raw.toLowerCase().indexOf(needle);
    return { ...r, snippet: at < 0 ? null : makeSnippet(raw, at, q.length) };
  });
}

/** 在命中处截取两侧上下文，并把换行 / 连续空白折成单个空格（卡片里是一段文本）。 */
function makeSnippet(content: string, at: number, qLen: number): string {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(content.length, at + qLen + SNIPPET_RADIUS);
  const body = content.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < content.length ? '…' : ''}`;
}

/**
 * 读一篇。`viewer` **必传**（null = 游客）。
 *
 * core+ 不加可见性条件（private 对他们就是「照常可读」）；非 core 只能拿到对外可见
 * 的两档。**不判档位的读口别直接调它** —— 用下面两个具名出口，它们的名字说明了一切。
 *
 * 返回 null 的三种原因（**对外同形，不区分**）：不存在、已软删、档位不够。
 */
export async function getBlogDetail(id: string, viewer: BlogViewer | null) {
  const blog = await prisma.blog.findFirst({
    where: {
      id,
      ignore: false,
      ...(viewer?.isCore ? {} : EXTERNAL_VISIBLE_BLOG_WHERE),
    },
    select: {
      id: true,
      title: true,
      description: true,
      createdAt: true,
      likesCount: true,
      commentsCount: true,
      fishCount: true,
      isFeatured: true,
      authorId: true,
      // 页面要拿它决定 robots 元数据与 OG 图，OG 图路由要拿它决定 X-Robots-Tag
      visibility: true,
      author: { select: { id: true, username: true } },
      category: { select: { name: true, slug: true, parentId: true, parent: { select: { name: true } } } },
      content: { select: { content: true, updatedAt: true } },
    },
  });
  return blog;
}

/**
 * **对外读一篇的唯一出口**：viewer 恒为游客。
 *
 * 对外页面与 OG 图都走它，别各自去写 `getBlogDetail(id, null)` —— 具名出口是静态
 * 守卫（tests/unit/anonymous-read-guard.test.ts 的 GUARD_SYMBOLS）能认得的形状，
 * 也说明「这个调用点确实做了可见性判定」。
 */
export async function getExternallyVisibleBlog(id: string) {
  return getBlogDetail(id, null);
}

/**
 * 可索引的文章清单（sitemap 用）。只出 public 档。
 *
 * **不判档位**的列表出口：调用方拿不到会话，正是因此它只敢返回 public —— link 档
 * 拿到链接就能读，但**不该被列举**（决策：link 不进 sitemap、不许索引）。
 */
export async function listIndexableBlogs(): Promise<
  { id: string; updatedAt: Date | null; createdAt: Date | null }[]
> {
  const rows = await prisma.blog.findMany({
    where: { ignore: false, ...INDEXABLE_BLOG_WHERE },
    select: { id: true, createdAt: true, content: { select: { updatedAt: true } } },
    orderBy: { createdAt: 'desc' },
  });
  // 取正文的 updatedAt 当 lastModified —— 「什么时候改的」对爬虫比「什么时候发的」有用
  return rows.map((r) => ({
    id: r.id,
    updatedAt: r.content?.updatedAt ?? null,
    createdAt: r.createdAt,
  }));
}

/**
 * 对外列表（`/explore`）的一行。**刻意不含任何计数** —— 见文件头不变量【5】。
 *
 * 形状特意与 `listBlogs` 的行**不同**（那边带三个计数）：这不是「忘了补」，是
 * 让「卡片上不许出现计数」变成类型层面的事实，而不是渲染层的一句自觉。
 */
export interface PublicBlogRow {
  id: string;
  title: string;
  description: string | null;
  createdAt: Date | null;
  authorId: string;
  author: { username: string | null } | null;
  category: { name: string; parentId: number | null; parent: { name: string } | null } | null;
}

export interface PublicListParams {
  page?: number;
  perPage?: number;
  categorySlug?: string | null;
  search?: string | null;
}

const PUBLIC_DEFAULT_PER_PAGE = 20;
const PUBLIC_MAX_PER_PAGE = 50;

/**
 * 对外搜索允许命中的字段。`Exclude<…, 'content'>` 不是装饰 —— 它让「对外搜索绝不
 * 碰正文」成为**编译期**的事实：谁想把 `content` 加进这张表，tsc 当场拒绝，
 * 而不是等到线上匿名用户把 48.6MB 正文扫了一遍才发现。
 *
 * **刻意与 `DEFAULT_SEARCH_FIELDS` 分开写**：两者今天恰好相同，但它们回答的是不同
 * 的问题 —— 站内默认集合可以随站内需要放宽（比如把正文加进去），对外这一份永远
 * 不许。绑成一个常量的话，站内那次放宽会**静默**传导到匿名页面上。
 *
 * 行为侧另有一条用例钉住：拿一段**只在正文里**的哨兵串搜，必须搜不到。
 */
type PublicSearchField = Exclude<SearchField, 'content'>;

const PUBLIC_SEARCH_FIELDS: readonly PublicSearchField[] = ['title', 'description', 'author'];

const PUBLIC_SEARCH_WHERE: Record<PublicSearchField, (q: string) => Prisma.BlogWhereInput> = {
  title: (q) => ({ title: { contains: q } }),
  description: (q) => ({ description: { contains: q } }),
  author: (q) => ({ author: { is: { username: { contains: q } } } }),
};

/**
 * **对外**列表：只出 public 档，与 sitemap 同一个集合（文件头不变量【5】）。
 *
 * 与 `listBlogs` 的四点差异，都是刻意的：
 *   · where 以 `...INDEXABLE_BLOG_WHERE` 起手（不是 `ignore: false`）—— 与 sitemap 同源；
 *   · **不做** `excludeFromAll` / `focusHidden` 过滤（不变量【6】）；
 *   · 搜索字段写死成 `PUBLIC_SEARCH_FIELDS`，**不接受** `searchFields` 参数 ——
 *     正文只可能经那个参数进来，而没有这个参数就进不来；
 *   · 不 select 任何计数。
 *
 * 排序恒按发布时间倒序：**不读也不写** `blog-sort-pref` 那个 cookie —— 对一个
 * 面向站外（含爬虫）的页面，设偏好 cookie 没有意义，只会平白多一个真相源。
 */
export async function listPublicBlogs(params: PublicListParams = {}): Promise<{
  blogs: PublicBlogRow[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
  hasPrev: boolean;
  hasNext: boolean;
}> {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(
    PUBLIC_MAX_PER_PAGE,
    Math.max(1, params.perPage ?? PUBLIC_DEFAULT_PER_PAGE)
  );

  const where: Prisma.BlogWhereInput = { ignore: false, ...INDEXABLE_BLOG_WHERE };

  if (params.categorySlug) {
    // 与 listBlogs 的 slug 分支同一口径：只认**启用**的栏目，命中它自己 + 它的启用
    // 子栏目；不存在 / 已停用 → 空结果（**不是**退化成「全部」—— 那会让一个拼错的
    // slug 静默变成公开列表首页）。
    const cat = await prisma.category.findFirst({
      where: { slug: params.categorySlug, isActive: true },
      select: { id: true, children: { where: { isActive: true }, select: { id: true } } },
    });
    if (cat) {
      where.categoryId = { in: [cat.id, ...cat.children.map((c) => c.id)] };
    } else {
      where.categoryId = -1;
    }
  }

  const q = params.search?.trim() || null;
  if (q) {
    // 用 AND 承载，而不是直接写 where.OR —— 上面栏目分支可能已经用了别的字段，
    // 写 OR 会与将来的条件互相覆盖（listBlogs 在同一处踩过这个形状）。
    where.AND = [{ OR: PUBLIC_SEARCH_FIELDS.map((f) => PUBLIC_SEARCH_WHERE[f](q)) }];
  }

  const [total, blogs] = await Promise.all([
    prisma.blog.count({ where }),
    prisma.blog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        title: true,
        description: true,
        createdAt: true,
        authorId: true,
        author: { select: { username: true } },
        // ⚠️ parentId 与 parent.name 必须**一起** select。只给 name 会让
        // categoryFullPath() 静默退化成「只显示子栏目名，丢掉父级」——
        // src/app/api/blogs/route.ts:117-119 就是这么错的。
        category: { select: { name: true, parentId: true, parent: { select: { name: true } } } },
      },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { blogs, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

/**
 * 公开集合里**真的有文章**的栏目 id 集合（给 `/explore` 的侧栏剪枝用）。
 *
 * 侧栏只列这个集合里的栏目：空栏目是死链（点进去什么都没有），而且会给搜索引擎
 * 一批空页面。这与 sitemap/列表「同一个集合」是同一条纪律的延伸 —— 因此它也必须
 * 走同一个 `INDEXABLE_BLOG_WHERE`。
 *
 * 返回的是**扁平集合**，不含祖先推导：调用方手里有栏目树，判断「父栏目该不该留」
 * （任一子栏目在集合里）是树上的事，不该塞进这里。
 */
export async function listPublicCategoryFacets(): Promise<Set<number>> {
  const rows = await prisma.blog.findMany({
    where: { ignore: false, ...INDEXABLE_BLOG_WHERE },
    select: { categoryId: true },
    distinct: ['categoryId'],
  });
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.categoryId != null) ids.add(r.categoryId);
  }
  return ids;
}

export interface LikerRow {
  id: string;
  username: string | null;
  avatar_url: string;
  liked_at: string | null;
}

/**
 * 点赞者列表。
 *
 * 只列未软删的点赞（deleted=false）—— 取消赞的人不该还出现在列表里。
 * 字段名用 snake_case、时间用 'YYYY-MM-DD HH:MM:SS'，是前端 FeedButton
 * 直接消费的 JSON 形状，别顺手改成 camelCase。
 *
 * @returns null 表示文章不存在（路由据此返回 404）
 */
export async function getLikers(
  blogId: string,
  offset = 0,
  limit = 50
): Promise<{ users: LikerRow[]; total: number; offset: number; limit: number } | null> {
  const blog = await prisma.blog.findUnique({ where: { id: blogId }, select: { id: true } });
  if (!blog) return null;

  const lim = Math.max(1, Math.min(limit, 200));
  const off = Math.max(0, offset);

  const [total, likes] = await Promise.all([
    prisma.blogLike.count({ where: { blogId, deleted: false } }),
    prisma.blogLike.findMany({
      where: { blogId, deleted: false },
      orderBy: { createdAt: 'desc' },
      skip: off,
      take: lim,
      select: {
        userId: true,
        createdAt: true,
        user: { select: { id: true, username: true } },
      },
    }),
  ]);

  return {
    users: likes.map((l) => ({
      id: l.user?.id ?? l.userId,
      username: l.user?.username ?? null,
      // 头像由本站 /api/avatar 提供（永不 404，见 avatar.ts）
      avatar_url: `/api/avatar/${l.user?.id ?? l.userId}`,
      liked_at: ymdhms(l.createdAt),
    })),
    total,
    offset: off,
    limit: lim,
  };
}

/**
 * 点赞切换：唯一约束 (blog_id,user_id) + 软删除 deleted 字段，
 * 计数在事务内原子增减。附带内存限频（100/时、500/天）。
 *
 * 点赞生效时给作者发一条『文章点赞』，
 * 用 BlogLike.notificationSent 保证「一人对一篇文章最多一条通知」。
 */
export async function toggleLike(blogId: string, userId: string) {
  // 【先查存在性，再扣限频】顺序不能反。
  // 反过来（限频在最前）的话，刷一个不存在的 blogId 就能把自己 100 次/时的点赞额度
  // 烧光 —— 属于自伤，但没有任何理由让无效请求消耗配额。
  const exists = await prisma.blog.findFirst({
    where: { id: blogId, ignore: false },
    select: { id: true },
  });
  if (!exists) return { notFound: true as const };

  const hourly = rateLimit(`like:h:${userId}`, RULES.likeHourly);
  const daily = rateLimit(`like:d:${userId}`, RULES.likeDaily);
  if (!hourly.allowed || !daily.allowed) {
    return { rateLimited: true as const };
  }

  const result = await prisma.$transaction(async (tx) => {
    // 事务内再确认一次（并发下文章可能刚被软删）
    const blog = await tx.blog.findFirst({
      where: { id: blogId, ignore: false },
      select: { id: true, authorId: true, title: true },
    });
    if (!blog) return { notFound: true as const };

    const existing = await tx.blogLike.findUnique({
      where: { uq_blog_like_blog_user: { blogId, userId } },
    });

    let liked: boolean;
    if (!existing) {
      await tx.blogLike.create({ data: { blogId, userId, deleted: false } });
      liked = true;
    } else {
      liked = existing.deleted; // 之前是删除态 → 现在点亮
      await tx.blogLike.update({
        where: { id: existing.id },
        data: { deleted: !liked, deletedAt: liked ? null : nowForDb() },
      });
    }

    // 通知条件：点赞生效 + 不是自赞 + 这条点赞记录从未发过通知。
    // notificationSent 用 updateMany 原子抢占：并发下只有一方 count===1，
    // 另一方拿不到就闭嘴，避免重复发。取消点赞不碰标记 —— 重新点亮也不再发
    // （即「一个用户对一篇文章，最多只会发送一条通知」）。
    let notify = false;
    if (liked && blog.authorId !== userId) {
      const claimed = await tx.blogLike.updateMany({
        where: { blogId, userId, notificationSent: false },
        data: { notificationSent: true },
      });
      notify = claimed.count === 1;
    }

    const likesCount = await tx.blogLike.count({ where: { blogId, deleted: false } });
    await tx.blog.update({ where: { id: blogId }, data: { likesCount } });
    return { liked, likesCount, notify, authorId: blog.authorId, title: blog.title };
  });

  if ('notFound' in result) return result;

  // 通知放在事务提交之后：通知失败绝不能回滚已经生效的点赞（对齐 feed-service 的口径）。
  if (result.notify) {
    try {
      await sendNotification({
        recipientId: result.authorId,
        action: '文章点赞',
        actorId: userId,
        objectType: 'blog',
        objectId: blogId,
        detail: `你的文章《${result.title}》收到了一个新的点赞！`,
      });
    } catch (e) {
      // 发送异常（DB 故障等）→ 把标记放回去，下次重新点赞还能补发。
      // 注意：作者关掉 notifyLike、或接收者不存在时 sendNotification 返回 null 而非
      // 抛错 —— 那是用户主动不要这类通知，标记保持「已发」，不该因日后改主意补发历史点赞。
      await prisma.blogLike
        .updateMany({ where: { blogId, userId }, data: { notificationSent: false } })
        .catch(() => {});
      console.warn(
        `[blog-service] 点赞成功但通知作者失败（不影响点赞结果）` +
          `（blog=${blogId} author=${result.authorId}）:`,
        e
      );
    }
  }

  return { liked: result.liked, likesCount: result.likesCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// 写路径（发文 / 改文：校验 + 日限额 + 栏目管理员专属 + 通知逻辑）。
// ─────────────────────────────────────────────────────────────────────────────

// 校验上限：前端 BlogForm.tsx 手抄了同一组数字（30 / 100 / 250000），改这里要同步改前端
export const BLOG_TITLE_MAX = 30;
export const BLOG_DESCRIPTION_MAX = 100;
export const BLOG_CONTENT_MAX = 250000; // 正文上限（放宽自 200000）
export const BLOG_DAILY_LIMIT = 20; // 每日发文上限

/** 发文 / 改文**唯一接受**的键。多一个都会被 400 顶回去，理由见 validateBlogData 里那段。 */
export const BLOG_ACCEPTED_KEYS = [
  'title',
  'description',
  'content',
  'category_id',
  'visibility',
] as const;

/**
 * 栏目字段的常见错写（一律小写比对，`categoryId` / `categoryID` 都能命中）。
 * 命中时报的错要**指路 `category_id`** —— 只回一句「未知字段」等于让调用方去猜拼法。
 */
const CATEGORY_ALIAS_KEYS = [
  'category',
  'categoryid',
  'category_ids',
  'cat_id',
  'catid',
  'category_slug',
  'category_name',
  'category_path',
  'column',
  'section',
];

export interface ValidatedBlogData {
  title: string;
  description: string;
  content: string;
  categoryId: number | null;
  /** 对外可见性。缺省 'private' —— 旧客户端不带这个字段时**不得改变**任何文章的对外状态。 */
  visibility: BlogVisibility;
}

export type ValidateBlogResult =
  | { ok: true; data: ValidatedBlogData }
  | { ok: false; message: string };

/**
 * 校验博客提交数据。
 * title/description 去空白；content 不去空白（原样取，缺字段当空串）。
 * 栏目存在性走 DB（is_active=True）。
 * 未知字段直接拒（见下），所以键集是**封闭**的：BLOG_ACCEPTED_KEYS。
 */
export async function validateBlogData(raw: unknown): Promise<ValidateBlogResult> {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '缺少必要参数' };
  const data = raw as Record<string, unknown>;

  // 未知字段直接 400，**不静默丢弃** —— 与 GET 那条 `search_fields` 同一口径
  //（见 src/app/api/blogs/route.ts 顶部）。
  //
  // 这条是被机器人踩出来的：POST 收的键叫 `category_id`，而列表接口的筛选参数叫
  // `category`（值是 slug）。照抄过来会被原样忽略 —— 请求回 200「上传成功」，
  // 文章却落进「未分类」，响应里没有任何异常。调用方不可能自查出这类错。
  const unknown = Object.keys(data).filter(
    (k) => !(BLOG_ACCEPTED_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length) {
    const alias = unknown.find((k) => CATEGORY_ALIAS_KEYS.includes(k.toLowerCase()));
    if (alias) {
      return {
        ok: false,
        message:
          `未知字段 "${alias}"：栏目要传 category_id（栏目数字 ID，` +
          '清单见 GET /api/categories）',
      };
    }
    return {
      ok: false,
      message: `未知字段 "${unknown[0]}"，本接口只接受：${BLOG_ACCEPTED_KEYS.join(' / ')}`,
    };
  }

  const title = (typeof data.title === 'string' ? data.title : '').trim();
  const description = (typeof data.description === 'string' ? data.description : '').trim();
  const content = typeof data.content === 'string' ? data.content : '';

  // 可见性：缺省 private；非白名单值直接 400，**不静默丢弃**（同下面那批未知字段）
  const visibility = parseVisibility(data.visibility);
  if (visibility === null) {
    return {
      ok: false,
      message: `可见性取值不合法，可选：${BLOG_VISIBILITIES.join(' / ')}`,
    };
  }

  if (!title) return { ok: false, message: '标题不能为空' };
  if (!description) return { ok: false, message: '描述不能为空' };
  if (!content) return { ok: false, message: '内容不能为空' };

  if (title.length > BLOG_TITLE_MAX) return { ok: false, message: `标题不能超过${BLOG_TITLE_MAX}个字符` };
  if (description.length > BLOG_DESCRIPTION_MAX)
    return { ok: false, message: `描述不能超过${BLOG_DESCRIPTION_MAX}个字符` };
  if (content.length > BLOG_CONTENT_MAX)
    return { ok: false, message: `内容不能超过${BLOG_CONTENT_MAX}个字符` };

  // 栏目校验：空值放行为“未分类”；非空则必须存在且启用
  let categoryId: number | null = null;
  const rawCat = data.category_id;
  if (rawCat) {
    const parsed = Number(rawCat);
    if (!Number.isInteger(parsed)) return { ok: false, message: '栏目ID格式错误' };
    const category = await prisma.category.findFirst({
      where: { id: parsed, isActive: true },
      select: { id: true },
    });
    if (!category) return { ok: false, message: '选择的栏目不存在' };
    categoryId = parsed;
  }

  return { ok: true, data: { title, description, content, categoryId, visibility } };
}

/**
 * 字数统计（对字符串操作）。
 * 注意：博客写路径并不持久化字数，本工具给 story 模块用（也备展示/复用）；
 * createBlog/updateBlog 不写入字数。
 */
export function countMarkdownWords(input: string): {
  total_characters: number;
  non_whitespace_characters: number;
} {
  // 清洗规则逐条见下。
  //
  // ⚠️ 关键：**只有代码块那一条**跨行匹配（[\s\S]），其余四条都是裸 `.`（不跨行）。
  // 若全用 [\s\S]，跨行内容会被多吞掉：例如 'a `x\ny` b'，
  // 本实现得 7/4（反引号不跨行，故 `x\ny` 未被当作行内代码消掉），
  // 全用 [\s\S] 则得 3/2 —— 与既有统计口径对不上。
  let content = input;
  content = content.replace(/```[\s\S]*?```/g, ''); // 代码块（唯一跨行的一条）
  content = content.replace(/`.*?`/g, ''); // 行内代码（不跨行）
  content = content.replace(/!\[.*?\]\(.*?\)/g, ''); // 图片（不跨行）
  content = content.replace(/\[(.*?)\]\(.*?\)/g, '$1'); // 链接，保留文本（不跨行）
  content = content.replace(/<.*?>/g, ''); // HTML 标签（不跨行）
  content = content.replace(/[*_~>`#\-[\]()!]/g, ''); // Markdown 特殊字符
  content = content.replace(/\s+/g, ' ').trim(); // 折叠空白
  return {
    total_characters: content.length,
    non_whitespace_characters: content.replace(/\s/g, '').length,
  };
}

/** 当日该作者已发布文章数（created_at >= 本站时区的当日零点）。 */
export async function countBlogsToday(authorId: string): Promise<number> {
  // 「当日」的零点必须用本站统一时钟（UTC+8 墙上时间，见 db-time.ts）：
  // new Date().setHours(0,0,0,0) 取的是**服务器时区**的午夜 —— 服务器 TZ 若是 UTC，
  // 零点会比 UTC+8 晚 8 小时，头 8 小时发出的文章会被算进前一天（与 audit-service
  // 申诉频控修过的同类 bug）。
  const start = dayStart(todayStr());
  return prisma.blog.count({ where: { authorId, createdAt: { gte: start } } });
}

/**
 * 栏目发文元信息：合并父栏目标志，得出“仅管理员可发”与“发文通知管理员”的最终生效值，
 * 以及完整路径（父栏目勾了，子栏目跟着生效 —— 这是发布/编辑两处共用的口径）。
 */
export async function getCategoryPostingMeta(categoryId: number) {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: {
      id: true,
      name: true,
      parentId: true,
      adminOnlyPosting: true,
      notifyAdminOnPost: true,
      parent: { select: { name: true, adminOnlyPosting: true, notifyAdminOnPost: true } },
    },
  });
  if (!category) {
    return { category: null, adminOnlyEffective: false, notifyEffective: false, fullPath: '' };
  }
  const parent = category.parent;
  const adminOnlyEffective = parent
    ? Boolean(category.adminOnlyPosting || parent.adminOnlyPosting)
    : Boolean(category.adminOnlyPosting);
  let notifyEffective = Boolean(category.notifyAdminOnPost);
  if (parent) notifyEffective = notifyEffective || Boolean(parent.notifyAdminOnPost);
  const fullPath =
    category.parentId != null && parent ? `${parent.name} > ${category.name}` : category.name;
  return { category, adminOnlyEffective, notifyEffective, fullPath };
}

/** 禁言时的操作错误文案（剩余时长 + 原因，全站禁言提示共用这一份）。 */
export function banActionMessage(user: { banUntil?: Date | null; banReason?: string | null }): string {
  let remainingText = '';
  if (user.banUntil) {
    // 必须走 hoursUntil（nowForDb 口径）—— banUntil 是「UTC+8 墙上时间贴 Z」，
    // 拿真实 UTC 的 Date.now() 相减会多报 8 小时。见 src/lib/db-time.ts。
    const remainingHours = hoursUntil(user.banUntil) ?? 0;
    remainingText =
      remainingHours > 24
        ? `剩余约${(remainingHours / 24).toFixed(1)}天`
        : `剩余约${remainingHours.toFixed(1)}小时`;
  }
  const reason = user.banReason ?? '未说明';
  return `您已被禁言，无法执行此操作。${remainingText}。原因：${reason}`;
}

/**
 * 栏目层级（供发布/编辑页下拉：仅 is_active，按 sort_order，与前台树同口径）。
 *
 * 除下拉要的三个字段外还选出了 `slug` 与 `adminOnlyPosting` —— 供下面的
 * `listCategoryOptions` 摊平用。**两处共用这一份查询**是刻意的：「只取 is_active、
 * 按 sort_order」这条口径若抄成两份，改了其中一份就是下拉与对外清单不一致。
 * 表单只取它认识的字段，多出来的不影响它。
 */
export async function getCategoryHierarchy() {
  const roots = await prisma.category.findMany({
    where: { parentId: null, isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      slug: true,
      icon: true,
      adminOnlyPosting: true,
      children: {
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          icon: true,
          adminOnlyPosting: true,
        },
      },
    },
  });
  return roots;
}

export type CategoryHierarchy = Awaited<ReturnType<typeof getCategoryHierarchy>>;

/**
 * 栏目清单（`GET /api/categories` 用）：把两层树**摊平**成一张表。
 *
 * 摊平是刻意的 —— 调用方（机器人）要回答的是「我该往 `category_id` 里填哪个数」，
 * 扁平表直接扫一遍就有答案，嵌套树还得自己递归。
 *
 * · `path` 用 `categoryFullPath` 的同一口径（`父 > 子`），与 `GET /api/blogs`
 *   回的 `category_path` 一致；
 * · `admin_only_posting` 是**生效值**（子栏目继承父栏目）—— 与发文那道 403
 *   闸门（`getCategoryPostingMeta`）同一规则。带上它，调用方挑栏目时就能自己
 *   避开那些一定会被拒的，而不是发出去再收一个 403。
 */
export async function listCategoryOptions() {
  const roots = await getCategoryHierarchy();
  return roots.flatMap((root) => [
    {
      id: root.id,
      name: root.name,
      slug: root.slug,
      icon: root.icon ?? '',
      parent_id: null,
      path: categoryFullPath({ name: root.name, parentId: null, parent: null }),
      admin_only_posting: Boolean(root.adminOnlyPosting),
    },
    ...root.children.map((child) => ({
      id: child.id,
      name: child.name,
      slug: child.slug,
      icon: child.icon ?? '',
      parent_id: root.id,
      path: categoryFullPath({
        name: child.name,
        parentId: root.id,
        parent: { name: root.name },
      }),
      admin_only_posting: Boolean(child.adminOnlyPosting || root.adminOnlyPosting),
    })),
  ]);
}

export type CategoryOption = Awaited<ReturnType<typeof listCategoryOptions>>[number];

/** 编辑页数据：ignore=true 视为不存在（软删的文章不可编辑）。 */
export async function getBlogForEdit(blogId: string) {
  const blog = await prisma.blog.findFirst({
    where: { id: blogId, ignore: false },
    select: {
      id: true,
      title: true,
      description: true,
      categoryId: true,
      authorId: true,
      visibility: true,
      content: { select: { content: true } },
    },
  });
  if (!blog) return null;
  return {
    id: blog.id,
    title: blog.title,
    description: blog.description,
    categoryId: blog.categoryId,
    // 归一化到白名单：列是 TEXT（SQLite 没有 enum），而编辑表单的下拉框必须有一个
    // 对得上的选项 —— 给个白名单外的值会让 `defaultValue` 落空、浏览器默认选第一项，
    // 于是「打开编辑页什么都不改、一保存就静默改了可见性」。唯一的写入口
    // （validateBlogData）已经在白名单上，这里只是兜底。
    visibility: parseVisibility(blog.visibility) ?? 'private',
    authorId: blog.authorId,
    contentMarkdown: blog.content?.content ?? '',
  };
}

/**
 * 创建博客：UUID 主键，Blog + BlogContent 同事务写（正文缺一条就是空文章，不能分两次提交）。
 * 未分类栏目 categoryId=null；is_featured 走 schema 默认 false（不显式设置）。
 * 磁盘 instance/blogs/<id> 目录是历史遗留物（旧数据残留），正文已入库，本站不再创建。
 */
export async function createBlog(authorId: string, data: ValidatedBlogData): Promise<string> {
  const blogId = crypto.randomUUID();
  const now = nowForDb();
  await prisma.$transaction([
    prisma.blog.create({
      data: {
        id: blogId,
        title: data.title,
        description: data.description,
        authorId,
        categoryId: data.categoryId,
        visibility: data.visibility,
        createdAt: now,
      },
    }),
    prisma.blogContent.create({ data: { blogId, content: data.content, updatedAt: now } }),
  ]);
  return blogId;
}

/**
 * 更新博客：逐字段比对生成 changesDetail（改了什么就记什么，供「文章已编辑」通知用），
 * 更新元信息并 upsert 正文。文章不存在时返回 hasChanges:false（不抛错，路由已先判过存在性）。
 */
export async function updateBlog(
  blogId: string,
  data: ValidatedBlogData
): Promise<{ hasChanges: boolean; changesDetail: string[] }> {
  const blog = await prisma.blog.findUnique({
    where: { id: blogId },
    select: {
      title: true,
      description: true,
      categoryId: true,
      visibility: true,
      category: { select: { name: true } },
    },
  });
  if (!blog) return { hasChanges: false, changesDetail: [] };

  let hasChanges = false;
  const changesDetail: string[] = [];

  if (blog.title !== data.title) {
    changesDetail.push(`标题从《${blog.title}》改为《${data.title}》`);
    hasChanges = true;
  }

  // 可见性变化要单独记一条：它是**不可逆**的那类改动（一旦 public 被搜索引擎或第三方
  // 存档抓走，改回 private 也收不回来），所以「文章已编辑」的通知里必须看得见它 ——
  // 只记「内容已更新」会让作者与管理员都错过这条最要紧的变更。
  if (blog.visibility !== data.visibility) {
    changesDetail.push(
      `可见性从《${VISIBILITY_LABEL[blog.visibility as BlogVisibility] ?? blog.visibility}》` +
        `改为《${VISIBILITY_LABEL[data.visibility]}》`
    );
    hasChanges = true;
  }
  if (blog.description !== data.description) {
    changesDetail.push('摘要已更新');
    hasChanges = true;
  }

  // 栏目变化描述（新旧栏目名，缺省“未分类”）
  const oldCategoryName = blog.category?.name ?? '未分类';
  let newCategoryName = '未分类';
  if (data.categoryId != null) {
    const newCat = await prisma.category.findUnique({
      where: { id: data.categoryId },
      select: { name: true },
    });
    if (newCat) newCategoryName = newCat.name;
  }
  if (blog.categoryId !== data.categoryId) {
    changesDetail.push(`栏目从《${oldCategoryName}》改为《${newCategoryName}》`);
    hasChanges = true;
  }

  // 正文变化
  const contentRow = await prisma.blogContent.findUnique({
    where: { blogId },
    select: { content: true },
  });
  const oldContent = contentRow?.content ?? '';
  if (oldContent !== data.content) {
    changesDetail.push('文章内容已更新');
    hasChanges = true;
  }

  const now = nowForDb();
  await prisma.$transaction([
    prisma.blog.update({
      where: { id: blogId },
      data: {
        title: data.title,
        description: data.description,
        categoryId: data.categoryId,
        visibility: data.visibility,
      },
    }),
    prisma.blogContent.upsert({
      where: { blogId },
      create: { blogId, content: data.content, updatedAt: now },
      update: { content: data.content, updatedAt: now },
    }),
  ]);

  return { hasChanges, changesDetail };
}
