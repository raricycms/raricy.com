// ─────────────────────────────────────────────────────────────────────────────
// spider-service.ts — 爬虫（搜索引擎）只读 API 业务逻辑
//
// 忠实移植 Flask app/web/blog/spider_api.py（无认证，供搜索引擎抓取，刻意为之）：
//   - getSpiderBlog     ← BlogService.get_blog_detail（对齐 Blog.to_dict + content/liked/user_fed）
//   - getRecentComments ← CommentService.get_recent_comments（status='approved' 最近 100 条，含已删除占位）
//   - getSpiderComment  ← CommentService.get_comment（id + is_deleted=false）
//
// 评论的**公共字段**序列化复用 comment-service.serializeCommentBase —— 两边各写一份
// 逐字相同的实现，改了一处另一边不会变，而对外契约恰恰最不该 drift。
// 这里只加自己的那一样东西：children 恒为 []（spider 出扁平列表，不是树）。
// 契约用例见 tests/service/spider-comment.test.ts（断言键集合逐字相等，
// 站内给评论新增字段时不会顺着漏到站外）。
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { serializeCommentBase, type CommentBaseDTO } from './comment-service';
import { categoryFullPath, ymd } from './format';
import type { Prisma } from '@prisma/client';

// ── 评论扁平序列化（对齐 CommentService._serialize_comment）───────────────────

/** 对外契约：公共部分 + 恒为空的 children。**不得**混入站内才有的字段。 */
export interface SpiderCommentDict extends CommentBaseDTO {
  children: SpiderCommentDict[];
}

/**
 * 只选公共序列化需要的列 —— 刻意**不含** content（Markdown 原文）/ image_id /
 * quote_blog_id：那是站内才下发的字段，spider 没有必要把它们从库里读出来。
 */
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
  return {
    ...serializeCommentBase(c),
    children: [], // 扁平输出恒为空数组（对齐 Flask）
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
