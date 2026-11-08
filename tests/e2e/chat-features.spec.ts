// ─────────────────────────────────────────────────────────────────────────────
// chat-features.spec.ts —— Phase C 新增的前端能力
//   · 链接自动识别（linkify → <a>，只认 http(s)）
//   · 点回复摘要跳到原消息并高亮
//   · 消息搜索 → 命中后跳转并高亮
//   · 日期分隔线
//   · Markdown 正文渲染 + XSS 不执行（原始 HTML / 伪协议）
//
// 【造数纪律】大区是全站共用频道：定位一律用本轮 uniqueTag 的哨兵串锚定，
// 绝不断言「列表里有几条」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi, registerFreshUser, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

const LOBBY = 'lobby';

/** 以当前身份在指定会话里发一条消息，返回其 id。 */
async function postTo(
  page: import('@playwright/test').Page,
  channelId: string,
  content: string,
  replyTo?: number
): Promise<number> {
  const res = await page.request.post(`/api/chat/channels/${channelId}/messages`, {
    data: replyTo ? { content, reply_to: replyTo } : { content },
  });
  expect(res.status(), `发消息失败: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { message: { id: number } };
  return body.message.id;
}

/** 以当前身份在大区发一条消息，返回其 id。 */
const postLobby = (page: import('@playwright/test').Page, content: string, replyTo?: number) =>
  postTo(page, LOBBY, content, replyTo);


/**
 * 按哨兵串定位消息行。
 * 必须限定在 `.chat-msg__content` 内匹配 —— 回复消息的引用块里也会出现原文，
 * 只按行文本过滤会同时命中「原消息」和「回复消息」两行（strict mode 直接报错）。
 */
function msgRow(page: import('@playwright/test').Page, marker: string) {
  return page.locator('.chat-msg', {
    has: page.locator('.chat-msg__content', { hasText: marker }),
  });
}

test.describe('讨论功能：链接 / 跳转 / 搜索 / 日期分隔', () => {
  test('正文里的 http(s) 链接渲染成可点链接，且带 noopener', async ({ page }) => {
    const marker = `e2e-link-${uniqueTag()}`;
    const url = 'https://example.com/e2e-link-target';
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(page, `${marker} ${url}`);

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const link = row.locator('a.chat-msg__link');
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('点回复摘要 → 跳到原消息并短暂高亮', async ({ page }) => {
    const tag = uniqueTag();
    const orig = `e2e-orig-${tag}`;
    const reply = `e2e-reply-${tag}`;

    // 发言者用一次性新用户，**不用种子号**：大区发言限频是 120 条/分钟/用户，
    // 种子号在两个 project 之间共用，另一轮的发言还没滑出 60 秒窗口就会把配额
    // 顶满（实测 chat:m:e2e-user-admin 达到 30/30，详见 helpers.ts 的
    // registerFreshUser）。这里只需要「一个和 core 不同的人」，是谁不影响回复跳转。
    await registerFreshUser(page, { core: true });
    const origId = await postLobby(page, orig);
    await postLobby(page, reply, origId);

    await page.context().clearCookies();
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    const replyRow = msgRow(page, reply);
    await expect(replyRow).toBeVisible();
    await replyRow.locator('.chat-msg__reply').click();

    // 高亮类名只挂 2 秒，用 toHaveClass 的自动重试去抓
    await expect(msgRow(page, orig)).toHaveClass(/chat-msg--highlight/, { timeout: 5000 });
  });

  /**
   * 【这条守的是「UI 真的把 reply_to 发出去了」】上面那条用例的回复是**直接打接口**
   * 发的（postLobby 带 replyTo），整个前端发送链路一步都没走 —— 于是「点回复 → 写完
   * → 发出去」这条路上 reply_to 被静默丢掉时，它照样全绿（用户报的 bug 正是这么漏的）。
   *
   * 被引用方特意是**另一个账号**：用户的说法是「没法引用**别人**的消息」。
   * 纯文字是必须的 —— 带图 / 带博客引用时那条路径恰好是好的，用附件会把 bug 盖住。
   */
  test('点「回复」发一条纯文字消息 → 引用块挂在新消息上（走 UI 发送路径）', async ({ page }) => {
    const tag = uniqueTag();
    const orig = `e2e-reply-ui-orig-${tag}`;
    const body = `e2e-reply-ui-body-${tag}`;

    // 被引用方用一次性新用户：大区是全站共用频道，种子号的发言额度要省着用
    const peer = await registerFreshUser(page, { core: true });
    await postLobby(page, orig);

    await page.context().clearCookies();
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/chat?channel=${LOBBY}`);

    // 桌面右键快捷入口唤出操作菜单，再点「回复」（见 ChatMessageMenu）
    const origRow = msgRow(page, orig);
    await expect(origRow).toBeVisible();
    await origRow.locator('.chat-msg__content').click({ button: 'right' });
    await page
      .locator('.chat-menu')
      .getByRole('menuitem', { name: '回复', exact: true })
      .click();

    // 前置断言：真的进了回复态。这一步挂 = 按钮没接上，与「reply_to 没发出去」分开定位
    await expect(page.locator('.chat-composer__reply')).toContainText(peer.username);

    await page.locator('.chat-composer__input').fill(body);
    await page.locator('.chat-composer__send').click();

    // 关键断言：发出去的那条带着引用块，且引用的是原消息与原作者
    const sentRow = msgRow(page, body);
    await expect(sentRow).toBeVisible();
    const quote = sentRow.locator('.chat-msg__reply');
    await expect(quote).toContainText(peer.username);
    await expect(quote).toContainText(orig);
  });

  test('搜索命中后跳转并高亮该条消息', async ({ page }) => {
    const marker = `e2e-search-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(page, `${marker} 搜索目标`);

    await page.goto(`/chat?channel=${LOBBY}`);
    await page.locator('.chat-main__search').click();

    const input = page.locator('.chat-new-search');
    await expect(input).toBeVisible();
    await input.fill(marker);

    const hit = page.locator('.chat-search-item', { hasText: marker });
    await expect(hit).toBeVisible({ timeout: 8000 });
    await hit.click();

    await expect(msgRow(page, marker)).toHaveClass(/chat-msg--highlight/, { timeout: 5000 });
  });

  /**
   * 【这条用例守的是「跳出一屏」的路径】上面那条的目标就在最新 50 条里 —— 节点一直在
   * DOM 里，跳转只是 scrollIntoView，走不到「换列表」的代码。目标落在窗口之外时才会
   * 走那条路，而它曾经的实现是「把历史一页拼到列表头上」：列表一旦超过 DOM 上限，
   * 自动折叠会把刚拼进来的目标连同上下文一起折叠掉（不在 DOM 里 → querySelector 落空），
   * 表现就是点了搜索结果什么也没发生。现在改成整段换成目标所在的那一小段。
   *
   * 顺带钉住配套语义：窗口没顶到最新 ⇒ 进「历史视图」—— 最新那条不在列表里，
   * 由「回到最新」浮标回到底部。
   */
  test('搜索命中一屏之外的消息 → 换成该消息所在的一段并高亮，可「回到最新」', async ({
    page,
  }) => {
    const tag = uniqueTag();
    const marker = `e2e-search-far-${tag}`;
    const newest = `e2e-search-far-newest-${tag}`;

    // 造数：把目标顶到首屏（最新 50 条）之外。发言限频按 RULES.chatMinute 计（滑动
    // 分钟窗口），所以拆给两个一次性号各发一半 —— 额度比这里用到的宽松（2026-09-15
    // 放宽后 120/分），拆号只是为了不把全部 56 条压在一个号的窗口上。
    await registerFreshUser(page, { core: true });
    await postLobby(page, `${marker} 久远的目标`);
    for (let i = 0; i < 27; i++) await postLobby(page, `e2e-fill-${tag}-a${i}`);

    await registerFreshUser(page, { core: true });
    for (let i = 0; i < 27; i++) await postLobby(page, `e2e-fill-${tag}-b${i}`);
    await postLobby(page, `${newest} 最新的一条`);

    await page.goto(`/chat?channel=${LOBBY}`);
    await expect(msgRow(page, newest)).toBeVisible();
    // 前提成立才有意义：目标此刻不在 DOM 里（不在首屏那 50 条内）
    await expect(msgRow(page, marker)).toHaveCount(0);

    await page.locator('.chat-main__search').click();
    await page.fill('.chat-new-search', marker);
    const hit = page.locator('.chat-search-item', { hasText: marker });
    await expect(hit).toBeVisible({ timeout: 8000 });
    await hit.click();

    // 跳过去了：高亮 + 真的落在列表可视区里（只断言「在 DOM 里」会漏掉「滚没滚过去」）
    const row = msgRow(page, marker);
    await expect(row).toHaveClass(/chat-msg--highlight/, { timeout: 5000 });
    await expect(row).toBeInViewport();

    // 历史视图：列表换成了目标那一段，最新那条被换下去了 → 浮标给出口
    await expect(msgRow(page, newest)).toHaveCount(0);
    const backToLatest = page.locator('.chat-jump-new');
    await expect(backToLatest).toContainText('回到最新');
    await backToLatest.click();
    await expect(msgRow(page, newest)).toBeVisible();
    await expect(backToLatest).toHaveCount(0);
  });

  test('消息列表带日期分隔线', async ({ page }) => {
    const marker = `e2e-sep-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(page, marker);

    await page.goto(`/chat?channel=${LOBBY}`);
    await expect(msgRow(page, marker)).toBeVisible();
    // 首条消息之前必定有一条日期分隔（今天/昨天/日期）
    await expect(page.locator('.chat-date-sep').first()).toBeAttached();
  });
});


test.describe('消息操作菜单（右键 / 长按）', () => {
  // 真视口验证：没有常驻按钮、右键开菜单、焦点处理与菜单边界。

  test('桌面：右键打开消息菜单，指针打开不抢焦点，Esc 关闭', async ({ page, isMobile }) => {
    test.skip(isMobile, '桌面鼠标分支');
    const marker = `e2e-menu-${uniqueTag()}`;
    await registerFreshUser(page, { core: true });
    await postLobby(page, marker);
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    // 入口只有右键：页面上不该再有常驻的「更多」按钮。
    await expect(page.locator('.chat-msg__more')).toHaveCount(0);

    await row.locator('.chat-msg__content').click({ button: 'right' });
    const menu = page.locator('.chat-menu');
    await expect(menu).toBeVisible();
    // 大区里自己发的消息：没有「保存」（保存箱只收私聊），有回复 / 复制 / 删除
    await expect(menu.getByRole('menuitem')).toHaveText(['回复', '复制', '删除', '取消']);
    // 指针（右键）打开时不该把焦点抢到第一项：焦点留在原处，随后 Tab 才不会从菜单项开始。
    const pointerFocus = await menu.getByRole('menuitem').first().evaluate((el) => ({
      active: document.activeElement === el,
      focusVisible: el.matches(':focus-visible'),
    }));
    expect(pointerFocus.active, '右键打开时不应聚焦第一项').toBe(false);
    expect(pointerFocus.focusVisible, '右键打开时第一项不该命中 :focus-visible').toBe(false);
    // 菜单是 fixed 定位的 portal，完整落在视口内（否则边缘消息的菜单项点不到）。
    const box = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // 键盘菜单键（无指针坐标）打开时才聚焦第一项，方向键随即可用。
    await row.evaluate((el) =>
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    );
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('桌面：右键行内空白处不弹菜单，正文上右键才弹', async ({ page, isMobile }) => {
    test.skip(isMobile, '鼠标分支只在桌面验证');
    const marker = `e2e-blank-${uniqueTag()}`;
    // 消息作者与查看者分开：非本人消息靠左排，短消息右侧才会露出行被拉宽出来的空白。
    await registerFreshUser(page, { core: true });
    await postLobby(page, marker);
    await registerFreshUser(page, { core: true });
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = msgRow(page, marker);
    await expect(row).toBeVisible();
    const rowBox = (await row.boundingBox())!;
    const bubbleBox = (await row.locator('.chat-msg__content').boundingBox())!;
    expect(
      rowBox.x + rowBox.width,
      '消息行应被拉宽出一条空白，否则这条用例测不到空白区域'
    ).toBeGreaterThan(bubbleBox.x + bubbleBox.width + 40);

    await page.mouse.click(rowBox.x + rowBox.width - 8, bubbleBox.y + bubbleBox.height / 2, {
      button: 'right',
    });
    await expect(page.locator('.chat-menu'), '空白处不该弹消息菜单').toHaveCount(0);

    await row.locator('.chat-msg__content').click({ button: 'right' });
    const menu = page.locator('.chat-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['回复', '复制', '取消']);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('触屏：轻点正文打开消息详情（可原生选字），Esc 关闭', async ({ page, isMobile }) => {
    test.skip(!isMobile, '触屏分支只在移动端验证');
    const marker = `e2e-detail-${uniqueTag()}`;
    await registerFreshUser(page, { core: true });
    await postLobby(page, marker);
    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    await row.locator('.chat-msg__content').tap();
    const detail = page.getByRole('dialog', { name: '消息详情' });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(marker);

    // 详情层在 .chat-msg 之外：列表里的原生选字关掉了，这里必须能选。
    const selected = await detail.locator('.chat-detail__body').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      const text = window.getSelection()!.toString();
      window.getSelection()!.removeAllRanges();
      return text;
    });
    expect(selected).toContain(marker);

    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
  });

  test('触屏：长按打开操作面板，不选字；长按松手不再打开详情', async ({ page, isMobile }) => {
    test.skip(!isMobile, '触屏分支只在移动端验证');
    const marker = `e2e-longpress-${uniqueTag()}`;
    await registerFreshUser(page, { core: true });
    await postLobby(page, marker);
    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();
    const box = (await row.locator('.chat-msg__content').boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // 真实触屏长按在 Playwright 里没有直接 API，用 pointer 事件序列驱动同一条接线。
    // 事件落点必须是正文（不是行根）：行内空白不接管按下 / 长按。
    await row.locator('.chat-msg__content').evaluate((el, p) => {
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          pointerId: 1,
          button: 0,
          clientX: p.x,
          clientY: p.y,
        })
      );
    }, point);
    await expect(row, '按下时要有按压反馈').toHaveClass(/chat-msg--pressed/);
    await page.waitForTimeout(650);
    const menu = page.locator('.chat-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['回复', '复制', '删除', '取消']);
    await expect(row).not.toHaveClass(/chat-msg--pressed/);
    expect(await page.evaluate(() => window.getSelection()!.toString()), '长按不选字').toBe('');

    await row.locator('.chat-msg__content').evaluate((el, p) => {
      el.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          pointerId: 1,
          button: 0,
          clientX: p.x,
          clientY: p.y,
        })
      );
      // 浏览器在长按松手后可能补一个 click；它必须被吞掉。
      el.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y })
      );
    }, point);
    await expect(page.getByRole('dialog', { name: '消息详情' })).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('桌面：左键单击正文打开详情；拖选不打开详情，选区内右键保留浏览器菜单', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, '鼠标分支只在桌面验证');
    const marker = `e2e-mouse-detail-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(page, marker);
    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    await row.locator('.chat-msg__content').click();
    const detail = page.getByRole('dialog', { name: '消息详情' });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(marker);
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);

    // 直接拖动选字：松开后的 click 不能当单击处理。
    const box = (await row.locator('.chat-msg__content').boundingBox())!;
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(
      (await page.evaluate(() => window.getSelection()!.toString())).length,
      '拖选后应有文字选区'
    ).toBeGreaterThan(0);
    await expect(page.getByRole('dialog', { name: '消息详情' })).toHaveCount(0);

    // 在已选文字内右键：浏览器原生菜单保留，不弹我们自己的操作菜单。
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(page.locator('.chat-menu')).toHaveCount(0);
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
  });

  test('桌面右键自己的消息 → 删除', async ({ page, isMobile }) => {
    test.skip(isMobile, '触屏通过长按操作');
    const marker = `e2e-del-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    const messageId = await postLobby(page, marker);
    await page.goto(`/chat?channel=${LOBBY}`);

    const row = page.locator(`.chat-msg[data-message-id="${messageId}"]`);
    await expect(row.locator('.chat-msg__content')).toContainText(marker);
    await row.locator('.chat-msg__content').click({ button: 'right' });

    const menu = page.locator('.chat-menu');
    await expect(menu).toBeVisible();
    // 删自己的消息前有 confirm；先挂好 accept
    page.once('dialog', (d) => void d.accept());
    await menu.getByRole('menuitem', { name: '删除', exact: true }).click();

    // 服务端软删 → 行变成删除占位（消息行本身还在，附件已被抹掉）
    await expect(row.locator('.chat-msg__deleted')).toHaveText('[该消息已删除]');
  });
});

test.describe('Markdown 渲染', () => {

  test('原始 HTML / 伪协议一律不执行（XSS）', async ({ page }) => {
    const marker = `e2e-xss-${uniqueTag()}`;
    await loginViaApi(page, SEED_USERS.core.username);
    await postLobby(
      page,
      [
        marker,
        '<img src=x onerror="window.__xssImg=1">',
        '<script>window.__xssScript=1</script>',
        '[点我](javascript:window.__xssLink=1)',
        // marked 的 inRawBlock 裸文本通道：畸形标签（属性间缺空格）曾直出成真元素
        'x<code><input type="password"y></code>请输入密码',
      ].join('\n')
    );

    await page.goto(`/chat?channel=${LOBBY}`);
    const row = msgRow(page, marker);
    await expect(row).toBeVisible();

    const md = row.locator('.chat-msg__md');
    await expect(md.locator('script')).toHaveCount(0);
    await expect(md.locator('img')).toHaveCount(0);
    // 畸形标签不得渲染出真表单控件（含 GFM 任务列表之外的任何 input）
    await expect(md.locator('input')).toHaveCount(0);
    // 危险链接保留文字但摘掉 href（点了也不会执行）
    await expect(md.locator('a', { hasText: '点我' })).not.toHaveAttribute('href');

    // 真·执行探测：onerror / <script> / javascript: href 只要有一个生效，
    // 这几个全局变量就会被赋值。
    const executed = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return [w.__xssImg, w.__xssScript, w.__xssLink].filter((v) => v !== undefined);
    });
    expect(executed).toEqual([]);
  });
});

test.describe('会话偏好（静音 / 删除会话）', () => {
  /** 私聊行 = 带头像（.chat-chan__avatar）而非大区图标（.chat-chan__icon）的行。 */
  function dmRow(page: import('@playwright/test').Page, peer: string) {
    return page
      .locator('.chat-chan-wrap', { hasText: peer })
      .filter({ hasNot: page.locator('.chat-chan__icon') })
      .first();
  }

  /** 移动端侧栏是抽屉（默认移出视口）→ 先点汉堡按钮拉开。 */
  async function openSidebarIfMobile(page: import('@playwright/test').Page, isMobile: boolean) {
    if (isMobile) await page.locator('.chat-main__menu').click();
  }

  test('「⋯」菜单可以静音会话，静音后行内出现静音标记', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    // 确保与 admin 的私聊存在（重复发起会复用同一个频道）
    const created = await page.request.post('/api/chat/channels', {
      data: { user_id: SEED_USERS.admin.id },
    });
    expect(created.status()).toBe(200);
    const channelId = ((await created.json()) as { channel: { id: string } }).channel.id;
    // 空会话不进侧栏（1.6）——先发一条消息把它变成真实会话，否则侧栏里根本没有这一行
    await page.request.post(`/api/chat/channels/${channelId}/messages`, {
      data: { content: `e2e-mute-${uniqueTag()}` },
    });

    await page.goto('/chat');
    await openSidebarIfMobile(page, isMobile);
    const row = dmRow(page, SEED_USERS.admin.username);
    await expect(row).toBeVisible();

    await row.locator('.chat-chan__more').click();
    await page.locator('.chat-menu__item', { hasText: '静音' }).click();

    await expect(row.locator('.chat-chan__muted')).toBeAttached({ timeout: 5000 });

    // 还原：取消静音（避免影响同库的其他用例）
    await row.locator('.chat-chan__more').click();
    await page.locator('.chat-menu__item', { hasText: '取消静音' }).click();
    await expect(row.locator('.chat-chan__muted')).toHaveCount(0);
  });

  test('删除会话后该行从侧栏消失（对方再发消息会重新出现）', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.core.username);
    const created = await page.request.post('/api/chat/channels', {
      data: { user_id: SEED_USERS.owner.id },
    });
    expect(created.status()).toBe(200);
    const channelId = ((await created.json()) as { channel: { id: string } }).channel.id;
    // desktop 与 mobile 共用同一个 e2e 库：上一轮可能已把这个会话隐藏过，
    // 发一条新消息让它重新出现（这本身也是「新消息即复现」的行为验证）。
    await page.request.post(`/api/chat/channels/${channelId}/messages`, {
      data: { content: `e2e-unhide-${uniqueTag()}` },
    });

    await page.goto('/chat');
    await openSidebarIfMobile(page, isMobile);
    const row = dmRow(page, SEED_USERS.owner.username);
    await expect(row).toBeVisible();

    page.on('dialog', (d) => void d.accept()); // 删除前有 confirm
    await row.locator('.chat-chan__more').click();
    await page.locator('.chat-menu__item', { hasText: '删除会话' }).click();

    await expect(row).toHaveCount(0, { timeout: 5000 });
  });
});

test.describe('发起私聊', () => {
  /** 私聊行 = 带头像（.chat-chan__avatar）而非大区图标（.chat-chan__icon）的行。 */
  function dmRow(page: import('@playwright/test').Page, peer: string) {
    return page
      .locator('.chat-chan-wrap', { hasText: peer })
      .filter({ hasNot: page.locator('.chat-chan__icon') })
      .first();
  }

  /**
   * 点一次就进会话、且这一行要留得住。
   *
   * 【为什么是 admin ↔ owner】这条用例要的是「双方都还没发过消息」的空会话 ——
   * 服务端列表刻意不返回空会话（防骚扰），正是这条用例要防的回归面。全套用例里
   * 只有 core↔admin、core↔owner 被用过，admin↔owner 始终是空的。
   *
   * 【防的回归】URL 里的 ?channel= 是应用自己写的镜像。旧实现把它放在「首次加载」
   * effect 的依赖里：发起私聊 → router.replace → effect 重跑 → 拉回不含空会话的
   * 服务端列表整表替换 → 刚建的私聊被冲掉、选中态退回大区。于是「发起私聊要点
   * 两次才成功」（第二次 URL 没变、effect 不重跑，才侥幸留下）。
   */
  test('点一次就进入会话，且对账后该行仍在侧栏', async ({ page, isMobile }) => {
    await loginViaApi(page, SEED_USERS.admin.username);
    await page.goto('/chat');
    if (isMobile) await page.locator('.chat-main__menu').click();

    await page.locator('.chat-new-btn').click();
    // 先搜再点，别直接在整列表里找对端。
    //
    // 弹窗每页只取 20 条、按 createdAt desc 排（NewChatModal 的 PER_PAGE），而全套
    // 用例会一路 registerFreshUser + 提权，攒出几十个 core 用户 —— 种子号 e2e_owner
    // 是最老的一个，排在最末。只要总数越过 20，它就掉出第一页，用例以「找不到
    // .chat-new-item」挂掉，看着像随机 flaky，实则取决于这轮跑了多少用例
    // （desktop 全跑完才轮到 mobile，mobile 那次就更容易越线）。
    // 实测踩过一次：仅因 seed.ts 多了一个 core 种子用户，就是 20 → 21 那一步。
    // 走搜索与真人用法一致，也不受列表规模影响。
    await page.fill('.chat-new-search', SEED_USERS.owner.username);
    await page.locator('.chat-new-item', { hasText: SEED_USERS.owner.username }).click();

    // 弹窗关闭 + 直接进入该会话
    await expect(page.locator('.chat-new-modal')).toHaveCount(0);
    await expect(page.locator('.chat-main__title')).toHaveText(SEED_USERS.owner.username);

    // 窗口重新聚焦 → 触发一次对账（整表替换 channels）。空会话必须被补回来。
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1000);
    // 移动端侧栏是抽屉，进会话时被关掉了 → 再拉开
    if (isMobile) await page.locator('.chat-main__menu').click();

    await expect(dmRow(page, SEED_USERS.owner.username)).toBeVisible();
    await expect(page.locator('.chat-main__title')).toHaveText(SEED_USERS.owner.username);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 进入频道后的滚动位置
//
// 【为什么必须降速跑】旧写法在 messages 落库后的 rAF 里滚到底。React 的提交走调度器
// （并发渲染会分片让出主线程），rAF 完全可能早于提交执行 —— 那一刻列表还是空的，
// scrollTo 到旧的 scrollHeight 等于没滚，进来就停在顶部。桌面全速下两者顺序通常
// 恰好是对的（用例会假绿），把 CPU 降到 1/4（手机的真实情形）才稳定复现。
// 降速靠 CDP，故只在 Chromium 跑。
// ─────────────────────────────────────────────────────────────────────────────
test.describe('进入讨论区停在最新消息', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'CPU 降速依赖 CDP（仅 Chromium）');
  test.use({ viewport: { width: 390, height: 844 } });

  test('首屏停在底部，而不是顶部', async ({ page, context }) => {
    await registerFreshUser(page, { core: true }); // 新用户：独占发言限频额度
    const tag = uniqueTag();
    for (let i = 0; i < 25; i++) {
      const res = await page.request.post('/api/chat/channels/lobby/messages', {
        data: { content: `e2e-scroll-${tag}-${i} 稍长一点的内容，用来把列表撑过一屏。` },
      });
      expect(res.status(), await res.text()).toBe(200);
    }

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await page.goto('/chat?channel=lobby');
    await expect(page.locator('.chat-msg').last()).toBeVisible();

    const list = page.locator('.chat-list');
    // 前提：列表确实超出一屏 —— 否则「停在底部」这件事没有意义（断言会假绿）
    expect(
      await list.evaluate((el) => el.scrollHeight - el.clientHeight),
      '列表没有超出一屏，本用例失去意义'
    ).toBeGreaterThan(300);

    // 距底部 <40px 即视为「在最新消息处」（浏览器亚像素/缩放留一点余量）
    await expect
      .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
      .toBeLessThan(40);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 用户报的 bug：「1 条新消息」滑到底后不消失。
//
// 浮标只在「收到消息时不在底部」的分支里累加（onStreamMessage），原先只有点浮标
// 和切频道两条清零路径 —— 手动把列表拖到底不经过任何一条。修复是给 .chat-list 挂
// 滚动监听：到底即清零并推进读游标（见 ChatApp.handleListScroll）。
//
// 【为什么要两个浏览器上下文】要制造「我这个频道是非活动的、然后来了新消息」：
// 说话的人在另一个上下文里，本页停在别的频道上。
// ─────────────────────────────────────────────────────────────────────────────
test.describe('新消息浮标', () => {
  // 只用滚轮驱动滚动（真实用户的动作）。Mobile Safari 没有滚轮 —— 它走
  // `touchmove` + 惯性，Playwright 模拟不出，而 scrollTo 这类程序化滚动**不会**
  // 派发 scroll 事件，用它等于把被测的那条链路绕过去了（第一版就是这么写的，
  // 移除修复后用例照样绿）。
  test.skip(({ isMobile }) => isMobile, '程序化滚动不触发 scroll 事件，滚轮在移动端不可用');

  test('滑到底后「N 条新消息」消失', async ({ page, browser }) => {
    const me = await registerFreshUser(page, { core: true });

    // 说话人：用管理员（别的用例也收发，但只发大区，不干扰这里的私聊）
    const ctx = await browser.newContext();
    const speaker = await ctx.newPage();
    await loginViaApi(speaker, SEED_USERS.admin.username);
    const created = await speaker.request.post('/api/chat/channels', {
      data: { user_id: me.id },
    });
    expect(created.status()).toBe(200);
    const dmId = ((await created.json()) as { channel: { id: string } }).channel.id;

    try {
      // 先把私聊撑过一屏，并让本页读到底（进频道即已读）
      for (let i = 0; i < 8; i++) {
        const res = await speaker.request.post(`/api/chat/channels/${dmId}/messages`, {
          data: { content: `e2e-jump-${i} 稍长一点的内容，用来把列表撑过一屏。` },
        });
        expect(res.status(), await res.text()).toBe(200);
      }
      // 手机视口：一屏装不下 8 条
      await page.setViewportSize({ width: 390, height: 600 });
      await page.goto(`/chat?channel=${dmId}`);
      const list = page.locator('.chat-list');
      await expect(page.locator('.chat-msg').last()).toBeVisible();
      // 前提：列表确实超出一屏 —— 否则「离开底部」与「滑到底」都无从谈起，
      // 断言会在一个根本滚不动的列表上假绿
      expect(
        await list.evaluate((el) => el.scrollHeight - el.clientHeight),
        '私聊没有超出一屏，本用例失去意义'
      ).toBeGreaterThan(100);

      // 往上翻，离开底部 —— 此时来的新消息才会累加浮标。
      // 用滚轮而不是 scrollTo：scrollTo 一步到位，连 140px 的「接近底部」阈值都没
      // 跨出去就停在顶上了；滚轮是真实用户的操作，滚动事件也一条不落。
      await list.hover();
      await page.mouse.wheel(0, -1000);
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeLessThan(40);

      const res = await speaker.request.post(`/api/chat/channels/${dmId}/messages`, {
        data: { content: `e2e-jump-new-${uniqueTag()}` },
      });
      expect(res.status(), await res.text()).toBe(200);

      const jump = page.locator('.chat-jump-new');
      await expect(jump).toContainText('1 条新消息');
      await expect(jump).toBeVisible();

      // 手动滑到底 —— 用户报的就是这一步之后浮标还赖着不走。
      // 先滚轮一段（真的离开底部，滚出浮标），再一路滚到底。
      await page.mouse.wheel(0, 400);
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
      await page.mouse.wheel(0, 2000);
      await page.mouse.wheel(0, 2000);
      await expect(jump).toHaveCount(0, { timeout: 5000 });
      // 断言真的到底了（否则「浮标消失」可能只是列表还没滚到位）
      await expect
        .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThan(140);
      // 读游标也推进了：切走再切回来，浮标不再复现
      await page.goto(`/chat?channel=${LOBBY}`);
      await page.goto(`/chat?channel=${dmId}`);
      await expect(page.locator('.chat-jump-new')).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
