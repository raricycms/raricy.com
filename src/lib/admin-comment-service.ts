// ─────────────────────────────────────────────────────────────────────────────
// admin-comment-service.ts — 评论的管理端检索（**含已软删**）
//
// 【为什么不塞进 comment-service】comment-service 是面向读者与作者的业务逻辑
// （楼中楼树、序列化、点赞、软删除…），过滤口径是「读者能看见什么」。管理端检索
// 是另一件事：它要能看见**被删的**东西（否则「找回误删」无从谈起），还要按作者、
// 所属文章、关键词筛。口径不同，放一起迟早互相污染。
//
// 【列表不返回 contentHtml】它是服务端转义过的 HTML，列表里用不上，而且会让
// 每行载荷翻倍。正文预览用 content 就够了。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import type { Prisma } from '@prisma/client';

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

export interface AdminCommentListParams {
  page?: number;
  perPage?: number;
  /** 关键词：匹配正文 / 作者用户名 / 所属文章标题。 */
  search?: string | null;
  /** 只看某篇文章下的评论。 */
  blogId?: string | null;
  /** 三态，语义与 listAdminBlogs 的 status 完全一致。 */
  status?: 'all' | 'active' | 'deleted';
}

/**
 * 管理端评论列表。
 *
 * 搜索用 SQLite 的 LIKE（`contains`）—— 全表扫描。这是个个人站点的运维工具，
 * 可接受；真要快了得上 FTS5。
 */
export async function listAdminComments(params: AdminCommentListParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, params.perPage ?? DEFAULT_PER_PAGE));

  const where: Prisma.BlogCommentWhereInput = {};
  if (params.status === 'active') where.isDeleted = false;
  else if (params.status === 'deleted') where.isDeleted = true;
  // status='all' 或未指定：不过滤 isDeleted

  if (params.blogId) where.blogId = params.blogId;

  const q = (params.search ?? '').trim();
  if (q) {
    where.OR = [
      { content: { contains: q } },
      { author: { is: { username: { contains: q } } } },
      { blog: { is: { title: { contains: q } } } },
    ];
  }

  const [total, comments] = await Promise.all([
    prisma.blogComment.count({ where }),
    prisma.blogComment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        blogId: true,
        authorId: true,
        parentId: true,
        content: true,
        status: true,
        isDeleted: true,
        likesCount: true,
        createdAt: true,
        author: { select: { username: true } },
        blog: { select: { title: true, ignore: true } },
      },
    }),
  ]);

  const pages = Math.max(1, Math.ceil(total / perPage));
  return { comments, total, page, perPage, pages, hasPrev: page > 1, hasNext: page < pages };
}

/** 单条评论的管理端详情（确认屏用）。不过滤 isDeleted —— 要恢复的正是被删的那些。 */
export async function getCommentForAdmin(id: string) {
  return prisma.blogComment.findUnique({
    where: { id },
    select: {
      id: true,
      blogId: true,
      authorId: true,
      parentId: true,
      content: true,
      status: true,
      isDeleted: true,
      likesCount: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { username: true } },
      blog: { select: { title: true, ignore: true } },
    },
  });
}
