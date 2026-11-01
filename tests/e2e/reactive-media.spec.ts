// ─────────────────────────────────────────────────────────────────────────────
// reactive-media.spec.ts —— 历史 HTML 音视频在统一引擎里的真实 DOM
//
// 旧 Markdown 白名单允许 `<video controls>` / `<source>` / `<track>` 可播放。
// 新引擎把这些区块转成受限 `site-embed kind="media"`；这条用真浏览器钉住：
//   · 仍然有 `controls`，默认 `preload="none"`，**没有 autoplay**；
//   · `<source>` 与 `<track>` 结构保留；
//   · 源码 token 不会漏到页面上。
// 不请求真实媒体（preload none + 不存在的相对地址），e2e 不依赖外网。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';
import { uniqueTag } from './helpers';

test('历史 video/source/track 在阅读页仍是受限可播放控件', async ({ page }) => {
  // 用 page.request 登录：它和页面共享 cookie，internal 文章才能被作者读到。
  const login = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const content = [
    '媒体兼容：',
    '',
    '<video controls>',
    '<source src="/media/not-exists.mp4" type="video/mp4">',
    '<track kind="subtitles" src="/media/not-exists.vtt" srclang="zh" label="中文字幕" default>',
    '</video>',
    '',
    '视频下方正文。',
  ].join('\n');

  const created = await page.request.post('/api/blogs', {
    data: {
      title: `media-${uniqueTag()}`,
      description: 'media e2e',
      content,
      visibility: 'internal',
      format: 'markdown',
    },
  });
  expect(created.status(), `发文失败：${await created.text()}`).toBe(200);
  const { blog_id: blogId } = (await created.json()) as { blog_id: string };

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

  // 媒体块内部的多行标签不能变成多个软换行：播放器到下一段之间只应有正常
  // 段落间距（修复前实测约 170px 的空洞，来自 token 后残留的 <br>）。
  const videoBox = await video.boundingBox();
  const anchorBox = await container.getByText('视频下方正文', { exact: false }).boundingBox();
  expect(videoBox, '播放器没有布局盒').not.toBeNull();
  expect(anchorBox, '播放器后的正文没有布局盒').not.toBeNull();
  const gap = anchorBox!.y - (videoBox!.y + videoBox!.height);
  expect(gap, '播放器与下一段之间的空白异常').toBeLessThan(80);

  // 转换后的 token 是内部协议，绝不能以字面量漏到正文。
  await expect(container).not.toContainText('[[媒体:');
  await expect(container).not.toContainText('site-embed kind');
});
