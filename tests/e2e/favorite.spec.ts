// 收藏夹：端到端（真浏览器 + 真 API + 真库）
//
// 【为什么这些必须走 e2e，service/route 用例证明不了】
//   · **卡片能不能活下来**：`[@六位]` 的卡片是在 marked/DOMPurify **之前**拼进正文的，
//     所以「卡片真的出现在页面 DOM 里」只有真渲染才能证明。净化白名单少一个标签、
//     或者哪天有人把 ALLOW_DATA_ATTR 的教训忘了改成占位式实现，这里会立刻红。
//   · **私密收藏夹页面上一个 ID 都不许出现**：需求原话是「不在任何页面的任何地方
//     显式显示私密收藏夹 id」。断言必须落在**渲染后的文本**上 —— 接口返回什么字段
//     证明不了页面上有没有印出来。
//   · **星标按钮没有计数徽标**：同理，是 DOM 事实。
//   · **作者不收通知**：跨两个账号的会话，只有在同一个浏览器 context 里轮流登录才顺。
//
// 【必须用一次性用户】本文件里全是按用户计限频的写操作（建收藏夹 20/时）。helpers.ts
// 的注释记着同一条教训：种子号（e2e_core / e2e_admin）的限频桶被 desktop 与 mobile
// 两个 project 共用，前一轮的配额没滑出窗口，后一轮会在**首条**操作上吃 429。
// 所以一律 registerFreshUser()。

import { test, expect } from '@playwright/test';
import { registerFreshUser, loginViaApi, uniqueTag } from './helpers';
import { SEED_PASSWORD, SEED_USERS } from './seed';

/** 建一篇博客（走真实接口），返回 id。 */
async function createBlog(
  page: import('@playwright/test').Page,
  title: string,
  content = '# 正文'
): Promise<string> {
  const res = await page.request.post('/api/blogs', {
    data: { title, description: 'e2e 造数', content },
  });
  expect(res.status(), `建文章失败：${await res.text()}`).toBe(200);
  // 字段名是 blog_id（对齐 Flask），不是 id
  const body = await res.json();
  expect(body.blog_id, `建文章没回 blog_id：${JSON.stringify(body)}`).toBeTruthy();
  return body.blog_id as string;
}

test('收藏一篇博客：星标变「已收藏」，且按钮上没有计数徽标', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `收藏用例 ${uniqueTag()}`);

  await page.goto(`/blog/${blogId}`);
  const btn = page.locator('#favorite-btn');
  await expect(btn).toBeVisible();
  await expect(btn).toContainText('收藏');
  await expect(btn).not.toContainText('已收藏');
  // ★ 需求：站内不显示一篇文章的被收藏数 —— 按钮上不许有计数徽标
  await expect(btn.locator('.like-count-badge, .fish-count-badge')).toHaveCount(0);

  // 建一个私密收藏夹并顺手收藏本文（选择器里的「创建私密收藏夹」）
  await btn.click();
  const modal = page.locator('#favoritePickerModal.is-open');
  await expect(modal).toBeVisible();
  await modal.locator('.favorite-picker__input').fill('我的私藏');
  await modal.getByRole('button', { name: '创建私密收藏夹' }).click();

  await expect(btn).toContainText('已收藏', { timeout: 15_000 });

  // 关掉弹窗再看一眼按钮：仍然没有计数徽标（收藏后也不许冒出来）
  await page.keyboard.press('Escape');
  await expect(btn.locator('.like-count-badge, .fish-count-badge')).toHaveCount(0);

  // 刷新后状态保持（说明是真写进库了，不是前端自作主张）
  await page.reload();
  await expect(page.locator('#favorite-btn')).toContainText('已收藏');
});

test('私密收藏夹：页面上**一个 ID 都不出现**，也没有二维码入口', async ({ page }) => {
  const user = await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `私密用例 ${uniqueTag()}`);

  // 直接建一个私密收藏夹并把文章放进去
  const created = await (
    await page.request.post('/api/favorites', { data: { title: '私密夹子', isPublic: false } })
  ).json();
  expect(created.code, JSON.stringify(created)).toBe(200);
  expect(created.favorite.public_id).toBeNull(); // 私密收藏夹**没有** 6 位句柄

  await page.request.post(`/api/favorites/${created.favorite.id}/items`, {
    data: { blogId },
  });

  await page.goto(`/favorite/mine/${created.favorite.id}`);
  const body = page.locator('body');
  await expect(body).toContainText('私密夹子');
  await expect(body).toContainText('私密');

  // ★ 需求核心：整个页面的文本里不许出现任何 6 位数字句柄
  const text = (await body.innerText()).replace(/\s+/g, '');
  expect(text, '私密收藏夹的页面上出现了 6 位 ID').not.toMatch(/\d{6}/);
  // 也没有二维码入口（二维码只对公开收藏夹生成）
  await expect(page.getByRole('button', { name: /分享二维码/ })).toHaveCount(0);

  // 导出**可以**用（需求：私密也能导出 JSON），且导出物里没有句柄 / 性质字段
  const exported = await page.request.get(`/api/favorites/${created.favorite.id}/export`);
  expect(exported.status()).toBe(200);
  const raw = await exported.text();
  expect(raw).not.toContain(created.favorite.id);
  expect(raw).not.toContain('publicId');
  expect(raw).not.toContain('isPublic');
  expect(JSON.parse(raw).blogs).toHaveLength(1);

  // 免认证的读取接口够不着它（私密没有句柄，取 UUID 前 6 位也查不到）
  const spider = await page.request.get(`/api/spider/favorites/${created.favorite.id.slice(0, 6)}`);
  expect(spider.status()).toBe(404);
  void user;
});

test('公开收藏夹：显示 6 位 ID、有二维码入口、免认证接口可读', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `公开用例 ${uniqueTag()}`);

  const created = await (
    await page.request.post('/api/favorites', { data: { title: '公开夹子', isPublic: true } })
  ).json();
  const publicId: string = created.favorite.public_id;
  expect(publicId).toMatch(/^[0-9]{6}$/);
  await page.request.post(`/api/favorites/${created.favorite.id}/items`, { data: { blogId } });

  await page.goto(`/favorite/${publicId}`);
  await expect(page.locator('body')).toContainText('公开夹子');
  await expect(page.locator('.favorite-handle')).toContainText(publicId);
  // 公开的才有二维码入口（画报由 PosterModal 打开，图在点开时才取）
  await expect(page.getByRole('button', { name: /分享二维码/ })).toBeVisible();

  // 免认证读得到：拿一个**没有会话**的 context 去打
  const anon = await page.context().browser()!.newContext();
  const res = await anon.request.get(`/api/spider/favorites/${publicId}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.id).toBe(publicId);
  expect(body.title).toBe('公开夹子');
  expect(body.blogs).toHaveLength(1);
  await anon.close();

  // 不存在的 ID → 404
  const missing = await page.request.get('/api/spider/favorites/000001');
  expect(missing.status()).toBe(404);
});

test('复制公开收藏夹 → 自己得到一份**私密**副本（且是快照）', async ({ page }) => {
  // 原作者建一个公开收藏夹
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `被复制的文章 ${uniqueTag()}`);
  const src = await (
    await page.request.post('/api/favorites', { data: { title: '别人的合辑', isPublic: true } })
  ).json();
  await page.request.post(`/api/favorites/${src.favorite.id}/items`, { data: { blogId } });

  // 换一个用户来复制
  const copier = await registerFreshUser(page, { core: true });
  await page.goto(`/favorite/${src.favorite.public_id}`);

  // 复制按钮旁边必须有「快照」的说明（需求明确要求提示用户之后各走各的）
  await expect(page.locator('body')).toContainText('快照');

  await page.getByRole('button', { name: '复制为私密收藏夹' }).click();
  // 复制完会跳到新那份的管理页
  await page.waitForURL(/\/favorite\/mine\//, { timeout: 15_000 });
  const body = page.locator('body');
  await expect(body).toContainText('别人的合辑');
  await expect(body).toContainText('私密');
  await expect(body).toContainText('被复制的文章');
  // 副本归复制者，且没有句柄
  const text = (await body.innerText()).replace(/\s+/g, '');
  expect(text, '复制出来的私密副本页面上出现了 6 位 ID').not.toMatch(/\d{6}/);

  // 源收藏夹仍然属于原作者（复制不会把原的搬走）
  await loginViaApi(page, copier.username);
  const mine = await (await page.request.get('/api/favorites')).json();
  expect(mine.favorites.some((f: { title: string }) => f.title === '别人的合辑')).toBe(true);
});

test('[@六位ID] 在博客正文里展开成卡片；6 位字母不展开', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const target = await createBlog(page, `被收藏的文章 ${uniqueTag()}`);
  const fav = await (
    await page.request.post('/api/favorites', { data: { title: '可嵌入的夹子', isPublic: true } })
  ).json();
  await page.request.post(`/api/favorites/${fav.favorite.id}/items`, {
    data: { blogId: target },
  });
  const publicId: string = fav.favorite.public_id;

  // 正文里同时写：真的引用、6 位**字母**（不该被当成收藏夹）、以及代码块里的引用
  const host = await createBlog(
    page,
    `嵌入了收藏夹的文章 ${uniqueTag()}`,
    [
      `看这个合辑：[@${publicId}]`,
      '',
      '这个是字母：[@abcdef]',
      '',
      '代码里的不展开：`[@' + publicId + ']`',
    ].join('\n')
  );

  await page.goto(`/blog/${host}`);
  const article = page.locator('article.blog-detail');

  // ★ 卡片活下来了 —— 这一条同时证明了净化白名单放得过它
  const card = article.locator('.favorite-embed');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('.favorite-embed__title')).toContainText('可嵌入的夹子');
  await expect(card.locator('.favorite-embed__count')).toContainText('共 1 篇');
  await expect(card.locator('.favorite-embed__item')).toContainText('被收藏的文章');
  // 卡片上的链接指向文章
  expect(await card.locator('.favorite-embed__item').getAttribute('href')).toMatch(/^\/blog\//);

  // 6 位字母原样保留（没被当成收藏夹去请求）
  await expect(article).toContainText('[@abcdef]');
  // 代码块里的引用不展开
  await expect(article.locator('code')).toContainText(`[@${publicId}]`);
});

test('[@六位ID] 在评论里**不**展开（与投票同一口径）', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `评论引用用例 ${uniqueTag()}`);
  const fav = await (
    await page.request.post('/api/favorites', { data: { title: '不展开的夹子', isPublic: true } })
  ).json();
  const publicId: string = fav.favorite.public_id;

  const posted = await page.request.post(`/api/blogs/${blogId}/comments`, {
    data: { content: `试试引用 [@${publicId}] 在这里会怎样` },
  });
  expect(posted.status(), await posted.text()).toBe(200);

  await page.goto(`/blog/${blogId}`);
  const comments = page.locator('.comment-list, #comments, .comments');
  await expect(comments.first()).toContainText(`[@${publicId}]`);
  // 评论里**没有**卡片
  await expect(page.locator('.comment-list .favorite-embed, .comments .favorite-embed')).toHaveCount(0);
});

test('作者不会收到收藏通知（收藏刻意不推）', async ({ page }) => {
  // 作者发一篇
  await registerFreshUser(page, { core: true });
  const authorName = (await (await page.request.get('/api/auth/me')).json()).user?.username;
  const blogId = await createBlog(page, `不该收到通知的文章 ${uniqueTag()}`);

  // 换人收藏它
  await registerFreshUser(page, { core: true });
  const fav = await (
    await page.request.post('/api/favorites', { data: { title: '收藏了', isPublic: false } })
  ).json();
  const added = await page.request.post(`/api/favorites/${fav.favorite.id}/items`, {
    data: { blogId },
  });
  expect(added.status(), await added.text()).toBe(200);

  // 换回作者，看通知数
  await loginViaApi(page, authorName!);
  const count = await (await page.request.get('/api/notifications/count')).json();
  expect(count.count, '作者收到了收藏通知 —— 需求要求收藏不推通知').toBe(0);
});

test('非 core 用户：页面与接口同档，两边都挡（档位阶梯）', async ({ page }) => {
  // 收藏夹与点赞/投喂同档（core+）。「页面与接口必须同档，每层都自己判」是
  // CLAUDE.md 的硬约定 —— 页面挡了而接口没挡，就等于「用不了界面但 curl 得动」。
  await loginViaApi(page, SEED_USERS.plain.username);

  const api = await page.request.get('/api/favorites');
  expect(api.status(), '接口没挡住非 core 用户').toBe(403);

  // 页面：已登录但档位不够 → 原地 403（不是重定向到登录页）
  const res = await page.goto('/favorite');
  expect(res?.status()).toBe(403);

  // 建收藏夹也必须被挡（写路径同样每一层自己判）
  const post = await page.request.post('/api/favorites', {
    data: { title: '不该建出来', isPublic: true },
  });
  expect(post.status()).toBe(403);
});

test('未登录访客：/favorite 跳到登录页并带 next 回跳', async ({ page }) => {
  const fresh = await page.context().browser()!.newContext();
  const guest = await fresh.newPage();
  await guest.goto('/favorite');
  await expect(guest).toHaveURL(/\/login\?next=/);
  await fresh.close();
  void SEED_PASSWORD;
});

test('工具箱「站务工具」里有「我的收藏夹」入口，点进去就是管理页', async ({ page }) => {
  // 这条钉的是一个**曾经完全缺失**的东西：/favorite 是「创建 / 改名 / 删除 / 导出 /
  // 导入」的唯一页面，但它当时不在任何导航、任何菜单、任何页面里 —— 只能手敲 URL。
  // 功能做完了却进不去，等于没做。所以入口本身要有用例，而不只是页面能打开。
  //
  // 入口后来搬了家：从顶栏用户下拉菜单挪到 /tool 的「站务工具」区（与云剪贴板 /
  // 投票箱并列）。搬的是门牌号，不是这条用例的意思 —— 「入口存在且点得进去」不变。
  await registerFreshUser(page, { core: true });
  await page.goto('/tool');

  // 站务工具区默认就展开（编码 / 加密两组才收在「更多开发者工具」里）
  const entry = page.locator('a.tool-new-card[href="/favorite"]');
  await expect(entry).toBeVisible();
  await entry.click();

  await page.waitForURL(/\/favorite$/, { timeout: 15_000 });
  await expect(page.locator('h1')).toContainText('我的收藏夹');
});
