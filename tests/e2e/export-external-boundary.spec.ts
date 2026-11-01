// ─────────────────────────────────────────────────────────────────────────────
// export-external-boundary.spec.ts —— 访客视角导出的真实下载件
//
// 单元测试已断言 external 适配“零业务请求、私有 token 保留字面量”；这条补浏览器
// 下载链路：public 博客引用自己的**私有**剪贴板，打开编辑页的「访客视角预览」
// （默认开）后导出 HTML，下载件里只能有 `[@id]` token，不能出现私有正文，
// 也不能在导出期间请求 `/api/clipboard/<id>`。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { SEED_PASSWORD, SEED_USERS } from './seed';
import { uniqueTag } from './helpers';

const SECRET = 'PRIVATE-CLIP-BODY-DO-NOT-LEAK';

test('访客视角导出：私有剪贴板保持 token，不取正文', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const clipRes = await page.request.post('/api/clipboard', {
    data: {
      title: `私有剪贴板-${uniqueTag()}`,
      content: `${SECRET}\n\n私有正文`,
      publicity: false,
    },
  });
  expect(clipRes.status(), `建剪贴板失败：${await clipRes.text()}`).toBe(200);
  const clipJson = (await clipRes.json()) as { id?: string; clip?: { id: string } };
  const clipId = clipJson.id ?? clipJson.clip?.id;
  expect(typeof clipId).toBe('string');

  const blogRes = await page.request.post('/api/blogs', {
    data: {
      title: `访客导出-${uniqueTag()}`,
      description: 'external 导出边界',
      content: `引用：[@${clipId}]\n\n自己的公开正文。`,
      visibility: 'public',
      format: 'markdown',
    },
  });
  expect(blogRes.status(), `发文失败：${await blogRes.text()}`).toBe(200);
  const { blog_id: blogId } = (await blogRes.json()) as { blog_id: string };

  let privateRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/api/clipboard/${clipId}`)) privateRequests += 1;
  });

  await page.goto(`/blog/${blogId}/edit`);
  await expect(page.locator('#editor .md-toolbar')).toBeVisible();
  // 访客视角预览默认开启；显式确认勾选，避免默认值变化让用例变空。
  const visitor = page.getByLabel('访客视角预览');
  await expect(visitor).toBeChecked();
  await expect(page.locator('#editor .md-editor__preview-body')).toContainText(
    `[@${clipId}]`
  );

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '导出 HTML', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const html = await fs.readFile(path!, 'utf8');

  expect(html, '私有正文出现在访客导出件').not.toContain(SECRET);
  expect(html, '私有剪贴板 token 没有被保留').toContain(`[@${clipId}]`);
  expect(privateRequests, '访客导出期间请求了私有剪贴板接口').toBe(0);
});
