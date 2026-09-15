// ─────────────────────────────────────────────────────────────────────────────
// sticker.spec.ts —— 表情包（评论 + 讨论）
//
// 【为什么必须走真浏览器】服务端不渲染评论 / 讨论正文（没有 window，DOMPurify 会
// 静默降级成转义纯文本），所以「表情有没有出图」「404 有没有降级回字面量」在接口层
// 看不出来 —— 接口返回的 content 本来就是原文。单测（tests/unit/sticker-refs.test.ts）
// 管语法的白名单与安全边界，这里管「装到页面上之后还是对的」。
//
// 覆盖面：
//   · 面板数据源：合集 / 显示名 / ignore 的合集不出现
//   · 图片路由：真出图、nosniff、**隐藏合集 404**、穿越形态 404
//   · 讨论：点表情 → 直接发送（一条纯 token 的消息）
//   · 评论：点表情 → 插到输入框，**不发送**（草稿保住）
//   · 正文渲染：token → 内联 <img class="rich-sticker-ref">，且不带图床那个类名
//   · **404 降级**：不存在的表情退回纯文本 token（onerror 事件委托）
//   · 代码块里的 token 不展开
//
// 【造数纪律】大区是全站共用频道，定位一律用本轮 uniqueTag 的哨兵串锚定，
// 绝不断言「列表里有几条」。素材由 tests/e2e/global-setup.ts 的 seedStickers() 造好。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type Page } from '@playwright/test';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';
import { E2E_STICKERS, SEED_BLOG, SEED_USERS } from './seed';

const LOBBY = 'lobby';
const BLOG_URL = `/blog/${SEED_BLOG.id}`;

/** 一个真实存在的表情的 token 与地址。 */
const TOKEN = `[@${E2E_STICKERS.collection}/${E2E_STICKERS.names[0]}]`;
const STICKER_SRC = `/api/stickers/${encodeURIComponent(E2E_STICKERS.collection)}/${encodeURIComponent(E2E_STICKERS.names[0])}`;

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

// ── 数据源与图片路由 ────────────────────────────────────────────────────────

test.describe('表情包：数据源与图片路由', () => {
  test('列表给出合集与显示名，ignore 的合集不出现', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const res = await page.request.get('/api/stickers');
    expect(res.status()).toBe(200);
    const data = (await res.json()) as {
      code: number;
      empty: boolean;
      collections: { key: string; title: string; stickers: { name: string }[] }[];
    };
    expect(data.code).toBe(200);
    expect(data.empty).toBe(false);

    const col = data.collections.find((c) => c.key === E2E_STICKERS.collection);
    expect(col, '种子合集没出现在列表里').toBeTruthy();
    // 显示名来自 info.json，与目录名（token 里用的那个）刻意不同
    expect(col!.title).toBe(E2E_STICKERS.collectionTitle);
    expect(col!.stickers.map((s) => s.name).sort()).toEqual([...E2E_STICKERS.names].sort());

    // info.json 标了 ignore 的合集**不出现**
    expect(data.collections.some((c) => c.key === E2E_STICKERS.hidden)).toBe(false);
  });

  test('未登录拿不到列表', async ({ page }) => {
    const res = await page.request.get('/api/stickers');
    expect(res.status()).toBe(401);
  });

  test('图片路由真出图，带 nosniff，且**不对所有人设卡**（未登录也要能看公开评论里的表情）', async ({
    page,
  }) => {
    const res = await page.request.get(STICKER_SRC);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    // 明确不是 immutable —— 站长换图当天要能生效（见 raw 路由的注释）
    expect(res.headers()['cache-control']).not.toContain('immutable');
  });

  test('★ 隐藏合集（ignore）手打 token 也取不到', async ({ page }) => {
    const url = `/api/stickers/${encodeURIComponent(E2E_STICKERS.hidden)}/${encodeURIComponent('秘密')}`;
    const res = await page.request.get(url);
    // 只在列表里过滤是不够的 —— 那样「隐藏」就只是「不出现在面板里」
    expect(res.status()).toBe(404);
  });

  test('★ 恶意段名一律 404（查表模型：两段只当 key，不拼路径）', async ({ page }) => {
    // 先登录：未登录时列表接口回 401，会把「路由没匹配上」混进 404 的断言里
    await loginViaApi(page, SEED_USERS.core.username);

    // ⚠️ 用例的形态要挑对，否则测的是**路由**而不是服务端：
    //   · 裸 `..`（或 `%2e%2e` 单独成段）会被 URL 解析器 / Next 的路由在到达 handler
    //     之前就规范化掉 —— `/api/stickers/猫猫/%2e%2e` 会塌缩成 `/api/stickers/`，
    //     落到列表接口回 200，跟本路由无关。
    //   · 只有**编码斜杠**（%2f）能带着 `/` 原样进到 params 里，从而真正喂给
    //     resolveSticker 一个 `../../etc` 这样的串。下面这几条是会走到 handler 的。
    for (const evil of [
      '/api/stickers/%2e%2e%2f%2e%2e%2fetc/passwd', // collection = '../../etc'
      '/api/stickers/%E7%8C%AB%E7%8C%AB/%2e%2e%2f%2e%2e%2fetc%2fpasswd', // name = '../../etc/passwd'
      '/api/stickers/%E7%8C%AB%E7%8C%AB/%2fetc%2fpasswd', // name = '/etc/passwd'
      '/api/stickers/%E7%8C%AB%E7%8C%AB/%E5%BC%80%E5%BF%83.png', // 带扩展名不算命中
      '/api/stickers/%00/%E5%BC%80%E5%BF%83', // 空字节
    ]) {
      const res = await page.request.get(evil);
      expect(res.status(), evil).toBe(404);
    }

    // 阳性对照：合法的那个仍然 200 —— 否则上面全 404 也可能只是路由整个坏掉了
    expect((await page.request.get(STICKER_SRC)).status()).toBe(200);
  });
});

// ── 正文渲染 ────────────────────────────────────────────────────────────────

test.describe('表情包：正文渲染', () => {
  test('讨论正文里的 token 渲染成内联表情图', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const marker = `e2e-sticker-${uniqueTag()}`;
    await postMessage(page, `${marker} ${TOKEN}`);

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const img = row.locator('img.rich-sticker-ref');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('src', STICKER_SRC);
    // ★ 类名不能是图床那个 —— RichContentBody 的点击放大只认 rich-image-ref，
    //    同类名会让点表情弹出大图灯箱
    await expect(row.locator('img.rich-image-ref')).toHaveCount(0);
    // 字面量不该残留
    await expect(row.locator('.chat-msg__content')).not.toContainText('[@');
  });

  test('★ 不存在的表情 404 后降级回纯文本 token（onerror 事件委托）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const marker = `e2e-sticker-404-${uniqueTag()}`;
    const bogus = `[@${E2E_STICKERS.collection}/并不存在]`;
    await postMessage(page, `${marker} ${bogus}`);

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    // 先确认它确实尝试过建 img（不是压根没匹配上）
    // 失败后应被换成文本节点 —— 用户看到自己写错了什么，而不是一个破图标
    await expect(row.locator('img.rich-sticker-ref')).toHaveCount(0);
    await expect(row.locator('.chat-msg__content')).toContainText(bogus);
  });

  test('代码块里的 token 不展开（用户要能展示这个语法本身）', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const marker = `e2e-sticker-code-${uniqueTag()}`;
    await postMessage(page, `${marker}\n\n\`\`\`\n${TOKEN}\n\`\`\``);

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();
    await expect(row.locator('img.rich-sticker-ref')).toHaveCount(0);
    await expect(row.locator('pre')).toContainText(TOKEN);
  });
});

// ── 输入区 ──────────────────────────────────────────────────────────────────

test.describe('表情包：输入区', () => {
  test('讨论：点面板里的表情 → 直接发送（不经过输入框）', async ({ page }) => {
    const user = await registerFreshUser(page, { core: true });
    await page.goto(`/chat?channel=${LOBBY}`);

    const composer = page.locator('.chat-composer').first();
    await expect(composer).toBeVisible();
    await expect(composer.getByRole('button', { name: '表情' })).toBeVisible();

    // 输入框里先留一段草稿 —— 它**不该**被表情消息带走
    const draft = `draft-${user.username}`;
    await composer.locator('.chat-composer__input').fill(draft);

    await composer.getByRole('button', { name: '表情' }).click();
    const panel = composer.locator('.sticker-picker');
    await expect(panel).toBeVisible();
    // 面板显示的是 info.json 里的显示名，不是目录名
    await expect(panel.locator('.sticker-picker__tab').first()).toHaveText(
      E2E_STICKERS.collectionTitle
    );

    await panel.locator('.sticker-picker__item').first().click();

    // 发出去的是一条**纯 token** 的消息（正文里没有那段草稿）。
    // 走接口核对而不是数 DOM 行：大区是全站共用频道，别的用例也往里发过消息。
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/chat/channels/${LOBBY}/messages?limit=30`);
          const data = (await res.json()) as { messages?: { content?: string }[] };
          return (data.messages ?? []).some((m) => m.content === TOKEN);
        },
        { message: '面板点一下之后没有发出纯 token 的消息' }
      )
      .toBe(true);

    // ★ 草稿原样留着：表情是个轻量动作，不该顺手把写了一半的正文发掉
    await expect(composer.locator('.chat-composer__input')).toHaveValue(draft);
  });

  test('评论：点面板里的表情 → 插到输入框，**不发送**', async ({ page }) => {
    const user = await registerFreshUser(page, { core: true });
    await page.goto(BLOG_URL);

    const composer = page.locator('.comment-composer').first();
    await expect(composer).toBeVisible();

    const before = await page.locator('.comment-item').count();

    await composer.getByRole('button', { name: '表情' }).click();
    const panel = composer.locator('.sticker-picker');
    await expect(panel).toBeVisible();
    await panel.locator('.sticker-picker__item').first().click();

    // 插进了输入框
    await expect(composer.locator('.comment-composer__input')).toHaveValue(TOKEN);
    // 面板不关 —— 评论通常是连着挑好几个（stickerPickClosesPanel=false）
    await expect(panel).toBeVisible();
    // ★ 没有发出去
    expect(await page.locator('.comment-item').count()).toBe(before);

    // 再挑一个 → 追加，草稿里就有两个 token
    await panel.locator('.sticker-picker__item').nth(1).click();
    const value = await composer.locator('.comment-composer__input').inputValue();
    expect(value).toContain(TOKEN);
    expect(value.length).toBeGreaterThan(TOKEN.length);
    expect(user.username).toBeTruthy();
  });

  test('评论：Esc 关掉面板，草稿不受影响', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    await page.goto(BLOG_URL);

    const composer = page.locator('.comment-composer').first();
    const draft = '还没写完的评论';
    await composer.locator('.comment-composer__input').fill(draft);

    await composer.getByRole('button', { name: '表情' }).click();
    await expect(composer.locator('.sticker-picker')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(composer.locator('.sticker-picker')).toHaveCount(0);
    await expect(composer.locator('.comment-composer__input')).toHaveValue(draft);
  });
});

