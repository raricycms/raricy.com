// ─────────────────────────────────────────────────────────────────────────────
// spider-service.ts — 机器人（站外爬虫 / 聚合器）只读 API 业务逻辑
//
// 三个只读端点。**鉴权在路由层**：需 core+ 登录（见 src/app/api/spider/*/route.ts）。
// 本站的机器人模型一直是「一个 core+ 账号 + 会话 cookie」（docs/bot/chat-bot.md §2），
// 这一组与之一致。因此这里的产物一律是与调用者无关的**公开 DTO** ——
// 不要因为路由层拿得到会话，就往里加随人而变的字段。
//
// ── 【⚠️「站外」描述的是调用者，**不是权限边界**】──────────────────────────────
//
// 「站外爬虫 / 聚合器」说的是**谁在调**（机器人、聚合器），不是「这里放行了什么」。
// 权限边界就是 core+ —— 与任何一个核心成员**一模一样**：机器人能调它，是因为机器人
// 手里就是一个 core+ 账号。它没有绕过任何东西，也没有自己的凭据体系
// （踩过的坑：看到「站外」+ 它被写在 docs/bot/ 下，就以为这是「对外接口」，
//   进而以为「对外接口能读 internal 文章」是漏洞 —— 不是。internal 的语义就是
//   「站内 core+ 可见」，而 core+ 账号读到它正是这条语义的定义）。
//
// 而且**它不只有站外的消费者**：`/api/spider/favorites/:id` 同时是我们自己前端的
// 数据源（`src/app/components/MarkdownRenderer.tsx` 渲染 `[@六位]` 收藏夹卡片时，
// 带读者自己的会话去取）。所以更准确的理解是：**一个 core+ 网关下的只读命名空间**，
// 消费者里既有机器人也有本站前端。名字只说了其中一半。
//
// ⚠️ **因此别往这一组里加可见性过滤。** 那不是「补漏」，是把自家前端的取数与机器人的
// 正常成员读一起改坏 —— 站外可见性回答的是「非 core 能读到什么」，而这条路径上
// 压根没有非 core 的调用者。
//   - getSpiderBlog     —— Blog 公开字段 + content/liked/user_fed
//   - getRecentComments —— status='approved' 最近 100 条，含已删除占位
//   - getSpiderComment  —— 按 id 查，is_deleted=false
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

// ── 评论扁平序列化（对外契约，见 tests/service/spider-comment.test.ts）──────────

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
    children: [], // 扁平输出恒为空数组
  };
}

/**
 * 最近评论：
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
 * 博客详情：
 * blog 不存在或 ignore=true → null（路由据此回 404）。
 * liked / user_fed 恒为 false —— 这两个字段随人而变，而本函数的产物是**公开 DTO**，
 * 与调用者是谁无关。鉴权在路由层，拿得到会话也不往下传。
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
    liked: false, // 公开 DTO：不随调用者变化（理由见 getSpiderBlog 的注释）
    user_fed: false, // 同 liked
  };

  return { meta, content };
}
