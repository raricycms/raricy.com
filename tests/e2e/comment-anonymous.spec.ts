// ─────────────────────────────────────────────────────────────────────────────
// comment-anonymous.spec.ts —— 评论区「匿名」勾选项
//
// 【为什么这些必须走真浏览器】服务端能测「DTO 里是化名、id 是 null」（见
// tests/service/comment-anonymous.test.ts），但测不到「勾选项有没有渲染出来」
//「勾了之后提交的 body 里到底带没带 anonymous」—— 那两件事在客户端组件里，
// 接口层看不见。勾选项是个纯前端状态，而它一旦没接上，表现是
// **静默地按真名发出去**（评论照常出现，只是没匿名）。
//
// 【造数纪律】e2e 的库在两次跑之间不重置，所以**不断言「第一个一定是 Alice」**
//（前面的跑法已经把号用掉了）。断的是与顺序无关的性质：有化名、带「匿名」标、
// 不可点进个人主页、头像是按化名哈希的那一支、同一个人两次同名。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Page } from '@playwright/test';
import { SEED_BLOG, SEED_USERS } from './seed';

const BLOG_URL = `/blog/${SEED_BLOG.id}`;

async function login(page: Page) {
  const res = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: 'e2e-Password-123' },
  });
  expect(res.status()).toBe(200);
}

/** 按哨兵串定位评论条目 —— 楼中楼里父级文本会包住子级，所以取最内层。 */
function commentRow(page: Page, marker: string) {
  return page.locator('.comment-item', { hasText: marker }).last();
}

test.describe('匿名评论', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('输入区有「匿名」勾选项，且它不是工具条上的 icon-btn（工具条仍是 5 颗）', async ({
    page,
  }) => {
    await page.goto(BLOG_URL);
    const composer = page.locator('.comment-composer').first();
    await expect(composer).toBeVisible();

    const anon = composer.locator('.comment-composer__anon input[type="checkbox"]');
    await expect(anon, '勾选项必须渲染出来，否则匿名无从发起').toBeVisible();
    await expect(anon).not.toBeChecked();
    // 工具条数量没被这个勾选项顶掉（comment-rich.spec.ts 钉死为 5）
    await expect(composer.locator('.comment-composer__icon-btn')).toHaveCount(5);
  });

  test('★ 走输入区勾上匿名发出：页面显示化名 + 「匿名」标，且点不进个人主页', async ({ page }) => {
    const marker = `e2e-anon-${Date.now().toString(36)}`;
    await page.goto(BLOG_URL);
    const composer = page.locator('.comment-composer').first();
    await composer.locator('.comment-composer__input').fill(marker);
    await composer.locator('.comment-composer__anon input[type="checkbox"]').check();
    await composer.locator('.comment-composer__send').click();

    const row = commentRow(page, marker);
    await expect(row).toBeVisible();
    // 有「匿名」小标 —— 光一个化名读者看不出那是化名
    await expect(row.locator('.comment-author-anon')).toBeVisible();
    // ★ 关键：名字**不可点** —— 能点进 /u/<id> 就等于把人认出来了
    await expect(row.locator('.comment-meta a.comment-author-link')).toHaveCount(0);
    // 头像是按化名哈希的那一支（anon~ 命名空间，绝不读 instance/avatars/<种子>.png）
    const src = await row.locator('.comment-author-avatar').getAttribute('src');
    expect(src ?? '').toContain('/api/avatar/anon~');

    // 同一个人再发一条匿名 → 化名必须一模一样
    const first = (await row.locator('.comment-meta span').first().textContent()) ?? '';
    const marker2 = `${marker}-b`;
    await composer.locator('.comment-composer__input').fill(marker2);
    // 勾选状态是**黏**的（提交后不重置），这里再确认一次，防止实现改成重置
    await composer.locator('.comment-composer__anon input[type="checkbox"]').check();
    await composer.locator('.comment-composer__send').click();
    const row2 = commentRow(page, marker2);
    await expect(row2.locator('.comment-author-anon')).toBeVisible();
    const second = (await row2.locator('.comment-meta span').first().textContent()) ?? '';
    expect(second, '同一个人在同一篇文章下必须始终同一个化名').toBe(first);
  });

  test('接口层：anonymous 提交回来的 author.id 是 null（真 id 绝不落到页面上）', async ({
    page,
  }) => {
    const marker = `e2e-anonapi-${Date.now().toString(36)}`;
    const res = await page.request.post(`/api/blogs/${SEED_BLOG.id}/comments`, {
      data: { content: marker, anonymous: true },
    });
    expect(res.status(), await res.text()).toBe(200);
    const json = (await res.json()) as {
      comment: { anonymous: boolean; is_mine: boolean; author: { id: string | null; username: string | null } };
    };
    expect(json.comment.anonymous).toBe(true);
    expect(json.comment.author.id).toBeNull();
    expect(json.comment.author.username).toBeTruthy();

    // 列表接口（GET）里同样如此 —— 那条路是另一个序列化出口
    const list = await page.request.get(`/api/blogs/${SEED_BLOG.id}/comments`);
    const tree = (await list.json()) as {
      comments: { content: string; anonymous: boolean; author: { id: string | null } }[];
    };
    const mine = tree.comments.find((c) => c.content === marker);
    expect(mine, '刚发的匿名评论应出现在树里').toBeTruthy();
    expect(mine!.anonymous).toBe(true);
    expect(mine!.author.id).toBeNull();
  });

  test('不勾匿名就是实名（勾选项不许默认打开）', async ({ page }) => {
    const marker = `e2e-real-${Date.now().toString(36)}`;
    const res = await page.request.post(`/api/blogs/${SEED_BLOG.id}/comments`, {
      data: { content: marker },
    });
    expect(res.status()).toBe(200);
    const json = (await res.json()) as {
      comment: { anonymous: boolean; author: { id: string | null } };
    };
    expect(json.comment.anonymous).toBe(false);
    expect(json.comment.author.id, '实名评论照旧给真 id（要能点进主页）').toBeTruthy();

    await page.goto(BLOG_URL);
    const row = commentRow(page, marker);
    await expect(row.locator('.comment-author-anon')).toHaveCount(0);
    await expect(row.locator('.comment-meta a.comment-author-link')).toHaveCount(1);
  });
});
