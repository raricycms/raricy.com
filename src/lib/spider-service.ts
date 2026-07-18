// ─────────────────────────────────────────────────────────────────────────────
// spider-service.ts — 爬虫（搜索引擎）只读 API 业务逻辑
//
// 忠实移植 Flask app/web/blog/spider_api.py（无认证，供搜索引擎抓取，刻意为之）：
//   - getSpiderBlog     ← BlogService.get_blog_detail（对齐 Blog.to_dict + content/liked/user_fed）
//   - getRecentComments ← CommentService.get_recent_comments（status='approved' 最近 100 条，含已删除占位）
//   - getSpiderComment  ← CommentService.get_comment（id + is_deleted=false）
//
// 评论序列化形状与 comment-service.ts 的 serializeRow 逐字对齐（snake_case JSON），
// 单独在此实现是为了产出「扁平（children 恒为 []）」的列表/单条结果。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { hasAdminRights } from './auth';
import { categoryFullPath, ymd } from './format';
import type { Prisma } from '@prisma/client';

// ── 评论扁平序列化（对齐 CommentService._serialize_comment）───────────────────

export interface SpiderCommentDict {
  id: string;
  blog_id: string;
  author: {
    id: string | null;
    username: string | null;
    is_admin: boolean;
    avatar_url: string | null;
  };
  parent_id: string | null;
  root_id: string | null;
  content_html: string;
  status: string | null;
  is_deleted: boolean;
  likes_count: number;
  created_at: string | null;
  updated_at: string | null;
  children: SpiderCommentDict[];
}

const DELETED_PLACEHOLDER = '[该评论已删除]';

const commentSelect = {
  id: true,
  blogId: true,
  parentId: true,
  rootId: true,
  contentHtml: true,
  status: true,
  isDeleted: true,
  likesCount: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, username: true, role: true } },
} satisfies Prisma.BlogCommentSelect;

type CommentRow = Prisma.BlogCommentGetPayload<{ select: typeof commentSelect }>;

function serializeComment(c: CommentRow): SpiderCommentDict {
  const deleted = c.isDeleted ?? false;
  return {
    id: c.id,
    blog_id: c.blogId,
    author: {
      id: c.author?.id ?? null,
      username: c.author?.username ?? null,
      is_admin: c.author ? hasAdminRights(c.author) : false,
      avatar_url: c.author ? `/api/avatar/${c.author.id}` : null,
    },
    parent_id: c.parentId,
    root_id: c.rootId,
    content_html: deleted ? DELETED_PLACEHOLDER : c.contentHtml ?? '',
    status: c.status,
    is_deleted: deleted,
    likes_count: c.likesCount ?? 0,
    created_at: c.createdAt ? c.createdAt.toISOString() : null,
    updated_at: c.updatedAt ? c.updatedAt.toISOString() : null,
    children: [], // 由构建树方法填充；扁平输出恒为空数组（对齐 Flask）
  };
}

/**
 * 最近评论（对齐 CommentService.get_recent_comments）：
 * status='approved'，按 created_at 倒序，最多 limit 条。
 * 注意：不过滤 is_deleted —— 已删除但已批准的评论也会出现（content_html 为占位符）。
 */
export async function getRecentComments(limit = 100): Promise<SpiderCommentDict[]> {
  const rows = await prisma.blogComment.findMany({
    where: { status: 'approved' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: commentSelect,
  });
  return rows.map(serializeComment);
}

/**
 * 单条评论（对齐 CommentService.get_comment）：id 命中且未删除才返回，否则 null。
 */
export async function getSpiderComment(commentId: string): Promise<SpiderCommentDict | null> {
  const row = await prisma.blogComment.findFirst({
    where: { id: commentId, isDeleted: false },
    select: commentSelect,
  });
  if (!row) return null;
  return serializeComment(row);
}

// ── 博客详情（对齐 BlogService.get_blog_detail + Blog.to_dict）─────────────────

export interface SpiderBlogMeta {
  id: string;
  title: string;
  description: string;
  author_id: string;
  author: string | null;
  date: string | null;
  ignore: boolean;
  likes_count: number;
  comments_count: number;
  fish_count: number;
  category_id: number | null;
  category: string | null;
  category_path: string | null;
  is_featured: boolean;
  content: string;
  liked: boolean;
  user_fed: boolean;
}

export interface SpiderBlogResult {
  meta: SpiderBlogMeta;
  content: string;
}

/**
 * 博客详情（对齐 BlogService.get_blog_detail）：
 * blog 不存在或 ignore=true → null（Flask 侧 abort(404)）。
 * 爬虫无认证，current_user 未登录 → liked / user_fed 恒为 false。
 */
export async function getSpiderBlog(blogId: string): Promise<SpiderBlogResult | null> {
  const blog = await prisma.blog.findFirst({
    where: { id: blogId, ignore: false },
    select: {
      id: true,
      title: true,
      description: true,
      authorId: true,
      createdAt: true,
      ignore: true,
      likesCount: true,
      commentsCount: true,
      fishCount: true,
      categoryId: true,
      isFeatured: true,
      author: { select: { username: true } },
      category: { select: { name: true, parentId: true, parent: { select: { name: true } } } },
      content: { select: { content: true } },
    },
  });
  if (!blog) return null;

  const content = blog.content?.content ?? '';
  const meta: SpiderBlogMeta = {
    id: blog.id,
    title: blog.title,
    description: blog.description,
    author_id: blog.authorId,
    author: blog.author?.username ?? null,
    date: ymd(blog.createdAt),
    ignore: blog.ignore ?? false,
    likes_count: blog.likesCount ?? 0,
    comments_count: blog.commentsCount ?? 0,
    fish_count: blog.fishCount ?? 0,
    category_id: blog.categoryId,
    category: blog.category?.name ?? null,
    category_path: blog.category ? categoryFullPath(blog.category) : null,
    is_featured: blog.isFeatured ?? false,
    content, // 对齐 get_blog_detail：blog_dict['content'] = content
    liked: false, // 爬虫无认证
    user_fed: false, // 爬虫无认证
  };

  return { meta, content };
}
