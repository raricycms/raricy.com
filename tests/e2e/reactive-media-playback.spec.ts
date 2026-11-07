// ─────────────────────────────────────────────────────────────────────────────
// reactive-media-playback.spec.ts —— 历史 HTML 外链媒体在新口径下的可观测行为
//
// 2026-11-07 产品决定（R3-111）：**站内受控音频保留播放器，安全外链音频降级为
// 可点击链接**，作者原文保留；浏览器不得因为渲染页面就主动请求第三方地址。
// 这里用 Playwright 的 route 拦一个受控外部 URL，断言：
//   · 页面里**没有** `audio.site-embed--audio` 播放器（不再生成 media host）；
//   · 出现指向原 URL 的「音频」链接（点击后访问，URL 不丢）；
//   · 整个阅读过程**零**第三方请求（route 计数器为 0）。
// 受控音频（`[@音频/<id>]`）的播放器仍由 editor-resources / reactive-media 覆盖；
// 视频的 source/track 结构由 reactive-media.spec.ts 的 DOM 检查覆盖。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';
import { uniqueTag } from './helpers';

const EXTERNAL_AUDIO = 'https://media.test/tone.wav';

test('历史 HTML 外链 audio 降级为可点击链接，且不触发第三方请求（R3-111）', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);

  // 计数器：一旦浏览器真的去取外链音频，就会 +1。新口径下必须保持 0。
  let thirdPartyRequests = 0;
  await page.route(`${EXTERNAL_AUDIO}*`, (route) => {
    thirdPartyRequests += 1;
    return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(0) });
  });

  const created = await page.request.post('/api/blogs', {
    data: {
      title: `media-playback-${uniqueTag()}`,
      description: '外链音频降级',
      content: `<audio controls preload="none" src="${EXTERNAL_AUDIO}"></audio>\n\n正文。`,
      visibility: 'public',
      format: 'markdown',
    },
  });
  expect(created.status(), `发文失败：${await created.text()}`).toBe(200);
  const { blog_id: blogId } = (await created.json()) as { blog_id: string };

  await page.goto(`/blog/${blogId}`);
  const container = page.locator('#userContentContainer');

  // ① 不再生成播放器 / media host —— 否则浏览器会替访客请求第三方地址
  await expect(container.locator('audio')).toHaveCount(0);
  await expect(container.locator('audio.site-embed--audio')).toHaveCount(0);

  // ② 作者原文的 URL 以链接保留，文字是「音频」
  const link = container.locator(`a[href="${EXTERNAL_AUDIO}"]`);
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText('音频');

  // ③ 正文其余部分照常渲染
  await expect(container).toContainText('正文。');

  // ④ 关键安全/隐私断言：阅读本身没有发起第三方请求
  expect(thirdPartyRequests, '外链音频不得让浏览器主动请求第三方地址').toBe(0);
});
