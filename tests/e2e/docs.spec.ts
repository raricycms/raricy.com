// 文档页端到端 —— 索引 `/docs` 与正文 `/docs/<slug>`
//
// 【为什么必须走 e2e】三件只有真发请求、真渲染才定得下来的事：
//
//   · **中文 slug 的转义往返**。`/docs/guide/图床使用指南` 里的中文在 URL 上是
//     percent-encoded 的，而路由参数交给服务端时是编码态还是解码态由框架决定 ——
//     单元测试直接喂字符串，永远「猜对」；猜错的后果是**每一份中文名的文档都 404**，
//     而它们恰好是玩家最常看的那批。
//   · **相对链接改写的产物真能点**。单测断言的是 `renderDocHtml` 的返回值，
//     这里断言的是页面上那颗 `<a>` 的 href —— 中间还隔着 React 的属性序列化。
//   · **索引页与登记表条数一致**。渲染层漏渲染一组、或 `.docs-item` 换了类名，
//     单测全绿而页面上少一截。
//
// 页脚入口那条也在这里：文档页的唯一入口是页脚那个链接（顶栏没有），
// 断了就等于整块功能只剩手敲 URL 能到。

import { test, expect } from '@playwright/test';
import { DOC_ENTRIES, DOC_GROUPS, docHref } from '../../src/lib/docs-catalog';

/** 拿一份中文 slug 的文档与一份 ASCII slug 的文档 —— 两条 URL 路径都要走到。 */
const ZH = DOC_ENTRIES.find((e) => /[一-龥]/.test(e.slug))!;
const ASCII = DOC_ENTRIES.find((e) => !/[一-龥]/.test(e.slug))!;

test('索引页列出全部登记文档，并按三组分区', async ({ page }) => {
  await page.goto('/docs');

  await expect(page.locator('.docs-item')).toHaveCount(DOC_ENTRIES.length);
  await expect(page.locator('.docs-group')).toHaveCount(DOC_GROUPS.length);
  for (const group of DOC_GROUPS) {
    await expect(page.locator('.docs-group__title', { hasText: group.title })).toHaveCount(1);
  }
});

test('中文 slug 的文档打得开（URL 转义往返）', async ({ page }) => {
  const resp = await page.goto(docHref(ZH.slug));

  expect(resp?.status()).toBe(200);
  await expect(page.locator('.docs-content h1')).toHaveText(ZH.title);
});

test('ASCII slug 的文档打得开，且同组文档列在正文之后', async ({ page }) => {
  const resp = await page.goto(docHref(ASCII.slug));

  expect(resp?.status()).toBe(200);
  await expect(page.locator('.docs-content h1')).toHaveText(ASCII.title);

  // 同组其他文档：不含自己
  const siblings = page.locator('.docs-siblings .docs-item__title');
  await expect(siblings.filter({ hasText: ASCII.title })).toHaveCount(0);
  expect(await siblings.count()).toBeGreaterThan(0);
});

test('没登记的 slug 是 404（不落到磁盘、不落到别的页面）', async ({ page }) => {
  // 越界 / 畸形那一批（`..`、`%2f`）由 tests/unit/docs-catalog.test.ts 直接喂给
  // findDocEntry —— 浏览器会先把字面 `..` 规范化掉，在这儿构造不出真正的越界请求。
  for (const path of ['/docs/不存在', '/docs/a/b/c/d', `/docs/${ZH.slug}.md`]) {
    const resp = await page.goto(path);
    expect(resp?.status(), `${path} 应当是 404`).toBe(404);
  }
});

test('正文里的相对链接改写成站内地址', async ({ page }) => {
  // docs/guide/内容引用语法指南.md 里有 [表情包使用指南](表情包使用指南.md)
  const src = DOC_ENTRIES.find((e) => e.slug === 'guide/内容引用语法指南')!;
  const target = DOC_ENTRIES.find((e) => e.slug === 'guide/表情包使用指南')!;
  await page.goto(docHref(src.slug));

  // 这一篇里指向同一份文档的链接有三处（正文与两处表格），**每一处**都得是站内地址
  const links = page.locator('.docs-content a', { hasText: target.title });
  const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
  expect(hrefs.length).toBeGreaterThan(0);
  expect(new Set(hrefs)).toEqual(new Set([docHref(target.slug)]));
});

test('指向源码的相对链接改写成仓库地址，且来源行给出仓库里的那一份', async ({ page }) => {
  await page.goto(docHref('frontend-styles'));

  const repoLink = page.locator('.docs-content a', { hasText: 'src/app/layout.tsx' }).first();
  expect(await repoLink.getAttribute('href')).toBe(
    'https://github.com/raricycms/raricy.com/blob/main/src/app/layout.tsx'
  );

  await expect(page.locator('.docs-source code')).toHaveText('docs/frontend-styles.md');
});

test('页脚的「文档」入口通向索引页', async ({ page }) => {
  await page.goto('/');
  await page.locator('.site-footer').getByRole('link', { name: '文档', exact: true }).click();

  await page.waitForURL('**/docs');
  await expect(page.locator('.docs-hero__title')).toHaveText('文档');
});
