// 公开文章集合的**单一定义**（R3-172）—— 静态单测，不连数据库。
//
// 【为什么单独立一条】这个集合有四种载体在查（Prisma where / raw SQL / 内存行判断 /
// 单篇可达性）。分叉的后果是静默的：搜索引擎收录了、公开列表上却翻不到，或反过来。
// 这里钉三件最容易被「顺手合并」掉的事：
//   1. 可索引集合只有 public（不是 link + public —— 那是单篇可达性集合）；
//   2. raw SQL 的 `u.archived_at IS NULL` 是**必要补偿**（Prisma 的归档查询边界由
//      db.ts 的 withArchiveScope 扩展注入，raw SQL 不走扩展），别当重复条件删掉；
//   3. 内存判断与 where 片段同义（写入 / 重建索引时不能把不该索引的行留下来）。

import { describe, expect, it } from 'vitest';
import {
  INDEXABLE_BLOG_WHERE,
  PUBLIC_BLOG_WHERE,
  PUBLIC_BLOG_SQL,
  PUBLIC_SEARCH_BLOG_SQL,
  isPublicIndexableBlog,
} from '@/lib/blog-public-scope';

describe('公开集合的唯一定义（R3-172）', () => {
  it('可索引 = 只有 public；完整 where 额外排除软删', () => {
    expect(INDEXABLE_BLOG_WHERE).toEqual({ visibility: { in: ['public'] } });
    expect(PUBLIC_BLOG_WHERE).toEqual({ ignore: false, visibility: { in: ['public'] } });
    // 两者都必须是同义白名单 —— 不是「不等于 internal / 不等于 private」那种开区间写法
    expect(JSON.stringify(INDEXABLE_BLOG_WHERE)).not.toContain('not');
  });

  it('检索 raw SQL 保留归档作者补偿；纯可见性片段不带 users 依赖', () => {
    expect(PUBLIC_SEARCH_BLOG_SQL.sql).toContain('u.archived_at IS NULL');
    expect(PUBLIC_BLOG_SQL.sql).not.toContain('archived_at');
    // 两个片段都只认 public（不是按「不等于某档」写的）
    expect(PUBLIC_BLOG_SQL.sql).toMatch(/visibility IN \(/);
    expect(PUBLIC_BLOG_SQL.sql).toContain('ignore=0');
  });

  it('内存判断与 where 同义：软删 / 非 public / 空值都不算', () => {
    expect(isPublicIndexableBlog({ ignore: false, visibility: 'public' })).toBe(true);
    expect(isPublicIndexableBlog({ ignore: true, visibility: 'public' })).toBe(false);
    expect(isPublicIndexableBlog({ ignore: false, visibility: 'link' })).toBe(false);
    expect(isPublicIndexableBlog({ ignore: false, visibility: 'internal' })).toBe(false);
    expect(isPublicIndexableBlog({ visibility: null })).toBe(false);
    expect(isPublicIndexableBlog({})).toBe(false);
  });
});
