import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loginViaApi, publishBlog, registerFreshUser } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from './seed';

test('CLI 归档在另一个网站进程生效；站长网页也无法查看、修改或恢复归档账号', async ({ page, browser, baseURL }) => {
  test.setTimeout(60000);
  const target = await registerFreshUser(page, { core: true });
  const blogId = await publishBlog(page, 'public');
  const oldSession = await browser.newContext({ baseURL, storageState: await page.context().storageState() });
  const scratch = process.env.E2E_SEEDED_DB?.replace(/\\/g, '/');
  // 子进程绝不回落到 .env 的开发库。
  expect(scratch).toContain('/tests/.tmp/e2e-');
  const cli = (action: 'archive' | 'unarchive') => {
    const raw = execFileSync(process.execPath, [
      path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/cli.ts'),
      'user', action, target.username, '--reason', 'e2e 独立进程归档验证',
      '--as', SEED_USERS.owner.username, '--yes', '--json',
    ], { env: { ...process.env, DATABASE_URL: `file:${scratch}`, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30000 });
    expect(JSON.parse(raw).ok).toBe(true);
  };
  try {
    expect((await (await oldSession.request.get('/api/auth/me')).json()).user.id).toBe(target.id);
    await loginViaApi(page, SEED_USERS.owner.username);
    expect((await page.request.get(`/api/users/${target.id}`)).status()).toBe(200);
    expect((await page.request.get(`/api/blogs/${blogId}`)).status()).toBe(200);
    cli('archive');
    expect((await page.request.get(`/api/users/${target.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/blogs/${blogId}`)).status()).toBe(404);
    expect((await page.request.patch(`/api/admin/users/${target.id}`, { data: { role: 'admin' } })).status()).toBe(404);
    expect((await page.request.post(`/api/admin/users/${target.id}`, { data: { action: 'unarchive' } })).status()).toBe(400);
    await page.goto(`/admin/users?search=${encodeURIComponent(target.username)}`);
    await expect(page.locator('.user-card')).toHaveCount(0);
    expect((await (await oldSession.request.get('/api/auth/me')).json()).user).toBeNull();
    expect((await oldSession.request.post('/api/auth/login', { data: { username: target.username, password: SEED_PASSWORD } })).status()).toBe(401);
    cli('unarchive');
    expect((await page.request.get(`/api/users/${target.id}`)).status()).toBe(200);
    expect((await page.request.get(`/api/blogs/${blogId}`)).status()).toBe(200);
    // 恢复不复活归档前的 cookie。
    expect((await (await oldSession.request.get('/api/auth/me')).json()).user).toBeNull();
    await loginViaApi(page, target.username);
    expect((await (await page.request.get('/api/auth/me')).json()).user.id).toBe(target.id);
  } finally { await oldSession.close(); }
});
