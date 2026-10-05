// ─────────────────────────────────────────────────────────────────────────────
// clipboard-layout.spec.ts —— 剪贴板详情页的**层数**。
//
// 【为什么单独一条】这里曾经是「白卡 → 灰框 → 白卡」。正文由 MarkdownRenderer
// 渲染，而它的根节点 `.blog-content-container` **就是博客详情页的文章卡本体**
// （白底 / 30px 圆角 / 40px 内距 / max-width 900px / margin 40px auto 60px，
// 版式在 pages/blog/_blog.scss）。剪贴板详情页自己已经有一张白卡
// （`.clipboard-detail`），中间还垫了块灰底（`.clipboard-detail__content`）——
// 于是内卡被 900px 掐窄、宽屏下两侧各露 64px 灰边，上下各多出 56 / 76px 灰
// （那 40 与 60 是博客页留给自己的外边距，与这里无关）。
// 现由 `_clipboard.scss` 的 `&__content` 就地抵消那张卡的**外观**（正文排版一条不动）。
// 展开见 docs/frontend-styles.md §12「白卡 → 灰框 → 白卡」。
//
// 【为什么只能靠几何 + computed style 断】这套抵消**坏掉时不报任何错**：页面照常
// 渲染，只是又长回一张内卡。单测读样式表也读不出来（源码里两处规则都好端端地在那儿，
// 胜负取决于权重与加载顺序）。类名不同，`css-tsx-classes` 那类「同名嵌套」扫描同样看不见。
//
// 详情页要 core 用户（requireCoreUser），所以先 API 登录再建内容（同 clipboard-math.spec.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

test.describe('云剪贴板：详情页的层数', () => {
  test('正文不再是博客那张内卡：无底、无内距、左右铺满外卡', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    const res = await page.request.post('/api/clipboard', {
      data: {
        title: `e2e-layout-${uniqueTag()}`,
        content: '一段正文。\n\n```js\nconsole.log(1);\n```\n',
        publicity: true,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { id } = (await res.json()) as { id: string };

    await page.goto(`/clipboard/${id}`);
    await expect(page.locator('.blog-content-container')).toBeVisible();

    const geo = await page.evaluate(() => {
      const card = document.querySelector('.clipboard-detail') as HTMLElement;
      const inner = document.querySelector(
        '.clipboard-detail__content .blog-content-container'
      ) as HTMLElement;
      const cs = getComputedStyle(inner);
      const cardCs = getComputedStyle(card);
      const c = card.getBoundingClientRect();
      const i = inner.getBoundingClientRect();
      return {
        innerBg: cs.backgroundColor,
        innerPaddingLeft: parseFloat(cs.paddingLeft),
        innerMarginTop: parseFloat(cs.marginTop),
        // 外卡**内容盒**的左右边缘（复现「正文该从哪儿开始」）
        cardContentLeft: c.left + parseFloat(cardCs.paddingLeft),
        cardContentRight: c.right - parseFloat(cardCs.paddingRight),
        innerLeft: i.left,
        innerRight: i.right,
      };
    });

    // ① 那张卡的三样皮必须还在被抵消着。任何一样漏掉 = 内卡又长回来
    //    （底色白 / 40px 内距 / 40px 上外边距）。
    expect(geo.innerBg).toBe('rgba(0, 0, 0, 0)');
    expect(geo.innerPaddingLeft).toBe(0);
    expect(geo.innerMarginTop).toBe(0);

    // ② 左右与外层白卡的内容盒对齐 —— 这条抓的是 `max-width: 900px` + `auto` 居中。
    //    内卡被掐窄时这里会差几十到几百像素（1280 视口下每侧 64px）。
    //    容忍 1px：亚像素布局下 getBoundingClientRect 会给小数。
    expect(Math.abs(geo.innerLeft - geo.cardContentLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(geo.innerRight - geo.cardContentRight)).toBeLessThanOrEqual(1);
  });
});
