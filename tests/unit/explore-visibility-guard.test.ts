// 「对外列表与 sitemap 必须列同一个集合」这条不变量。
//
// 【为什么需要它】两条路径分叉的后果是静默的：搜索引擎收录了一篇，读者在公开列表上
// 翻不到（或反过来）—— 没有任何报错，行为测试也未必覆盖到那个组合。
//
// 【判据怎么是行为，而不是常量名】旧版本靠「函数体里出现 INDEXABLE_BLOG_WHERE 这个名字」
// 来判同源 —— 常量一改名守卫就红，而且它证明不了两个函数**真的**给数据库发了同一份
// where。现在改成：用 mock 的 prisma 截获两个出口实际发出的 `where`，直接比较两份参数，
// 并断言语义只含 `public`、未软删。这样实现随便怎么改名都不影响判据，而「分叉」一定红。
//
// 剩下的结构性检查（/explore 页面、sitemap、公开检索）只钉**模块边界**：页面不得绕过
// 具名出口自己查表；检索不得自己手抄可见性条件（从 blog-public-scope 取片段）。
//
// ⚠️ 这是单元层守卫；真正的库级保证还有 tests/service/blog-service.test.ts 的
// 「listIndexableBlogs 只出 public」与「与 listPublicBlogs 列同一集合」两条。

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { calls: [] as { method: string; where: unknown }[] },
}));

vi.mock('@/lib/db', () => {
  const record = (method: string, args: { where?: unknown } | undefined) => {
    prismaMock.calls.push({ method, where: args?.where });
  };
  return {
    prisma: {
      blog: {
        findMany: vi.fn(async (args?: { where?: unknown }) => {
          record('findMany', args);
          return [];
        }),
        count: vi.fn(async (args?: { where?: unknown }) => {
          record('count', args);
          return 0;
        }),
      },
    },
  };
});

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('explore / 对外列表与 sitemap 同源（不变量【5】）', () => {
  it('两个出口实际发给数据库的 where 相等，且只含 public + 未软删', async () => {
    const { listIndexableBlogs, listPublicBlogs } = await import('@/lib/blog-service');
    prismaMock.calls.length = 0;
    await listIndexableBlogs();
    await listPublicBlogs();

    const findManyCalls = prismaMock.calls.filter((call) => call.method === 'findMany');
    expect(findManyCalls.length, '两个出口都应该查一次 blog.findMany').toBe(2);

    const [indexableWhere, publicWhere] = findManyCalls.map((call) => call.where);
    expect(
      publicWhere,
      'sitemap（listIndexableBlogs）与 /explore（listPublicBlogs）的 where 不同 —— ' +
        '两条路径会列不同集合，而那条差异不会有任何报错。'
    ).toEqual(indexableWhere);

    // 语义：可索引 = 未软删的 public；link 读得到但不许被列举，internal 更不许。
    expect(indexableWhere).toMatchObject({ ignore: false, visibility: { in: ['public'] } });
    const visibility = JSON.stringify((indexableWhere as { visibility?: unknown }).visibility);
    expect(visibility, '公开列表的可见性条件放进了 link').not.toContain('link');
    expect(visibility, '公开列表的可见性条件放进了 internal').not.toContain('internal');
  });

  it('/explore 页面走的是 listPublicBlogs，没自己手写 where', () => {
    const page = fs.readFileSync(path.join(ROOT, 'src/app/explore/page.tsx'), 'utf-8');
    expect(page, '页面必须经过那个具名出口').toContain('listPublicBlogs');
    expect(page, '/explore 不该自己查 blog 表（绕过了出口）').not.toMatch(/prisma\.blog\./);
    expect(page, '/explore 不许用站内那个不看可见性的列表函数').not.toMatch(/\blistBlogs\b/);
    expect(page, '/explore 自己也不许手写可见性条件').not.toMatch(/visibility\s*:/);
  });

  it('sitemap 只经过 listIndexableBlogs，没自己查 blog 表', () => {
    const sitemap = fs.readFileSync(path.join(ROOT, 'src/app/sitemap.ts'), 'utf-8');
    expect(sitemap).toContain('listIndexableBlogs');
    expect(sitemap, 'sitemap 不该自己查 blog 表 —— 过滤要收在出口里').not.toMatch(
      /prisma\.blog\./
    );
  });

  it('公开检索的可见性片段来自 blog-public-scope（不许自己手抄）', () => {
    const search = fs.readFileSync(path.join(ROOT, 'src/lib/public-blog-search.ts'), 'utf-8');
    // 模块边界：检索必须从公开集合的唯一定义处取片段（常量名可以改，模块归属不能变）。
    expect(search, '公开检索必须从 blog-public-scope 取可见性片段').toMatch(
      /from '\.\/blog-public-scope'/
    );
    // 注释里可以出现「手抄 visibility IN (...)」这种反例说明，只扫代码行。
    const code = search
      .split(/\r?\n/)
      .filter((line) => {
        const text = line.trim();
        return !(text.startsWith('//') || text.startsWith('*') || text.startsWith('/*'));
      })
      .join('\n');
    expect(
      code,
      'public-blog-search.ts 自己手写了可见性条件 —— 必须从 blog-public-scope.ts 取片段'
    ).not.toMatch(/visibility\s+(IN|in)\s*\(/);
  });
});
