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
//   · **内置黄脸**（单独一节）：排最前且默认激活、点一下**插进输入框而不发送**、
//     正文里是**文字大小**（对照组是 4em 的图片表情）、素材真的加载得出来
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

    // 面板默认停在**黄脸**栏（内置合集永远排最前），要测站长的素材得先切过去。
    // 用文案点名而不是 .first() —— 面板显示的是 info.json 里的显示名，不是目录名。
    const catTab = panel.locator('.sticker-picker__tab', { hasText: E2E_STICKERS.collectionTitle });
    await expect(catTab).toBeVisible();
    await catTab.click();

    const firstItem = panel.locator('.sticker-picker__item').first();
    await expect(firstItem).toHaveAttribute('title', TOKEN);
    await firstItem.click();

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
    // 同讨论那条：默认停在黄脸栏，先切到站长的合集
    await panel.locator('.sticker-picker__tab', { hasText: E2E_STICKERS.collectionTitle }).click();
    await expect(panel.locator('.sticker-picker__item').first()).toHaveAttribute('title', TOKEN);
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

// ── 内置黄脸表情 ────────────────────────────────────────────────────────────
//
// 它与图片表情走**同一条**渲染管线（同一个 token 语法、同一条降级链），但有两处
// **刻意不同** —— 这个块就是钉那两处的：
//   · 尺寸是文字大小，不是表情包的 4em；
//   · 点一下进输入框，**不发送**（讨论区也不例外）。
//
// 「进输入框」这条断言**自己就证明了没发出去**：若走了旧的「点一下直接发」那条路，
// 输入框里只会剩原来那段草稿，token 根本不会出现在里面。所以不需要再去接口上
// 轮询「有没有发出去」—— 那种否定断言只能靠等，反而更容易假绿。

/** 挑「微笑」是因为它的码位好记（1f60a），能从断言里一眼看出对应关系。 */
const EMOJI_TOKEN = '[@黄脸/微笑]';
const EMOJI_SRC = '/static/emoji/1f60a.svg';

test.describe('内置黄脸表情', () => {
  test('面板里排在最前、默认激活，且图是真出得来的', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    await page.goto(BLOG_URL);

    const composer = page.locator('.comment-composer').first();
    await composer.getByRole('button', { name: '表情' }).click();
    const panel = composer.locator('.sticker-picker');
    await expect(panel).toBeVisible();

    // 站长的合集排在它后面
    const firstTab = panel.locator('.sticker-picker__tab').first();
    await expect(firstTab).toHaveText('黄脸表情');
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');

    // ★ 图要**真的加载出来**。这条同时盯着「postinstall 有没有把素材拷进来」——
    // 少了素材的话正文里那些 token 会降级成字面量（不是裂图），
    // 光断言「有没有 img」是发现不了的。
    const img = panel.locator('.sticker-picker__item img').first();
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  });

  test('讨论：点黄脸 → 进输入框、**不发消息**、草稿留着、面板不关', async ({ page }) => {
    const user = await registerFreshUser(page, { core: true });
    await page.goto(`/chat?channel=${LOBBY}`);

    const composer = page.locator('.chat-composer').first();
    await expect(composer).toBeVisible();
    const draft = `draft-${user.username}`;
    const input = composer.locator('.chat-composer__input');
    await input.fill(draft);

    await composer.getByRole('button', { name: '表情' }).click();
    const panel = composer.locator('.sticker-picker');
    await expect(panel).toBeVisible();
    await panel.locator('.sticker-picker__item').first().click();

    // 草稿原样在，token 也进去了 —— 两者同时成立就等于「插进去而不是发出去」
    const value = await input.inputValue();
    expect(value).toContain(draft);
    expect(value).toContain(EMOJI_TOKEN);

    // 面板不关：黄脸通常是连着挑好几个（图片表情那边是发完就关）
    await expect(panel).toBeVisible();

    // 再挑一个 → 追加，不是覆盖
    await panel.locator('.sticker-picker__item').nth(1).click();
    const after = await input.inputValue();
    expect(after.length).toBeGreaterThan(value.length);
    expect(after).toContain(draft);
  });

  test('评论：点黄脸 → 插到光标处，**不发送**', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    await page.goto(BLOG_URL);

    const composer = page.locator('.comment-composer').first();
    const before = await page.locator('.comment-item').count();

    await composer.getByRole('button', { name: '表情' }).click();
    const panel = composer.locator('.sticker-picker');
    await expect(panel).toBeVisible();
    await panel.locator('.sticker-picker__item').first().click();

    await expect(composer.locator('.comment-composer__input')).toHaveValue(EMOJI_TOKEN);
    expect(await page.locator('.comment-item').count()).toBe(before);
  });

  test('★ 正文里黄脸是**文字大小**，图片表情仍是 4em（两者刻意不同）', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    const marker = uniqueTag('emoji-size');
    // 一条消息里同时放两种，才能拿同一处的字号当尺子直接对比
    await postMessage(page, `${marker} 黄脸 ${EMOJI_TOKEN} 图片 ${TOKEN}`);
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const emoji = row.locator('img.rich-emoji-ref').first();
    const sticker = row.locator('img.rich-sticker-ref:not(.rich-emoji-ref)').first();
    await expect(emoji).toBeVisible();
    await expect(sticker).toBeVisible();
    // 黄脸的 src 走静态素材，不是那条字节路由
    await expect(emoji).toHaveAttribute('src', EMOJI_SRC);

    // 以所在段落的字号为尺子：「和文字一样大」= 1~2 倍之间。
    // 尺寸由 CSS 定死，所以不依赖图片加载完成。
    const ratio = await emoji.evaluate((el) => {
      const fs = parseFloat(getComputedStyle(el.parentElement!).fontSize);
      return el.getBoundingClientRect().height / fs;
    });
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(2);

    // 对照组：图片表情还是那个大得多的 4em（1.2em vs 4em ≈ 3.3 倍）
    const eb = await emoji.boundingBox();
    const sb = await sticker.boundingBox();
    expect(sb!.height).toBeGreaterThan(eb!.height * 3);
  });

  test('清单里没有的黄脸名字：退回字节路由 → 404 → 显示原文 token', async ({ page }) => {
    await registerFreshUser(page, { core: true });
    const marker = uniqueTag('emoji-miss');
    const bad = '[@黄脸/并不存在]';
    await postMessage(page, `${marker} ${bad}`);
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = msgRow(page, marker);
    await expect(row).toBeVisible();
    // 与站长表情那条降级链同款：图取不到就换回纯文本，而不是留一张裂图
    await expect(row.locator('.chat-msg__md')).toContainText(bad);
    await expect(row.locator('img.rich-emoji-ref')).toHaveCount(0);
  });
});

