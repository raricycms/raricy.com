// ─────────────────────────────────────────────────────────────────────────────
// blog-service.ts — 博客业务逻辑（对齐 Flask app/web/blog/services/BlogService）
//
// 与 Flask 解耦风格一致：纯函数 + 显式参数，方便测试与复用。
// 软删除：Blog.ignore = true 的一律排除（对齐 CLAUDE.md 的软删除约定）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { rateLimit, RULES } from './rate-limit';
import type { Prisma } from '@prisma/client';

export interface ListParams {
  page?: number;
  perPage?: number;
  categorySlug?: string | null;
  featured?: boolean;
  search?: string | null;
}

const DEFAULT_PER_PAGE = 10;

export async function listBlogs(params: ListParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(50, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));

  const where: Prisma.BlogWhereInput = { ignore: false };

  // 精选筛选：对齐 Flask `if featured in (True, False)` —— **false 也生效**（筛出非精选）。
  // 写成 `if (params.featured)` 会让 featured=false 等同于不传，丢掉「只看非精选」的语义。
  if (params.featured !== undefined && params.featured !== null) {
    where.isFeatured = params.featured;
  }

  if (params.categorySlug) {
    // 指定栏目：命中该栏目或其子栏目。
    // isActive 过滤对齐 Flask `filter_by(slug=..., is_active=True)` 与
    // `children.filter_by(is_active=True)` —— 停用栏目下的文章不应能通过 slug 直接访问。
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
    // 「全部文章」：排除 exclude_from_all 的栏目**及其子栏目**。
    // 对齐 Flask：
    //   excluded = Category.filter_by(exclude_from_all=True, is_active=True)
    //   for ec in excluded: ids += [ec.id] + [child.id for child in ec.children if is_active]
    //   query.filter((Blog.category_id.is_(None)) | (~Blog.category_id.in_(ids)))
    //
    // ⚠️ 两个易错点：
    //  1. **必须显式保住 category_id IS NULL** —— SQL 里 `NULL NOT IN (...)` 求值为 NULL，
    //     只写 notIn 会把「未分类」文章一并滤掉。实测：只要站内存在任意一个
    //     exclude_from_all 栏目，所有未分类文章就从首页消失。
    //  2. 该排除与 featured 无关（Flask 只看有没有传 category_slug）。写成
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

  if (params.search && params.search.trim()) {
    const q = params.search.trim();
    // 用 AND 承载，避免与上面「保住 NULL」的 OR 互相覆盖（两者都写 where.OR 会后者胜出）。
    const searchOr: Prisma.BlogWhereInput = {
      OR: [
        { title: { contains: q } },
        { description: { contains: q } },
        { author: { is: { username: { contains: q } } } },
      ],
    };
    where.AND = Array.isArray(where.AND) ? [...where.AND, searchOr] : [searchOr];
  }

  const [total, blogs] = await Promise.all([
    prisma.blog.count({ where }),
    prisma.blog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
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
      },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { blogs, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

export async function getBlogDetail(id: string) {
  const blog = await prisma.blog.findFirst({
    where: { id, ignore: false },
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
      author: { select: { id: true, username: true } },
      category: { select: { name: true, slug: true, parentId: true, parent: { select: { name: true } } } },
      content: { select: { content: true, updatedAt: true } },
    },
  });
  return blog;
}

/**
 * 点赞切换（对齐 LikeService）：唯一约束 (blog_id,user_id) + 软删除 deleted 字段，
 * 计数在事务内原子增减。附带内存限频（100/时、500/天）。
 */
export async function toggleLike(blogId: string, userId: string) {
  // 【先查存在性，再扣限频】对齐 Flask 的顺序。
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

  return prisma.$transaction(async (tx) => {
    // 事务内再确认一次（并发下文章可能刚被软删）
    const blog = await tx.blog.findFirst({ where: { id: blogId, ignore: false }, select: { id: true } });
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

    const likesCount = await tx.blogLike.count({ where: { blogId, deleted: false } });
    await tx.blog.update({ where: { id: blogId }, data: { likesCount } });
    return { liked, likesCount };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 写路径（对齐 Flask BlogService.create_blog / update_blog + BlogValidator +
// upload_blog / edit_blog 视图里的日限额、栏目管理员专属、通知逻辑）。
// ─────────────────────────────────────────────────────────────────────────────

// 对齐 BlogValidator 常量
export const BLOG_TITLE_MAX = 30; // MAX_TITLE_LENGTH
export const BLOG_DESCRIPTION_MAX = 100; // MAX_DESCRIPTION_LENGTH
export const BLOG_CONTENT_MAX = 200000; // MAX_CONTENT_LENGTH（服务端强校验；前端另有 250000 的软提示）
export const BLOG_DAILY_LIMIT = 20; // upload_blog 视图里的每日发文上限

export interface ValidatedBlogData {
  title: string;
  description: string;
  content: string;
  categoryId: number | null;
}

export type ValidateBlogResult =
  | { ok: true; data: ValidatedBlogData }
  | { ok: false; message: string };

/**
 * 校验博客提交数据（对齐 BlogValidator.validate_blog_data）。
 * title/description 去空白；content 不去空白（对齐 `data.get('content') or ''`）。
 * 栏目存在性走 DB（is_active=True）。
 */
export async function validateBlogData(raw: unknown): Promise<ValidateBlogResult> {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '缺少必要参数' };
  const data = raw as Record<string, unknown>;

  const title = (typeof data.title === 'string' ? data.title : '').trim();
  const description = (typeof data.description === 'string' ? data.description : '').trim();
  const content = typeof data.content === 'string' ? data.content : '';

  if (!title) return { ok: false, message: '标题不能为空' };
  if (!description) return { ok: false, message: '描述不能为空' };
  if (!content) return { ok: false, message: '内容不能为空' };

  if (title.length > BLOG_TITLE_MAX) return { ok: false, message: `标题不能超过${BLOG_TITLE_MAX}个字符` };
  if (description.length > BLOG_DESCRIPTION_MAX)
    return { ok: false, message: `描述不能超过${BLOG_DESCRIPTION_MAX}个字符` };
  if (content.length > BLOG_CONTENT_MAX)
    return { ok: false, message: `内容不能超过${BLOG_CONTENT_MAX}个字符` };

  // 栏目校验：空值放行为“未分类”；非空则必须存在且启用（对齐 int() + is_active 查询）
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

  return { ok: true, data: { title, description, content, categoryId } };
}

/**
 * 字数统计（对齐 app/utils/markdown_countword.py，改为对字符串操作）。
 * 注意：Flask 博客写路径并不持久化字数，仅 story 模块使用此工具；此处按 brief 要求
 * 提供等价实现以备展示/复用，createBlog/updateBlog 不写入字数（与 Flask 一致）。
 */
export function countMarkdownWords(input: string): {
  total_characters: number;
  non_whitespace_characters: number;
} {
  // 逐条对齐 app/utils/markdown_countword.py。
  //
  // ⚠️ 关键：Python 侧**只有代码块那一条**加了 re.DOTALL，其余四条都是裸 `.`（不跨行）。
  // JS 的 `.` 默认同样不跨行，故只有代码块该用 [\s\S]，其余必须保持 `.`。
  // 若全用 [\s\S]，跨行内容会被多吞掉：例如 'a `x\ny` b'，
  // Python 得 7/4（反引号不跨行，故 `x\ny` 未被当作行内代码消掉），
  // 全用 [\s\S] 则得 3/2 —— 字数对不上。
  let content = input;
  content = content.replace(/```[\s\S]*?```/g, ''); // 代码块（Python 这条有 DOTALL）
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

/** 当日该作者已发布文章数（对齐 upload_blog：created_at >= 本地零点）。 */
export async function countBlogsToday(authorId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return prisma.blog.count({ where: { authorId, createdAt: { gte: start } } });
}

/**
 * 栏目发文元信息：合并父栏目标志，得出“仅管理员可发”与“发文通知管理员”的最终生效值，
 * 以及完整路径（对齐 upload_blog / edit_blog 里的 admin_only_effective / notify_effective /
 * Category.get_full_path）。
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

/** 禁言时的操作错误文案（对齐 ban_check.check_user_ban_status 生成的 message）。 */
export function banActionMessage(user: { banUntil: Date | null; banReason: string | null }): string {
  let remainingText = '';
  if (user.banUntil) {
    const remainingHours = (user.banUntil.getTime() - Date.now()) / 3600000;
    remainingText =
      remainingHours > 24
        ? `剩余约${(remainingHours / 24).toFixed(1)}天`
        : `剩余约${remainingHours.toFixed(1)}小时`;
  }
  const reason = user.banReason ?? '未说明';
  return `您已被禁言，无法执行此操作。${remainingText}。原因：${reason}`;
}

/** 栏目层级（供发布/编辑页下拉，对齐 Category.get_hierarchy：仅 is_active，按 sort_order）。 */
export async function getCategoryHierarchy() {
  const roots = await prisma.category.findMany({
    where: { parentId: null, isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      icon: true,
      children: {
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, icon: true },
      },
    },
  });
  return roots;
}

export type CategoryHierarchy = Awaited<ReturnType<typeof getCategoryHierarchy>>;

/** 编辑页数据（对齐 BlogService.get_blog_for_edit）：ignore=true 视为不存在。 */
export async function getBlogForEdit(blogId: string) {
  const blog = await prisma.blog.findFirst({
    where: { id: blogId, ignore: false },
    select: {
      id: true,
      title: true,
      description: true,
      categoryId: true,
      authorId: true,
      content: { select: { content: true } },
    },
  });
  if (!blog) return null;
  return {
    id: blog.id,
    title: blog.title,
    description: blog.description,
    categoryId: blog.categoryId,
    authorId: blog.authorId,
    contentMarkdown: blog.content?.content ?? '',
  };
}

/**
 * 创建博客（对齐 BlogService.create_blog）：UUID 主键，Blog + BlogContent 同事务写。
 * 未分类栏目 categoryId=null；is_featured 走 schema 默认 false（Flask 亦不显式设置）。
 * 磁盘 instance/blogs/<id> 目录为 Flask 遗留物，正文已入库，Next 侧不再创建。
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
        createdAt: now,
      },
    }),
    prisma.blogContent.create({ data: { blogId, content: data.content, updatedAt: now } }),
  ]);
  return blogId;
}

/**
 * 更新博客（对齐 BlogService.update_blog）：逐字段比对生成 changesDetail，
 * 更新元信息并 upsert 正文。返回 null 表示文章不存在（对齐 (False, [])）。
 */
export async function updateBlog(
  blogId: string,
  data: ValidatedBlogData
): Promise<{ hasChanges: boolean; changesDetail: string[] }> {
  const blog = await prisma.blog.findUnique({
    where: { id: blogId },
    select: { title: true, description: true, categoryId: true, category: { select: { name: true } } },
  });
  if (!blog) return { hasChanges: false, changesDetail: [] };

  let hasChanges = false;
  const changesDetail: string[] = [];

  if (blog.title !== data.title) {
    changesDetail.push(`标题从《${blog.title}》改为《${data.title}》`);
    hasChanges = true;
  }
  if (blog.description !== data.description) {
    changesDetail.push('摘要已更新');
    hasChanges = true;
  }

  // 栏目变化描述（对齐 old_category_name / new_category_name，缺省“未分类”）
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
      data: { title: data.title, description: data.description, categoryId: data.categoryId },
    }),
    prisma.blogContent.upsert({
      where: { blogId },
      create: { blogId, content: data.content, updatedAt: now },
      update: { content: data.content, updatedAt: now },
    }),
  ]);

  return { hasChanges, changesDetail };
}
