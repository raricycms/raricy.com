// ─────────────────────────────────────────────────────────────────────────────
// blog-service.ts — 博客业务逻辑（对齐 Flask app/web/blog/services/BlogService）
//
// 与 Flask 解耦风格一致：纯函数 + 显式参数，方便测试与复用。
// 软删除：Blog.ignore = true 的一律排除（对齐 CLAUDE.md 的软删除约定）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
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

  if (params.featured) where.isFeatured = true;

  // 分类过滤：命中该分类或其子分类；否则按“全部文章”排除 exclude_from_all 的分类
  if (params.categorySlug) {
    const cat = await prisma.category.findUnique({
      where: { slug: params.categorySlug },
      select: { id: true, children: { select: { id: true } } },
    });
    if (cat) {
      const ids = [cat.id, ...cat.children.map((c) => c.id)];
      where.categoryId = { in: ids };
    } else {
      where.categoryId = -1; // 不存在的分类 → 空结果
    }
  } else if (!params.featured) {
    const excluded = await prisma.category.findMany({
      where: { excludeFromAll: true },
      select: { id: true },
    });
    if (excluded.length) where.categoryId = { notIn: excluded.map((c) => c.id) };
  }

  if (params.search && params.search.trim()) {
    const q = params.search.trim();
    where.OR = [
      { title: { contains: q } },
      { description: { contains: q } },
      { author: { is: { username: { contains: q } } } },
    ];
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
  const hourly = rateLimit(`like:h:${userId}`, RULES.likeHourly);
  const daily = rateLimit(`like:d:${userId}`, RULES.likeDaily);
  if (!hourly.allowed || !daily.allowed) {
    return { rateLimited: true as const };
  }

  return prisma.$transaction(async (tx) => {
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
        data: { deleted: !liked, deletedAt: liked ? null : new Date() },
      });
    }

    const likesCount = await tx.blogLike.count({ where: { blogId, deleted: false } });
    await tx.blog.update({ where: { id: blogId }, data: { likesCount } });
    return { liked, likesCount };
  });
}
