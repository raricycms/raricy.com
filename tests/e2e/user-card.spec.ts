// ─────────────────────────────────────────────────────────────────────────────
// user-card.spec.ts —— 用户名片 `[@用户/<用户名>]`（讨论 + 评论）
//
// 【为什么必须走真浏览器】服务端不渲染评论 / 讨论正文（没有 window，DOMPurify 会静默
// 降级成转义纯文本），所以「名片有没有画出来」「头像框在不在」在接口层看不出来 ——
// 接口返回的 content 本来就是原文。单测（tests/unit/user-refs.test.ts）管语法与安全
// 边界，这里管「装到页面上之后还是对的」。
//
// 覆盖面：
//   · 讨论：token → 行内名片（头像 + **头像框** + 用户名），整体是指向 /u/<id> 的链接
//   · 评论：同一条管线（两个薄壳共用 RichContentBody）
//   · **不算 @ 提及**：不产生通知，也不给气泡加提及高亮（正对照：真的 @ 会产生通知）
//   · 工具栏入口：搜人 → token 插进输入框、**不发送**（草稿保住）
//   · 查无此人 → 原样显示字面量
//   · 接口契约：按 id 匿名可达、按名字要 core+；**中文用户名**那条路真的通（编码）
//
// 【头像框为什么在这里验】名片是**手搭 DOM** 的头像落点（用不了 <Avatar> 组件），
// 而那正是「框会静默消失」的高危处 —— tests/unit/avatar-sites-guard.test.ts 只能静态
// 拦「有没有写 avatar__frame」，真正显示出来只有真浏览器看得见。
//
// 【造数纪律】大区是全站共用频道，定位一律用本轮 uniqueTag 的哨兵串锚定。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Page } from '@playwright/test';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';
import { SEED_BLOG, SEED_FRAME_KEY, SEED_PASSWORD, SEED_USERS } from './seed';

const LOBBY = 'lobby';
const BLOG_URL = `/blog/${SEED_BLOG.id}`;

/** 种子里那个**戴着永久头像框**的 core 账号 —— 名片上的框就照它验。 */
const FRAMED = SEED_USERS.framed;
const FRAME_SRC = `/api/frames/${SEED_FRAME_KEY}`;
const CARD_TOKEN = `[@用户/${FRAMED.username}]`;

/** 走接口发一条大区消息。 */
async function postMessage(page: Page, content: string) {
  const res = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, { data: { content } });
  expect(res.status(), `发消息失败：${await res.text()}`).toBe(200);
}

/** 按哨兵串定位消息行。 */
function msgRow(page: Page, marker: string) {
  return page.locator('.chat-msg', {
    has: page.locator('.chat-msg__content', { hasText: marker }),
  });
}

/** 当前身份收到的「讨论提及」通知条数（与页面渲染同一份数据）。 */
async function mentionCount(page: Page): Promise<number> {
  const res = await page.request.get('/api/notifications?page=1');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { notifications: { action: string }[] };
  return body.notifications.filter((n) => n.action === '讨论提及').length;
}

test.describe('用户名片：渲染', () => {
  test('★ 讨论区：token 渲染成「头像 + 头像框 + 用户名」，点进主页', async ({ page }) => {
    await loginViaApi(page, FRAMED.username);
    const marker = uniqueTag();
    await postMessage(page, `${marker} 来认识一下 ${CARD_TOKEN} 吧`);
    await page.goto(`/chat?channel=${LOBBY}`);

    const card = msgRow(page, marker).locator('.rich-user-ref');
    await expect(card).toHaveCount(1);
    // 整体是一个链接，指向主页
    await expect(card).toHaveAttribute('href', `/u/${FRAMED.id}`);
    // 头像走站内那条恒定可推导的地址
    await expect(card.locator('img.avatar__img')).toHaveAttribute(
      'src',
      `/api/avatar/${FRAMED.id}`
    );
    // ★ 头像框真的画出来了 ★ —— 手搭 DOM 的那条路上，这一条没有任何接口或单测能替代
    await expect(card.locator('img.avatar__frame')).toHaveAttribute('src', FRAME_SRC);
    await expect(card.locator('.rich-user-ref__name')).toHaveText(FRAMED.username);
    // 行内：文字与名片在同一个段落里，没被拆成块
    await expect(msgRow(page, marker).locator('.chat-msg__md p')).toHaveCount(1);
    // 原始 token 不该留在页面上
    await expect(msgRow(page, marker)).not.toContainText('[@用户/');
  });

  test('★ 名片**不算 @ 提及**：气泡不加提及高亮', async ({ page }) => {
    // 自己发自己的名片：若有人把 token 当成提及，这里就会亮（isMentioned 与
    // extractMentions 是两条独立实现，这条钉的是前端那条）
    await loginViaApi(page, FRAMED.username);
    const marker = uniqueTag();
    await postMessage(page, `${marker} ${CARD_TOKEN}`);
    await page.goto(`/chat?channel=${LOBBY}`);

    await expect(msgRow(page, marker).locator('.rich-user-ref')).toHaveCount(1);
    await expect(msgRow(page, marker).locator('.chat-msg__content--mention')).toHaveCount(0);
  });

  test('评论区：同一条管线（评论正文里也画得出来）', async ({ page }) => {
    await loginViaApi(page, FRAMED.username);
    const marker = uniqueTag();
    const res = await page.request.post(`/api/blogs/${SEED_BLOG.id}/comments`, {
      data: { content: `${marker} 推荐 ${CARD_TOKEN}` },
    });
    expect(res.status(), `发评论失败：${await res.text()}`).toBe(200);

    await page.goto(BLOG_URL);
    const row = page.locator('.comment-item', { hasText: marker }).last();
    const card = row.locator('.rich-user-ref');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('href', `/u/${FRAMED.id}`);
    await expect(card.locator('img.avatar__frame')).toHaveAttribute('src', FRAME_SRC);
    await expect(card.locator('.rich-user-ref__name')).toHaveText(FRAMED.username);
  });

  test('查无此人 → 原样显示字面量（fail-closed，不报错也不留半张卡）', async ({ page }) => {
    await loginViaApi(page, FRAMED.username);
    const marker = uniqueTag();
    await postMessage(page, `${marker} [@用户/并不存在的人]`);
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = msgRow(page, marker);
    await expect(row.locator('.rich-user-ref')).toHaveCount(0);
    await expect(row).toContainText('[@用户/并不存在的人]');
  });
});

test.describe('用户名片：不发通知', () => {
  test('★ 被发名片的人铃铛不动；正对照：真的 @ 会响', async ({ page, browser }) => {
    const me = await registerFreshUser(page, { core: true });
    expect(await mentionCount(page), '刚注册不该有任何通知').toBe(0);

    // 另一个人（用独立上下文）来发名片
    const other = await browser.newContext();
    try {
      const speaker = await other.newPage();
      await loginViaApi(speaker, SEED_USERS.admin.username);
      const marker = uniqueTag();
      await speaker.request.post(`/api/chat/channels/${LOBBY}/messages`, {
        data: { content: `${marker} [@用户/${me.username}]` },
      });

      expect(await mentionCount(page), '名片是「展示」不是「呼叫」，不该进铃铛').toBe(0);

      // 正对照：真的 @ 一定要响 —— 否则上面那条 0 可能只是「通知整个没工作」
      await speaker.request.post(`/api/chat/channels/${LOBBY}/messages`, {
        data: { content: `@${me.username} 在吗` },
      });
      expect(await mentionCount(page), '正对照：@ 提及必须产生通知').toBe(1);
    } finally {
      await other.close();
    }
  });
});

test.describe('用户名片：输入区入口', () => {
  test('工具栏搜人 → token 插进输入框、**不发送**', async ({ page }) => {
    await loginViaApi(page, FRAMED.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    const composer = page.locator('.chat-composer');
    await composer.getByRole('button', { name: '发送用户名片' }).click();

    const panel = page.locator('.user-picker');
    await expect(panel).toBeVisible();
    await panel.getByPlaceholder('搜索用户名…').fill(FRAMED.username);

    // 点搜索结果里那个人。
    // ⚠️ 用户名的搜索是**子串**匹配（服务端 `contains`），所以还得**精确**认出那一格：
    // `e2e_framed` 会同时搜出 `e2e_framed_idle` / `e2e_framed_expired` 几个种子号，
    // 而列表按注册时间倒序，`.first()` 挑到的多半不是它。
    // 行内按钮的可访问名 = 它的文本 = 用户名（头像的 alt 是空的，不参与），
    // 于是 exact 匹配正好挑中那一格
    await panel.getByRole('button', { name: FRAMED.username, exact: true }).click();

    // ① 面板关掉 ② token 进了输入框 ③ **没发出去**（草稿还在，这是「只插不发」的判据）
    await expect(panel).toHaveCount(0);
    await expect(composer.locator('.chat-composer__input')).toHaveValue(CARD_TOKEN);
  });
});

test.describe('用户名片：接口契约', () => {
  test('★ 按 id 匿名可达，按名字要 core+', async ({ page }) => {
    // 全新 context（page.request 复用页面 cookie，这里要看未登录时的行为）
    const anon = await page.request.get(`/api/users/${FRAMED.id}`);
    expect(anon.status(), '公开主页那条路必须照旧匿名可达').toBe(200);

    const byName = await page.request.get(`/api/users/${FRAMED.username}`);
    expect(byName.status(), '名字到处都是、可以拿来枚举，所以要收档').toBe(403);

    await loginViaApi(page, FRAMED.username);
    const ok = await page.request.get(`/api/users/${FRAMED.username}`);
    expect(ok.status()).toBe(200);
    const body = (await ok.json()) as { user: { id: string; frameUrl: string | null } };
    expect(body.user.id).toBe(FRAMED.id);
    expect(body.user.frameUrl, '框的判定已在服务层做完，渲染层直接用').toBe(FRAME_SRC);
  });

  test('★ 中文用户名那条路真的通（encode → 路由解码 → 按名查库）', async ({ page }) => {
    // 这条防的是「单测全绿、真机上中文名名片一律显示字面量」：差别只在
    // encodeURIComponent 与路由参数那一次解码。用户名允许中文（validateUsername
    // 放行 \p{L}，中文名在站内是常态）。
    const tag = uniqueTag().slice(0, 4);
    const username = `张三丰${tag}`;
    const res = await page.request.post('/api/auth/register', {
      data: { username, email: `cj-${tag}@e2e.local`, password: SEED_PASSWORD },
    });
    const body = (await res.json()) as { code: number; user?: { id: string } };
    expect(body.code, `中文用户名应当注册得出来：${JSON.stringify(body)}`).toBe(200);

    // 端到端：发一条含该用户名片的消息，看它有没有画出来（比断言接口更接近用户看到的东西）
    await loginViaApi(page, FRAMED.username);
    const marker = uniqueTag();
    await postMessage(page, `${marker} [@用户/${username}]`);
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = msgRow(page, marker);
    await expect(row.locator('.rich-user-ref')).toHaveCount(1);
    await expect(row.locator('.rich-user-ref__name')).toHaveText(username);
    expect(body.user?.id).toBeTruthy();
  });
});
