// ─────────────────────────────────────────────────────────────────────────────
// reactive-media.spec.ts —— 历史 HTML 音视频在统一引擎里的真实 DOM 与可观测行为
//
// Round4 合并：原 reactive-media.spec.ts + reactive-media-playback.spec.ts（同一域：
// 「旧 Markdown 里的音视频在阅读页被新引擎怎么处理」，造数/登录/读容器完全相同）。
//
// 旧 Markdown 白名单允许 `<video controls>` / `<source>` / `<track>` 可播放。
// 新引擎把这些区块转成受限 `site-embed kind="media"`；这条用真浏览器钉住：
//   · 仍然有 `controls`，默认 `preload="none"`，**没有 autoplay**；
//   · `<source>` 与 `<track>` 结构保留；
//   · 源码 token 不会漏到页面上。
// 2026-11-07 产品决定（R3-111）：**站内受控音频保留播放器，安全外链音频降级为可点击链接**，
// 作者原文保留；浏览器不得因为渲染页面就主动请求第三方地址。
// 不请求真实媒体（preload none + 不存在的相对地址），e2e 不依赖外网。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';
import { uniqueTag } from './helpers';

const EXTERNAL_AUDIO = 'https://media.test/tone.wav';

/**
 * 用 core 种子号经接口发一篇 internal/public 文章并返回 id。
 * 用 page.request 登录：它与页面共享 cookie，internal 文章才能被作者读到。
 */
async function createBlogAsCore(
  page: Page,
  opts: { titlePrefix: string; content: string; visibility: 'internal' | 'public' }
): Promise<string> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const created = await page.request.post('/api/blogs', {
    data: {
      title: `${opts.titlePrefix}-${uniqueTag()}`,
      description: `${opts.titlePrefix} e2e`,
      content: opts.content,
      visibility: opts.visibility,
      format: 'markdown',
    },
  });
  expect(created.status(), `发文失败：${await created.text()}`).toBe(200);
  return ((await created.json()) as { blog_id: string }).blog_id;
}

test('历史 video/source/track 在阅读页仍是受限可播放控件', async ({ page }) => {
  const blogId = await createBlogAsCore(page, {
    titlePrefix: 'media',
    visibility: 'internal',
    content: [
      '媒体兼容：',
      '',
      '<video controls>',
      '<source src="/media/not-exists.mp4" type="video/mp4">',
      '<track kind="subtitles" src="/media/not-exists.vtt" srclang="zh" label="中文字幕" default>',
      '</video>',
      '',
      '视频下方正文。',
    ].join('\n'),
  });

  await page.goto(`/blog/${blogId}`);
  const container = page.locator('#userContentContainer');
  await expect(container).toHaveAttribute('data-content-renderer', 'reactive');

  const video = container.locator('video.site-embed--media');
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('preload', 'none');
  await expect(video).not.toHaveAttribute('autoplay', /.*/);
  await expect(video.locator('source[src="/media/not-exists.mp4"][type="video/mp4"]')).toHaveCount(1);
  await expect(
    video.locator('track[src="/media/not-exists.vtt"][kind="subtitles"][srclang="zh"][label="中文字幕"]')
  ).toHaveCount(1);

  // 转换后的 token 是内部协议，绝不能以字面量漏到正文。
  await expect(container).not.toContainText('[[媒体:');
  await expect(container).not.toContainText('site-embed kind');
  // 媒体块之后还有正文（结构没把后续段落吃掉）。
  await expect(container).toContainText('视频下方正文');
});

test('历史 HTML 外链 audio 降级为可点击链接，且不触发第三方请求（R3-111）', async ({ page }) => {
  // 计数器：一旦浏览器真的去取外链音频，就会 +1。新口径下必须保持 0。
  let thirdPartyRequests = 0;
  await page.route(`${EXTERNAL_AUDIO}*`, (route) => {
    thirdPartyRequests += 1;
    return route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(0) });
  });

  const blogId = await createBlogAsCore(page, {
    titlePrefix: 'media-playback',
    visibility: 'public',
    content: `<audio controls preload="none" src="${EXTERNAL_AUDIO}"></audio>\n\n正文。`,
  });

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
