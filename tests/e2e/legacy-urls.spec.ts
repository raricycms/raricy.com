import { test, expect } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

// Flask 时代的旧地址兼容（next.config.mjs 的 rewrites）。
//
// 【为什么要 E2E】rewrite 是**构建期**配置，单测碰不到：它要么被 Next 认下来，
// 要么整条路径静默 404，而 404 的后果是**存量文章里的图全变碎图**。
// 截至 2026-09 的存量：55 篇博客 / 110 处 URL 写死的是
// `https://raricy.com/image/i/<id>`（Flask 的 image_bp `/i/<image_id>`）。
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

test('旧头像直链 /auth/avatar/<id> 可用（Flask 的 /auth/avatar/<user_id>）', async ({ page }) => {
  const { id } = SEED_USERS.core;

  const [oldRes, newRes] = await Promise.all([
    page.request.get(`/auth/avatar/${id}`),
    page.request.get(`/api/avatar/${id}`),
  ]);

  expect(oldRes.status()).toBe(200);
  expect(newRes.status()).toBe(200);
  expect(Buffer.compare(await oldRes.body(), await newRes.body())).toBe(0);
});
