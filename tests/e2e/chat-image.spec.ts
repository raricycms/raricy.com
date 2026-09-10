// ─────────────────────────────────────────────────────────────────────────────
// chat-image.spec.ts —— 聊天图片
//   · 点图片原位放大（覆盖层），不新开窗口
//   · 上传第一次网络失败自动重试一次（弱网 / 微信内置浏览器）
//
// 【造数纪律】大区是全站共用频道：定位一律用本轮 uniqueTag 的哨兵串锚定，
// 绝不断言「列表里有几条」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

/** 1×1 的合法 PNG —— 服务端会校验 magic bytes 且要过 sharp 压缩，必须得是真图。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 走接口传一张图，返回其 id。 */
async function uploadViaApi(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/images', {
    multipart: { file: { name: 'e2e.png', mimeType: 'image/png', buffer: PNG_1X1 } },
  });
  expect(res.status(), `上传失败: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** 按哨兵串定位消息行（回复引用块里也会出现原文，必须限定在正文内匹配）。 */
function msgRow(page: Page, marker: string) {
  return page.locator('.chat-msg', {
    has: page.locator('.chat-msg__content', { hasText: marker }),
  });
}

test.describe('聊天图片', () => {
  test('点图片原位放大、不新开窗口，Esc 关闭', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const marker = `e2e-zoom-${uniqueTag()}`;
    const imageId = await uploadViaApi(page.request);
    const posted = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, {
      data: { content: marker, image_id: imageId },
    });
    expect(posted.status()).toBe(200);

    // 新开窗口正是这次要防的回归 —— 整场用例里不许有 page 冒出来
    let newPages = 0;
    page.context().on('page', () => {
      newPages += 1;
    });

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const thumb = row.locator('.chat-msg__image');
    await expect(thumb).toBeVisible();
    const thumbSrc = await thumb.getAttribute('src');

    await thumb.click();
    const overlay = page.locator('.chat-lightbox');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('img')).toHaveAttribute('src', thumbSrc!);
    expect(newPages, '点图片不应新开窗口').toBe(0);

    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    expect(newPages, '点图片不应新开窗口').toBe(0);
  });

  test('放大层可缩放：按钮档位、百分比复位、滚轮', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const marker = `e2e-zoomctl-${uniqueTag()}`;
    const imageId = await uploadViaApi(page.request);
    const posted = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, {
      data: { content: marker, image_id: imageId },
    });
    expect(posted.status()).toBe(200);

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();
    await row.locator('.chat-msg__image').click();

    const overlay = page.locator('.chat-lightbox');
    await expect(overlay).toBeVisible();

    const img = overlay.locator('.chat-lightbox__img');
    const level = overlay.locator('.chat-lightbox__zoom-level');
    const zoomIn = overlay.getByRole('button', { name: '放大' });
    const zoomOut = overlay.getByRole('button', { name: '缩小' });

    await expect(level).toHaveText('100%');
    await expect(zoomOut).toBeDisabled(); // 已经是最小档

    await zoomIn.click();
    await expect(level).toHaveText('150%');
    await expect(img).toHaveCSS('transform', /matrix\(1\.5,/);

    await zoomIn.click();
    await expect(level).toHaveText('200%');

    // 百分比按钮 = 复位到原始大小，缩小按钮随之回到禁用
    await level.click();
    await expect(level).toHaveText('100%');
    await expect(zoomOut).toBeDisabled();

    // 滚轮向上放大一档（mobile project 是 WebKit 触摸设备，没有滚轮 → 跳过）
    if (test.info().project.name !== 'mobile') {
      await overlay.hover();
      await page.mouse.wheel(0, -120);
      await expect(level).toHaveText('150%');
    }

    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('上传第一次网络失败会自动重试一次', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    let attempts = 0;
    await page.route('**/api/images', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts += 1;
      // 第一次模拟「请求根本没发出去」（弱网/微信 X5 内核对 fetch+FormData 的偶发失败）
      if (attempts === 1) return route.abort('connectionfailed');
      return route.continue();
    });

    await page.goto(`/chat?channel=${LOBBY}`);
    await page.setInputFiles('.chat-composer input[type=file]', {
      name: 'e2e.png',
      mimeType: 'image/png',
      buffer: PNG_1X1,
    });

    // 重试成功 → 待发送预览出现，且总请求数为 2
    await expect(page.locator('.chat-composer__image')).toBeVisible({ timeout: 15_000 });
    expect(attempts, '应当只重试一次').toBe(2);
  });
});
