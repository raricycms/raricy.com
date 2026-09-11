// ─────────────────────────────────────────────────────────────────────────────
// admin-blog-service.ts — 文章管理业务逻辑（对齐 Flask BlogService 管理端方法）
//
// 与用户端 blog-service 不同：管理端列出**所有**文章（含 ignore=true 软删除）。
// 提供精选切换、软删除/恢复（ignore 字段）、改栏目。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import type { Prisma } from '@prisma/client';
import type { ServiceResult } from './admin-category-service';
import { logAdminAction, type AdminResult } from './admin-user-service';

export interface AdminListParams {
  page?: number;
  perPage?: number;
  categoryId?: number | null; // -1 表示未分类；null/undefined 表示不筛选
  search?: string | null;
  status?: 'all' | 'active' | 'deleted'; // active=未软删, deleted=已软删
  /**
   * 搜索范围。**默认 'title'** —— /admin/blogs 页面的现有行为因此不受影响。
   * 'all' 才加上描述、正文（BlogContent）、作者用户名与精确 id，
   * 运维 CLI 用这个（「我记得正文里写过某个词，但不记得标题」）。
   * ★ 做成 opt-in 而不是直接放宽：那会悄悄改变网页后台的搜索结果集。
   */
  searchScope?: 'title' | 'all';
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
    const q = params.search.trim();
    if (params.searchScope === 'all') {
      where.OR = [
        { title: { contains: q } },
        { description: { contains: q } },
        { id: q }, // 直接粘一个 UUID 精确命中
        { author: { is: { username: { contains: q } } } },
        // 正文在 1:1 的 BlogContent 表里，要跨表过滤
        { content: { is: { content: { contains: q } } } },
      ];
    } else {
      where.title = { contains: q };
    }
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

/**
 * 恢复软删的文章（ignore=false）+ 审计日志。
 *
 * 与 setBlogIgnore(id,false) 的区别只有审计那一笔 —— 但那一笔正是关键：
 * 网页端的「恢复」入口此前也不写日志，运维 CLI 删了再恢复在 /audit 上是**不可见**的。
 *
 * 注：恢复文章**不需要**连带恢复评论 —— 删文章从来没动过评论（BlogComment 的
 * isDeleted 一直是 false，只是随文章一起从列表里消失了）。
 */
export async function restoreBlog(
  blogId: string,
  actor: { id: string; role: string },
  reason?: string
): Promise<AdminResult<{ id: string }>> {
  const blog = await prisma.blog.findUnique({
    where: { id: blogId },
    select: { id: true, authorId: true, ignore: true },
  });
  if (!blog) return { ok: false, code: 404, message: '文章不存在' };
  if (!blog.ignore) return { ok: false, code: 400, message: '该文章未被删除' };

  await prisma.blog.update({ where: { id: blogId }, data: { ignore: false } });

  try {
    await logAdminAction({
      action: 'restore_blog',
      adminId: actor.id,
      targetUserId: blog.authorId,
      objectType: 'blog',
      objectId: blogId,
      reason: (reason ?? '').trim() || null,
    });
  } catch {
    /* 审计写入失败不影响恢复结果 */
  }

  return { ok: true, message: '已恢复文章', id: blogId };
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
