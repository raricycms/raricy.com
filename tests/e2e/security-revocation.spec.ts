import { expect, test } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_PASSWORD, SEED_USERS, SEED_BLOG } from './seed';

test('自助改密立即关闭旧讨论/顶栏流，旧 cookie 失效且收不到后续私聊', async ({ page, browser, baseURL }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  const other = await browser.newContext({ baseURL });
  const speaker = await other.newPage();
  const controllers: AbortController[] = [];
  const newPassword = 'security-New-Password-123';
  let changed = false;
  try {
    await loginViaApi(speaker, SEED_USERS.admin.username);
    const channelResponse = await speaker.request.post('/api/chat/channels', { data: { user_id: SEED_USERS.core.id } });
    expect(channelResponse.status()).toBe(200);
    const channelId = (await channelResponse.json()).channel.id;
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
    const streams = await Promise.all(['/api/chat/stream', '/api/notifications/stream'].map(async (path) => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(new URL(path, baseURL), { headers: { cookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      return { done: (async () => {
        let text = new TextDecoder().decode(first.value);
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return text;
          text += new TextDecoder().decode(chunk.value);
        }
      })() };
    }));
    const result = await page.request.post('/api/auth/change-password', { data: { current_password: SEED_PASSWORD, new_password: newPassword, confirm_password: newPassword } });
    expect(result.status()).toBe(200);
    changed = true;
    expect((await fetch(new URL('/api/checkin', baseURL), { headers: { cookie } })).status).toBe(401);
    const marker = `after-password-change-${uniqueTag()}`;
    expect((await speaker.request.post(`/api/chat/channels/${channelId}/messages`, { data: { content: marker } })).status()).toBe(200);
    for (const text of await Promise.all(streams.map((stream) => stream.done))) expect(text).not.toContain(marker);
  } finally {
    controllers.forEach((c) => c.abort());
    if (changed) {
      expect((await page.request.post('/api/auth/login', { data: { username: SEED_USERS.core.username, password: newPassword } })).status()).toBe(200);
      expect((await page.request.post('/api/auth/change-password', { data: { current_password: newPassword, new_password: SEED_PASSWORD, confirm_password: SEED_PASSWORD } })).status()).toBe(200);
    }
    await other.close();
  }
});

test('作者不能自投喂，页面保留计数并禁用按钮，接口同样拒绝', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.goto(`/blog/${SEED_BLOG.id}`);
  await expect(page.locator('#feed-fish-btn')).toBeDisabled();
  const response = await page.request.post(`/api/blogs/${SEED_BLOG.id}/feed`, { data: { amount: 5 } });
  expect(response.status()).toBe(400);
  const feeders = await page.request.get(`/api/blogs/${SEED_BLOG.id}/feeders`);
  expect((await feeders.json()).total).toBe(0);
});

test('停用 OAuth 应用立即阻断 userinfo，重新启用也不复活旧令牌', async ({ page, browser, baseURL }) => {
  await loginViaApi(page, SEED_USERS.owner.username);
  const ctx = await browser.newContext({ baseURL });
  const user = await ctx.newPage();
  try {
    await loginViaApi(user, SEED_USERS.core.username);
    const redirectUri = 'https://security.example/callback';
    const created = await page.request.post('/api/admin/oauth/applications', { data: { name: `security-${uniqueTag()}`, redirectUris: [redirectUri] } });
    expect(created.status()).toBe(200);
    const app = await created.json();
    const codeResponse = await user.request.post('/api/oauth/authorize', { data: { client_id: app.clientId, redirect_uri: redirectUri, scope: 'profile' } });
    expect(codeResponse.status()).toBe(200);
    const code = new URL((await codeResponse.json()).redirect_to).searchParams.get('code');
    const minted = await user.request.post('/api/oauth/token', { data: { client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri } });
    expect(minted.status()).toBe(200);
    const headers = { authorization: `Bearer ${(await minted.json()).access_token}` };
    expect((await user.request.get('/api/oauth/userinfo', { headers })).status()).toBe(200);
    const path = `/api/admin/oauth/applications/${app.application.id}`;
    expect((await page.request.delete(path)).status()).toBe(200);
    const disabled = await user.request.get('/api/oauth/userinfo', { headers });
    expect(disabled.status()).toBe(400);
    expect(await disabled.json()).toMatchObject({ error: 'invalid_token' });
    expect((await page.request.patch(path, { data: { disabled: false } })).status()).toBe(200);
    const reenabled = await user.request.get('/api/oauth/userinfo', { headers });
    expect(reenabled.status()).toBe(400);
    expect(await reenabled.json()).toMatchObject({ error: 'invalid_token' });
  } finally { await ctx.close(); }
});
