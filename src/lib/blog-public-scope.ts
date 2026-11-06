// ─────────────────────────────────────────────────────────────────────────────
// blog-public-scope.ts — 「公开文章集合」的**唯一定义**（可索引 = visibility public）
//
// 同一个集合有四种载体在查、在判：
//   · Prisma where   —— sitemap（listIndexableBlogs）、/explore（listPublicBlogs）、
//                        重建公开索引时的候选行；
//   · Prisma.sql 片段 —— 公开正文检索的计数 / 命中两条 raw SQL；
//   · 内存行判断     —— 写入 / 重建索引时判一条 blog 还该不该留在索引里；
//   · 单篇可达性     —— getExternallyVisibleBlog / OG 用的是 EXTERNAL_VISIBLE_BLOG_WHERE
//                        （link + public），**不是**可索引集合，别混用。
//
// 【为什么单独一个模块】public-blog-search.ts 原先自己手抄了五处可见性条件
// （includes ×2、Prisma where ×1、raw SQL ×2），而它**不能**从 blog-service 取
// INDEXABLE_BLOG_WHERE（blog-service → public-blog-search 已有依赖，反过来会成环）。
// 于是白名单 / 过滤条件一旦改动，就可能只有一部分载体跟着变 —— 结果集分叉且没有任何
// 报错（blog-service 文件头不变量【5】）。把片段下沉到这个两者都依赖的模块，
// 词汇（INDEXABLE_VISIBILITIES）与它的三种载体编码只住一处。
//
// ⚠️ raw SQL 里的 `u.archived_at IS NULL` **不是冗余条件**：账号归档的默认查询边界
// 由 db.ts 的 withArchiveScope 查询扩展注入（Blog → author.archivedAt = null），而
// **raw SQL 不走 Prisma 扩展**（纪律见 archive-scope.ts 文件头）。这是必须手写的补偿：
// 删掉它，归档作者的文章会重新出现在公开搜索里（tests/service/public-blog-search.test.ts
// 的「旧索引和归档作者不能影响搜索」那条钉着这一点）。
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from '@prisma/client';
import { INDEXABLE_VISIBILITIES } from './blog-visibility';

/**
 * 可索引文章的 Prisma where 片段（只有 public 档）。
 *
 * 与 blog-service 的 `EXTERNAL_VISIBLE_BLOG_WHERE` 是**两个集合**：那个是「拿到链接
 * 能读」（link + public），这个是「可列举 / 可被搜索引擎收录」（只有 public）。
 * sitemap 与 /explore 必须都用这一个（静态守卫 tests/unit/explore-visibility-guard.test.ts）。
 */
export const INDEXABLE_BLOG_WHERE: Prisma.BlogWhereInput = Object.freeze({
  visibility: { in: [...INDEXABLE_VISIBILITIES] },
});

/** 可索引 + 未软删的完整 where（重建索引等「只看候选行」的查询用）。 */
export const PUBLIC_BLOG_WHERE: Prisma.BlogWhereInput = Object.freeze({
  ignore: false,
  ...INDEXABLE_BLOG_WHERE,
});

/** 内存行判断：一条 blog 行还该不该留在公开索引里（写入 / 重建时用）。 */
export function isPublicIndexableBlog(row: {
  ignore?: boolean | null;
  visibility?: string | null;
}): boolean {
  return (
    !row.ignore && (INDEXABLE_VISIBILITIES as readonly string[]).includes(row.visibility ?? '')
  );
}

/**
 * raw SQL 片段：`b` = blogs（调用方自己 join users 时用 `u`）。只表达「可索引 + 未软删」，
 * 不含归档作者补偿 —— 给不需要 users 表的语句（如重建索引的 DELETE 子查询）用。
 */
export const PUBLIC_BLOG_SQL = Prisma.sql`b.visibility IN (${Prisma.join(
  INDEXABLE_VISIBILITIES
)}) AND b.ignore=0`;

/**
 * raw SQL 片段：`b` = blogs、`u` = users。公开检索的计数 / 命中查询用。
 *
 * 比 `PUBLIC_BLOG_SQL` 多出的 `u.archived_at IS NULL` 是 raw SQL 对归档边界的**必要补偿**
 * （Prisma 扩展不会作用于 raw SQL，见文件头），不是可以合并掉的重复条件。
 */
export const PUBLIC_SEARCH_BLOG_SQL = Prisma.sql`${PUBLIC_BLOG_SQL} AND u.archived_at IS NULL`;
