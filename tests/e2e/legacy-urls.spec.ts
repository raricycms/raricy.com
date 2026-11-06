import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

// 历史版本的旧地址兼容（next.config.mjs 的 rewrites）。
//
// 【为什么要 E2E】rewrite 是**构建期**配置，单测碰不到：它要么被 Next 认下来，
// 要么整条路径静默 404，而 404 的后果是**存量文章里的图全变碎图**。
// 截至 2026-09 的存量：55 篇博客 / 110 处 URL 写死的是
// `https://raricy.com/image/i/<id>`（历史版本的 `/i/<image_id>`）。
//
// 注意：内容里还有一类老地址是 `http://116.62.179.232:22822/image/i/...` ——
// host 写死在正文里，站内 rewrite 管不着，本文件测不到、也不该测。

/** 1x1 透明 PNG（服务端会 sniff magic bytes，随便一串字节过不去）。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('★ 旧图床直链 /image/i/<id> 与新地址字节一致', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);

  // 先传一张，拿到一个真实存在的 id
  const up = await page.request.post('/api/images', {
    multipart: { file: { name: 'legacy.png', mimeType: 'image/png', buffer: PNG_1X1 } },
  });
  expect(up.status()).toBe(200);
  const { id } = (await up.json()) as { id: string };

  const [oldRes, newRes] = await Promise.all([
    page.request.get(`/image/i/${id}`),
    page.request.get(`/api/images/${id}/raw`),
  ]);

  expect(oldRes.status(), '旧地址必须还能取到图').toBe(200);
  expect(newRes.status()).toBe(200);
  // 不是「也说 200」就算过 —— 必须是同一张图
  expect(Buffer.compare(await oldRes.body(), await newRes.body())).toBe(0);
  expect(oldRes.headers()['content-type']).toBe('image/png');
});

test('旧图床地址删掉的图仍然 404（rewrite 不能把 404 吞掉）', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);

  const res = await page.request.get('/image/i/NoSuchId00');
  expect(res.status()).toBe(404);
});

test('旧头像直链 /auth/avatar/<id> 可用（历史版本的 /auth/avatar/<user_id>）', async ({ page }) => {
  const { id } = SEED_USERS.core;

  const [oldRes, newRes] = await Promise.all([
    page.request.get(`/auth/avatar/${id}`),
    page.request.get(`/api/avatar/${id}`),
  ]);

  expect(oldRes.status()).toBe(200);
  expect(newRes.status()).toBe(200);
  expect(Buffer.compare(await oldRes.body(), await newRes.body())).toBe(0);
});

// 旧的「获取注册资格」页已退出：保留 307 让旧直链/书签落到注册页，而不是 404。
test('/valid_user 307 到 /register（保留查询参数，不 404）', async ({ page }) => {
  const res = await page.request.get('/valid_user?from=old', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['location']).toBe('/register?from=old');
});

// favicon.ico 是浏览器/书签/外链默认会直连的地址。资产已删（341KB 无引用），
// 用 rewrite 兜到真正的入口 favicon.png —— 不能 404（否则标签页图标变白）。
test('已删除的 favicon.ico 由 rewrite 兜到 favicon.png（200 + image/png）', async ({ page }) => {
  const res = await page.request.get('/favicon.ico');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/png');
});
