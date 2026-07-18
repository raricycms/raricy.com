// ─────────────────────────────────────────────────────────────────────────────
// tools.spec.ts —— 工具页可达性与正确性
//
// 【为什么要有这个文件】工具菜单一度把 5 个工具（url/html/qp/hash/aes）的链接
// 指回老站 Flask，而这些页面在 Next 侧其实早就实现好了 —— 用户被白白踢走，
// 且 Flask 一删这些链接全部 404。链接指错不会让构建失败、也不会让任何单测转红，
// 只有真的点进去才发现。故在此钉死：
//   1. 菜单里不得再出现指向老站的工具链接
//   2. 五个页面都能打开
//   3. 抽查算得对（用标准值断言，不是「有输出就算过」）
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';

const TOOLS = ['url', 'html', 'qp', 'hash', 'aes'] as const;

test('工具菜单不含指向老站的工具链接（Flask 删掉后不能 404）', async ({ page }) => {
  await page.goto('/tool');

  const hrefs = await page.locator('a.tool').evaluateAll((as) =>
    as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '')
  );
  expect(hrefs.length).toBeGreaterThan(0);

  // 工具卡片一律走站内相对路径。绝对 URL（http://…）意味着又指回老站了。
  const external = hrefs.filter((h) => /^https?:\/\//.test(h));
  expect(external, `这些工具链接指向站外：${external.join(', ')}`).toEqual([]);

  // 五个曾被指回老站的工具，菜单里必须都在且是站内链接
  for (const t of TOOLS) {
    expect(hrefs, `菜单缺少 /tool/${t}`).toContain(`/tool/${t}`);
  }
});

for (const t of TOOLS) {
  test(`/tool/${t} 能打开`, async ({ page }) => {
    const res = await page.goto(`/tool/${t}`);
    expect(res?.status()).toBe(200);
    // 404 页会渲染成 200 外壳，故再断言不是「页面不存在」
    await expect(page.locator('body')).not.toContainText('This page could not be found');
  });
}

// 抽查三个的计算结果。用公开标准值，避免「有输出就算过」这种自欺的断言。
// 这些工具都是点按钮才算（不是输入即时计算），所以必须走真实交互。

test('URL 编码：中文转成 UTF-8 百分号编码', async ({ page }) => {
  await page.goto('/tool/url');
  await page.locator('textarea').first().fill('你好 world&a=1');
  await page.getByRole('button', { name: /编码/ }).first().click();
  // 「你好」的 UTF-8 百分号编码
  await expect(page.locator('textarea').nth(1)).toHaveValue(/%E4%BD%A0%E5%A5%BD/);
});

test('HTML 编码：script 标签被转义（这是它的安全用途）', async ({ page }) => {
  await page.goto('/tool/html');
  await page.locator('textarea').first().fill('<script>alert(1)</script>');
  await page.getByRole('button', { name: /编码/ }).first().click();
  await expect(page.locator('textarea').nth(1)).toHaveValue(/&lt;script&gt;/);
});

test('哈希：SHA-256("abc") 等于标准值', async ({ page }) => {
  await page.goto('/tool/hash');
  await page.locator('textarea').first().fill('abc');
  const btn = page.getByRole('button', { name: /计算|哈希|生成/ }).first();
  if (await btn.count()) await btn.click();
  // NIST 公布的 SHA-256("abc") 标准测试向量
  await expect(page.locator('body')).toContainText(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    { ignoreCase: true }
  );
});
