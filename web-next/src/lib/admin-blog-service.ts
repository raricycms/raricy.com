// ─────────────────────────────────────────────────────────────────────────────
// admin-blog-service.ts — 文章管理业务逻辑（对齐 Flask BlogService 管理端方法）
//
// 与用户端 blog-service 不同：管理端列出**所有**文章（含 ignore=true 软删除）。
// 提供精选切换、软删除/恢复（ignore 字段）、改栏目。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import type { Prisma } from '@prisma/client';
import type { ServiceResult } from './admin-category-service';

export interface AdminListParams {
  page?: number;
  perPage?: number;
  categoryId?: number | null; // -1 表示未分类；null/undefined 表示不筛选
  search?: string | null;
  status?: 'all' | 'active' | 'deleted'; // active=未软删, deleted=已软删
}

const DEFAULT_PER_PAGE = 20;

export async function listAdminBlogs(params: AdminListParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));

  const where: Prisma.BlogWhereInput = {};

  if (params.status === 'active') where.ignore = false;
  else if (params.status === 'deleted') where.ignore = true;
  // status='all' 或未指定：不过滤 ignore

  if (params.categoryId === -1) where.categoryId = null;
  else if (params.categoryId != null) where.categoryId = params.categoryId;

  if (params.search && params.search.trim()) {
    where.title = { contains: params.search.trim() };
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
        ignore: true,
        isFeatured: true,
        likesCount: true,
        commentsCount: true,
        fishCount: true,
        categoryId: true,
        authorId: true,
        author: { select: { username: true } },
        category: {
          select: { id: true, name: true, parentId: true, parent: { select: { name: true } } },
        },
      },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { blogs, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

/** 设置精选状态（对齐 BlogService.update_featured）。 */
export async function setBlogFeatured(
  blogId: string,
  isFeatured: boolean
): Promise<ServiceResult<{ id: string; isFeatured: boolean }>> {
  const blog = await prisma.blog.findUnique({ where: { id: blogId }, select: { id: true } });
  if (!blog) return { ok: false, message: '文章不存在' };
  await prisma.blog.update({ where: { id: blogId }, data: { isFeatured } });
  return { ok: true, data: { id: blogId, isFeatured } };
}

/** 软删除 / 恢复（ignore 字段）。 */
export async function setBlogIgnore(
  blogId: string,
  ignore: boolean
): Promise<ServiceResult<{ id: string; ignore: boolean }>> {
  const blog = await prisma.blog.findUnique({ where: { id: blogId }, select: { id: true } });
  if (!blog) return { ok: false, message: '文章不存在' };
  await prisma.blog.update({ where: { id: blogId }, data: { ignore } });
  return { ok: true, data: { id: blogId, ignore } };
}

/** 改栏目（对齐 CategoryService.update_article_category）。categoryId=null → 未分类。 */
export async function setBlogCategory(
  blogId: string,
  categoryId: number | null
): Promise<ServiceResult<{ id: string; categoryId: number | null; categoryName: string }>> {
  const blog = await prisma.blog.findUnique({ where: { id: blogId }, select: { id: true } });
  if (!blog) return { ok: false, message: '文章不存在' };

  if (categoryId != null) {
    const cat = await prisma.category.findFirst({
      where: { id: categoryId, isActive: true },
      select: { id: true },
    });
    if (!cat) return { ok: false, message: '选择的栏目不存在' };
  }

  await prisma.blog.update({ where: { id: blogId }, data: { categoryId } });
  const name = categoryId != null
    ? (await prisma.category.findUnique({ where: { id: categoryId }, select: { name: true } }))?.name ?? '未分类'
    : '未分类';
  return { ok: true, data: { id: blogId, categoryId, categoryName: name } };
}
