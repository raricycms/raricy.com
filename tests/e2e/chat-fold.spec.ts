// ─────────────────────────────────────────────────────────────────────────────
// chat-fold.spec.ts —— 消息列表超过 DOM 上限后的折叠 / 展开
//
// 【防的回归】「已折叠 N 条 · 展开更早」是个死按钮：自动折叠的 effect 写成了
// 「不到 maxFold 就设成 maxFold」，等于每次渲染都把折叠量往上钳一次 —— 展开刚减下去
// 的值下一拍就被钳回原位，表现是点了没反应、只闪一帧（用户报的）。现在跟的是
// 「尾部长了多少」，不是「离上限差多少」。
//
// 【为什么单开一个文件】复现要 300+ 条消息（DOM 上限就是 300，不超它永远不出折叠），
// 这是全套 e2e 里最重的一次造数。放进 RESPONSIVE_SPECS 会让 mobile 再重造一遍 ——
// 用例不碰布局（goto + 点按钮 + 数节点），按 playwright.config 的判据不该进那个名单。
//
// 【造数纪律】大区是全站共用频道：定位一律用本轮 uniqueTag 的哨兵串锚定，绝不数总数
// （别的用例也在往里发）。发言限频是 120 条/分/用户（滑动窗口，按人算、不分频道），
// 所以 300+ 条必须拆给 3 个一次性号 —— 一个号的额度到不了 300。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { registerFreshUser, uniqueTag } from './helpers';

const LOBBY = 'lobby';
/** 造数总量：要超过 DOM_CAP(300) 才会出现折叠，留几条余量。 */
const TOTAL = 306;
/** 每个一次性号的发言数：RULES.chatMinute 是 120/分，留出余量。 */
const PER_USER = 102;
/** 客户端 REVEAL_STEP：点一次「展开更早」放回多少条（ChatApp.tsx 的常量）。 */
const REVEAL_STEP = 50;

test('列表超过 DOM 上限后，「展开更早」真的展开（不被自动折叠钳回去）', async ({ page }) => {
  const tag = uniqueTag();
  const post = (content: string) =>
    page.request.post(`/api/chat/channels/${LOBBY}/messages`, { data: { content } });

  // 造数：全程走接口。定位只认哨兵串与折叠按钮，不提大区里到底有多少条
  for (let u = 0; u * PER_USER < TOTAL; u++) {
    await registerFreshUser(page, { core: true });
    for (let i = 0; i < PER_USER; i++) {
      const res = await post(`e2e-fold-${tag}-${u}-${i}`);
      expect(res.status(), `造数发言失败（第 ${u} 个号的第 ${i} 条）`).toBe(200);
    }
  }

  // 观察者用新注册的号：大区基线从 0 起算，不受历史消息影响。它发的这条落在列表尾部，
  // 用来确认「首屏已到位」
  await registerFreshUser(page, { core: true });
  const tail = `e2e-fold-${tag}-tail`;
  expect((await post(tail)).status()).toBe(200);

  await page.goto(`/chat?channel=${LOBBY}`);
  await expect(page.locator('.chat-msg', { hasText: tail })).toBeVisible({ timeout: 8000 });

  const olderBtn = page.locator('.chat-list__older');
  const rows = page.locator('.chat-msg');
  // 把大区往上翻到底（列表就此超过 DOM 上限）。每轮等自己那次请求的响应，别靠超时猜。
  // 旧实现这里会在第 6 次点击后就把顶部换成折叠入口（它把刚拉回来的那页也折掉了）
  for (let i = 0; i < 24; i++) {
    if ((await olderBtn.count()) === 0) break; // 没有更早的可加载了
    if (((await olderBtn.textContent()) ?? '').includes('已折叠')) break;
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/messages?before=') && r.status() === 200),
      olderBtn.click(),
    ]);
  }

  // 尾部再来一条：自动折叠就是「尾部长多少折多少」，折叠入口到这时才该出现
  const live = `e2e-fold-${tag}-live`;
  expect((await post(live)).status()).toBe(200);
  await expect(page.locator('.chat-msg', { hasText: live })).toBeVisible({ timeout: 8000 });
  await expect(olderBtn, `大区消息不足以触发折叠（造数 ${TOTAL} 条没到位？）`).toContainText('已折叠');

  const foldCount = Number(((await olderBtn.textContent()) ?? '').match(/已折叠 (\d+) 条/)![1]);
  const rowsBefore = await rows.count();
  expect(rowsBefore).toBeGreaterThan(0);

  await olderBtn.click();
  // 【为什么要等一拍再断言】旧实现的回弹发生在「点击 → 提交 → effect」的下一拍：中间
  // 会有一帧真的渲染出展开后的列表，当场断言可能正好落在那一帧里通过（假绿）。
  // 必须看落定之后的状态 —— 那才是用户看到的东西。
  await page.waitForTimeout(600);
  await expect(rows).toHaveCount(rowsBefore + Math.min(foldCount, REVEAL_STEP));
});
