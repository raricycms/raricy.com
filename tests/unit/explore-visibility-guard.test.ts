// 「对外列表与 sitemap 必须列同一个集合」这条不变量的**静态**守卫。
//
// 【为什么需要它】两条路径分叉的后果是静默的：搜索引擎收录了一篇，读者在公开列表上
// 翻不到（或反过来）—— 没有任何报错，行为测试也未必覆盖到那个组合（要造出「同一篇
// 文章在一条路径上出现、在另一条上不出现」的状态，前提是两条路径的 where 真的不同）。
// 而「可发现」的整个承诺就是这两者一致。
//
// 手法与 tests/unit/blog-visibility-guard.test.ts 相同：**名字就是台账**。
// 两个出口的函数体里都必须出现 INDEXABLE_BLOG_WHERE 这个名字 —— 它是「与 sitemap
// 同源」这件事唯一可被静态识别的凭证，不是随便起的一个常量名。
//
// ⚠️ 静态守卫是绊线，不是证明器：它只看源码里有没有那个名字。真正的行为保证在
// tests/service/blog-service.test.ts 的「与 listIndexableBlogs 列同一个集合」那条
// （它真造数据、真比对两个集合）。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = path.resolve(import.meta.dirname, '../../src/lib/blog-service.ts');
const serviceSrc = fs.readFileSync(SERVICE, 'utf-8');

/**
 * 截出某个导出 async 函数的函数体。
 *
 * 靠「顶格的 `}` **且它后面就是换行**」收尾 —— 函数内部的块都缩进，所以顶格的 `}`
 * 只有函数结束那一个……
 *
 * ⚠️ **但多行的返回类型注解会破例**：`listPublicBlogs` 的签名是
 *
 *     export async function listPublicBlogs(params: …): Promise<{
 *       blogs: PublicBlogRow[];
 *     }> {
 *
 * 那个 `}> {` 的行首也有一个 `}`。只写 `\n\}` 的话正则会**在那里就收尾**，截出的
 * 「函数体」其实是签名 —— 而它当然不含 where，于是主断言会以一条看起来很像真问题的
 * 报错变红（本文件第一版就是这么错的）。所以要补一个「后面必须是换行」的环视。
 */
function bodyOf(name: string): string {
  const m = serviceSrc.match(
    new RegExp(`export async function ${name}\\b[\\s\\S]*?\\n\\}(?=\\r?\\n|$)`)
  );
  return m ? m[0] : '';
}

describe('explore / 对外列表与 sitemap 同源（不变量【5】）', () => {
  it('产出自检：正则真能截出函数体（否则下面那条会静默变绿）', () => {
    // 两个函数都要检 —— `listPublicBlogs` 正是「多行返回类型」那个形状，
    // 只检 listIndexableBlogs 的话，第一版的截断 bug 根本暴露不出来。
    for (const fn of ['listIndexableBlogs', 'listPublicBlogs']) {
      const body = bodyOf(fn);
      expect(body.length, `截不出 ${fn} 的函数体`).toBeGreaterThan(50);
      expect(body, `${fn} 截出来的不是函数体（多半又停在返回类型那个 } 上了）`).toContain(
        'prisma.blog.'
      );
    }
    // 反例：不存在的函数名必须截出空串（证明「截到了」不是恒真）
    expect(bodyOf('noSuchFunctionAtAll'), '不存在的函数竟然也截出了东西').toBe('');
  });

  it('★ 两个出口都必须提到 INDEXABLE_BLOG_WHERE', () => {
    for (const fn of ['listPublicBlogs', 'listIndexableBlogs']) {
      const body = bodyOf(fn);
      expect(body, `没找到 ${fn} 的函数体`).toContain(fn);
      expect(
        body,
        `${fn} 的函数体里没有 INDEXABLE_BLOG_WHERE —— 它必须与另一个出口用**同一个常量**，` +
          `否则 sitemap 与 /explore 会列不同的集合，而那条差异不会有任何报错。` +
          `（要么改回这个常量，要么先想清楚「两条路径列不同集合」为什么可以接受。）`
      ).toContain('INDEXABLE_BLOG_WHERE');
    }
  });

  it('对外列表不许退化成「link + public」—— link 读得到，但不许被列举', () => {
    // EXTERNAL_VISIBLE_BLOG_WHERE 是给**单篇可达性**用的，不是给列表用的。
    // 谁把 listPublicBlogs 的 where 换成它，link 档就会出现在公开列表上 ——
    // 那等于把「凭链接可读」变成了「被列举」，而这两档的差别就在这里。
    expect(
      bodyOf('listPublicBlogs'),
      'listPublicBlogs 用了 EXTERNAL_VISIBLE_BLOG_WHERE —— 那是单篇可达性的常量，' +
        '列表只该用 INDEXABLE_BLOG_WHERE（只有 public）'
    ).not.toContain('EXTERNAL_VISIBLE_BLOG_WHERE');
  });

  it('/explore 页面走的是 listPublicBlogs，没自己手写 where', () => {
    const page = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/app/explore/page.tsx'),
      'utf-8'
    );
    expect(page, '页面必须经过那个具名出口').toContain('listPublicBlogs');
    expect(page, '/explore 不该自己查 blog 表（绕过了出口）').not.toMatch(/prisma\.blog\./);
    expect(page, '/explore 不许用站内那个不看可见性的列表函数').not.toMatch(/\blistBlogs\b/);
    expect(page, '/explore 自己也不许手写可见性条件').not.toMatch(/visibility\s*:/);
  });

  it('sitemap 只经过 listIndexableBlogs，没自己查 blog 表', () => {
    const sitemap = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/app/sitemap.ts'),
      'utf-8'
    );
    expect(sitemap).toContain('listIndexableBlogs');
    expect(sitemap, 'sitemap 不该自己查 blog 表 —— 过滤要收在出口里').not.toMatch(
      /prisma\.blog\./
    );
  });
});
