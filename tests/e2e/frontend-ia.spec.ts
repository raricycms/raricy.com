import { test, expect, type Page } from '@playwright/test';
import { freshInvite, publishBlog, registerFreshUser, uniqueTag } from './helpers';
import { SEED_PASSWORD } from './seed';

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test('邀请注册必填，成功直接登录并返回原任务；一言无文章时保留导航', async ({ page }) => {
  const invite = await freshInvite(page);
  await page.context().clearCookies();
  const tag = uniqueTag();
  const data = { username: 'ia_' + tag, email: tag + '@e2e.local', password: SEED_PASSWORD };
  for (const invite_code of [undefined, '   ']) {
    const denied = await page.request.post('/api/auth/register', { data: { ...data, invite_code } });
    expect(denied.status()).toBe(400);
  }
  await page.goto('/register?next=' + encodeURIComponent('/quotes/history?page=2'));
  await expect(page.locator('#inviteCode')).toHaveAttribute('required', '');
  await page.locator('#inviteCode').fill(invite);
  await page.locator('#username').fill(data.username);
  await page.locator('#email').fill(data.email);
  await page.locator('#password').fill(data.password);
  await page.locator('#confirmPassword').fill(data.password);
  await page.locator('#agreeTerms').check();
  await page.locator('#submitBtn').click();
  await expect(page).toHaveURL('/quotes/history?page=2');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('往期一言');
  await expect(page.getByRole('navigation', { name: '每日一言' }).locator('a, [aria-current]')).toHaveCount(4);
  await expect(page.locator('.daily-quote-state')).toBeVisible();
  for (const [old, target] of [['/checkin/quotes?page=3', '/quotes/history?page=3'], ['/favorite/quotes?page=2', '/quotes/saved?page=2'], ['/checkin/submissions', '/quotes/submissions']]) {
    await page.goto(old);
    await expect(page).toHaveURL(target);
    await expect(page.getByRole('navigation', { name: '每日一言' })).toBeVisible();
  }
  await noOverflow(page);
});

test('设置按任务分组，外观直达对应商品，旧市场锚点兼容', async ({ page }, testInfo) => {
  await registerFreshUser(page, { core: true });
  await page.goto('/settings');
  const nav = page.getByRole('navigation', { name: '设置分组' });
  await expect(nav.locator('a')).toHaveCount(5);
  expect((await page.locator('.settings-section__title').first().boundingBox())!.x).toBeGreaterThanOrEqual(16);
  await expect(page.locator('#appearance a[href="/fish/shop?category=frame#shop"]')).toBeVisible();
  await expect(page.locator('#appearance a[href="/fish/shop?category=bubble#shop"]')).toBeVisible();
  await nav.getByRole('link', { name: '外观', exact: true }).click();
  await expect(page).toHaveURL('/settings#appearance');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('settings-appearance.png') });
  await page.goto('/fish/market#shop');
  await expect(page).toHaveURL('/fish/shop#shop');
  await expect(page.locator('.market-card').filter({ hasText: '收款人' })).toHaveCount(0);
  await page.goto('/fish');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('fish-account.png'), fullPage: true });
  await page.context().clearCookies();
  await page.goto('/fish/shop?category=bubble');
  await expect(page.locator('#loginForm')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('next')).toBe('/fish/shop?category=bubble');
});

test('文档按受众定位，重复指南与旧手工间路径跳转至规范地址', async ({ page }, testInfo) => {
  await page.goto('/docs');
  await expect(page.getByRole('navigation', { name: '文档受众' }).locator('a')).toHaveCount(3);
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('docs-index.png') });
  await page.getByRole('navigation', { name: '文档受众' }).locator('a').last().click();
  await expect(page).toHaveURL('/docs#docs-dev');
  await page.goto('/docs/guide/' + encodeURIComponent('云剪贴板使用指南'));
  await expect(page).toHaveURL('/clipboard/guide');
  await expect(page.getByRole('link', { name: /返回/ }).first()).toHaveAttribute('href', '/clipboard');
  await page.goto('/game');
  await expect(page.locator('.game-collection')).toHaveCount(2);
  await expect(page.locator('a.game-collection[href="/game/collections/craft"]')).toBeVisible();
  await page.goto('/game/collections/test/craft');
  await expect(page).toHaveURL('/game/collections/craft');
  await expect(page.locator('.game-card')).toHaveCount(3);
  await noOverflow(page);
});

test('评论输入只留一次快捷键，字数临近时提示并关联输入框', async ({ page, isMobile }, testInfo) => {
  await registerFreshUser(page, { core: true });
  const id = await publishBlog(page);
  await page.goto('/blog/' + id);
  const input = page.locator('.comment-composer__input');
  const composer = page.locator('.comment-composer');
  await expect(input).toBeVisible();
  await expect(composer).not.toContainText(/5000|支持 Markdown|Enter 发送/);
  await expect(composer.locator('.comment-composer__hint')).toHaveCount(0);
  if (!isMobile) await expect(input).toHaveAttribute('placeholder', /Enter/);
  await input.fill('文'.repeat(4500));
  const hint = composer.locator('.comment-composer__hint');
  await expect(hint).toBeVisible();
  await expect(input).toHaveAttribute('aria-describedby', await hint.getAttribute('id') as string);
  await input.fill('');
  await expect(hint).toHaveCount(0);
  await input.scrollIntoViewIfNeeded();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('comment-composer.png') });
});

test('对外文章默认访客预览，切换后可以展开成员引用，再切回不残留', async ({ page }, testInfo) => {
  await registerFreshUser(page, { core: true });
  const secret = '仅成员片段' + uniqueTag();
  const clipResponse = await page.request.post('/api/clipboard', { data: { title: secret, content: secret, publicity: true } });
  expect(clipResponse.status()).toBe(200);
  const clip = await clipResponse.json();
  const response = await page.request.post('/api/blogs', { data: { title: '访客预览', description: '引用边界', visibility: 'public', content: '正文 [@' + clip.id + ']' } });
  expect(response.status()).toBe(200);
  const blog = await response.json();
  await page.goto('/blog/' + blog.blog_id + '/edit');
  const mode = page.getByRole('checkbox', { name: '访客视角预览' });
  await expect(mode).toBeChecked();
  await page.locator('#editor').getByRole('button', { name: '预览', exact: true }).click();
  const preview = page.locator('#editor .md-editor__preview-body');
  await expect(preview).toContainText('[@' + clip.id + ']');
  await expect(preview).not.toContainText(secret);
  await mode.uncheck();
  await expect(preview).toContainText(secret);
  await mode.check();
  await expect(preview).not.toContainText(secret);
  await expect(preview).toContainText('[@' + clip.id + ']');
  await page.locator('#format').selectOption('reactive');
  await expect(preview).toContainText('[@' + clip.id + ']');
  await expect(preview).not.toContainText(secret);
  await mode.uncheck();
  await expect(preview).toContainText(secret);
  await mode.check();
  await expect(preview).not.toContainText(secret);
  await noOverflow(page);
  await preview.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('visitor-preview.png') });
});

test('投票默认提供有效结构，仅临近文字或选项上限时提示', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  await page.goto('/vote/create');
  await expect(page.locator('.vote-option-input')).toHaveCount(2);
  await expect(page.locator('.vote-form [role="status"]')).toHaveCount(0);
  await page.locator('#title').fill('题'.repeat(180));
  await expect(page.locator('#vote-title-limit')).toContainText('180 / 200');
  await page.locator('.vote-option-input').first().fill('选'.repeat(200));
  await expect(page.locator('#vote-option-limit')).toBeVisible();
  for (let i = 2; i < 10; i++) await page.locator('#addOption').click();
  await expect(page.locator('#addOption')).toBeDisabled();
  await expect(page.locator('#addOption')).toHaveText('已达选项上限');
  await noOverflow(page);
});


test('public 与 link 的两种正文格式：有无 JavaScript 都不泄露站内片段正文或元数据', async ({ page, browser }) => {
  await registerFreshUser(page, { core: true });
  const marker = '站内载荷哨兵' + uniqueTag();
  const clips: string[] = [];
  for (const publicity of [true, false]) {
    const response = await page.request.post('/api/clipboard', { data: { title: marker, content: marker, publicity } });
    expect(response.status()).toBe(200);
    clips.push((await response.json()).id);
  }
  await page.goto('/quotes');
  const origin = new URL(page.url()).origin;
  for (const format of ['markdown', 'reactive']) {
    for (const visibility of ['public', 'link']) {
      const content = '# 访客可见正文\n\n' + clips.map(id => '[@' + id + ']').join('\n\n');
      const response = await page.request.post('/api/blogs', { data: { title: '引用边界', description: '访客验证', content, format, visibility } });
      expect(response.status()).toBe(200);
      const id = (await response.json()).blog_id;
      for (const javaScriptEnabled of [true, false]) {
        const guest = await browser.newContext({ javaScriptEnabled });
        try {
          const tab = await guest.newPage();
          const clipReads: string[] = [];
          tab.on('request', request => { if (request.url().includes('/api/clipboard/')) clipReads.push(request.url()); });
          const result = await tab.goto(origin + '/blog/' + id);
          expect(result?.status()).toBe(200);
          expect(await result!.text()).not.toContain(marker);
          const body = tab.locator('#userContentContainer');
          // 旧 Markdown 阅读器依赖 JS；无 JS 时只检查载荷。Reactive 静态正文仍可读。
          if (javaScriptEnabled || format === 'reactive') {
            for (const clip of clips) await expect(body).toContainText('[@' + clip + ']');
          }
          await expect(body).not.toContainText(marker);
          expect(clipReads).toEqual([]);
        } finally { await guest.close(); }
      }
    }
  }
});
