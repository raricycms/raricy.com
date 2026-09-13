// ─────────────────────────────────────────────────────────────────────────────
// chat-codeblock.spec.ts —— 聊天气泡里的代码块不许把消息列表顶出横向滚动
//
// 【回归背景】站长报：聊天区的 Markdown 代码块在移动端会顶出屏幕，屏幕可以横向滑动。
//
// 根因在 CSS 的尺寸算法，不在渲染管线：气泡的宽度来自 .chat-msg__body 的
// align-items: flex-start ⇒ fit-content，即 min(max-content, 可用宽度)，**但下限是
// min-content**。`pre` 是 white-space: pre（根本不折行），于是它的 min-content 就是
// 最长那一行的整宽 —— 一行 60 字符的代码能把气泡撑到 1173px（390px 屏实测），
// .chat-list 随之横向可滚。
//
// ⚠️ min-width: 0 治不了它（那是主轴方向的最小尺寸，这里是**列**向 flex 的交叉轴）。
//    修法是 .chat-msg__content 上的 max-width: 100%，见 _chat.scss 里的长注释。
//
// 【为什么必须走真浏览器】这是纯布局问题：接口、单测、构建全都不报错，只有真渲染
// 出来量宽度才看得见。断言落在 scrollWidth/clientWidth 上，不做任何截图比对。
//
// 【造数纪律】用文件级登录（见下方注释），只发 1 条消息 —— 大区是全站共用频道，
// 定位一律用 uniqueTag 哨兵串锚定。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test, type APIRequestContext } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';

const LOBBY = 'lobby';

/**
 * 一条**不折行**的长代码 —— 必须长到超过气泡可用宽度，否则测不出问题。
 * 200 个字符在 390px 与 1280px 两个 project 下都足够。
 */
const LONG_CODE_LINE =
  'def a_very_long_function_name(argument_one, argument_two, argument_three): return argument_one + argument_two + argument_three  # noqa: E501';

/**
 * 登录态只取一次再逐用例注入 cookie。
 *
 * 登录限频按**用户名**计（RULES.loginPerUser = 100 / 15 分钟），种子号 core 被十几个
 * spec 共用、本就贴着上限 —— 每个用例各登录一次会把别的 spec 顶成 429。详见
 * content-ref.spec.ts 里同一段说明。
 */
let sessionCookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'] = [];

test.beforeAll(async ({ request }) => {
  const res = await request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(res.status()).toBe(200);
  sessionCookies = (await request.storageState()).cookies;
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(sessionCookies);
});

test('★ 长代码行：气泡被钉在容器宽度内，代码块自己横滑，列表不横滑', async ({ page }) => {
  const marker = `e2e-codeblock-${Date.now().toString(36)}`;
  const posted = await page.request.post(`/api/chat/channels/${LOBBY}/messages`, {
    data: { content: `${marker}\n\n\`\`\`python\n${LONG_CODE_LINE}\n\`\`\`` },
  });
  expect(posted.status(), `发言失败: ${await posted.text()}`).toBe(200);

  await page.goto(`/chat?channel=${LOBBY}`);
  const row = page
    .locator('.chat-msg', { has: page.locator('.chat-msg__content', { hasText: marker }) })
    .first();
  await expect(row).toBeVisible();

  // ⚠️ 必须**按 marker 定位到那一条**再量。大区里有一堆历史消息，
  // `document.querySelector('.chat-msg__content')` 拿到的是第一条（通常是个短气泡），
  // 量它等于什么都没验 —— 实测踩过：那样写时下面两条断言恒绿。
  const m = await page.evaluate((mk: string) => {
    const bubble = Array.from(document.querySelectorAll('.chat-msg__content')).find((el) =>
      (el.textContent ?? '').includes(mk)
    ) as HTMLElement | undefined;
    if (!bubble) return null;
    const list = bubble.closest('.chat-list') as HTMLElement;
    const pre = bubble.querySelector('pre') as HTMLElement;
    const de = document.documentElement;
    const r = (el: HTMLElement) => ({
      w: Math.round(el.getBoundingClientRect().width),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    });
    return { list: r(list), bubble: r(bubble), pre: r(pre), doc: r(de) };
  }, marker);
  expect(m, '没找到刚发的那条消息').not.toBeNull();

  // ① 页面本身不许横向滚动
  expect(m!.doc.scrollW, '页面被顶出横向滚动了').toBeLessThanOrEqual(m!.doc.clientW + 1);
  // ② 消息列表也不许横向滚动（站长描述的现象）
  //    注：桌面 Chrome 上实测这条**不会**红 —— 撑宽的气泡被 .chat-page 的
  //    overflow: hidden 裁掉了，没有变成列表的滚动溢出。真正有牙的是 ③④；
  //    这条留着是因为它正是用户可见症状，换个浏览器/宽度就可能先在这里炸。
  expect(m!.list.scrollW, '消息列表可以横向滑动 = 气泡没被约束住').toBeLessThanOrEqual(
    m!.list.clientW + 1
  );
  // ③ ★ 气泡宽度不得超过它所在的列表（去掉 _chat.scss 那条 max-width: 100% 就红）
  expect(m!.bubble.w, '气泡比容器还宽（代码块把它撑破了）').toBeLessThanOrEqual(m!.list.clientW);
  // ④ ★ 但代码块**内部**要能横滑 —— 否则长行只是被裁掉了，用户读不到后半截
  expect(m!.pre.scrollW, '代码块内部没法横滑（长行被裁掉了）').toBeGreaterThan(
    m!.pre.clientW + 1
  );
});
