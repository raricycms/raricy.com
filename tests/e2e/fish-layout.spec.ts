// 小鱼干余额页 /fish 的**布局**端到端（真浏览器 + 真字体度量）
//
// 【为什么必须走 e2e】「查看流水 / 鱼干市场 / 收款码 三颗压在同一行」是中文在 0.9rem
// 下排出来的事实：图标两种尺寸（svg.lucide 被 _icons.scss 统一成 1em、span.icon 是
// 1.2rem）、字宽、内边距、gap 四者相加，读代码算不出那几个像素 —— 用户报的就是 390px
// 下第三颗「收款码」被挤到第二行。断点与算术写在 _fish.scss 的 480px / 360px 两档里。
//
// 【本文件在 RESPONSIVE_SPECS 里】它按视口分支断言：desktop 那一遍验「文案没被压缩、
// 三颗仍同行」，mobile 那一遍才是压缩后的正面用例。只跑一遍等于有一半没验。
//
// 【文案压缩靠 display:none 藏前缀】所以判据要用 innerText（渲染后的文本）而不是
// textContent —— 后者照样读得到被藏起来的「查看 / 鱼干」，这条用例会永远通过。

import { test, expect } from '@playwright/test';
import { registerFreshUser } from './helpers';

test('余额页：三颗行动在同一行，窄屏只留「流水 / 市场 / 收款码」', async ({ page }) => {
  // /fish 只要求登录（不限档位），故不必提权成 core
  await registerFreshUser(page);
  await page.goto('/fish');

  const row = page.locator('.fish-card__actions');
  await expect(row).toBeVisible();

  const info = await row.evaluate((el) => {
    const kids = [...el.children] as HTMLElement[];
    const rects = kids.map((k) => k.getBoundingClientRect());
    const first = rects[0];
    return {
      count: kids.length,
      // 「同一行」用纵向区间相交判：flex 的 align-items: center 下三颗高度差零点几
      // 像素时 top 就对不齐，而它们明明在同一行。换行时两行区间完全不相交，无歧义。
      sameRow: rects.every((r) => r.top < first.bottom - 2 && first.top < r.bottom - 2),
      texts: kids.map((k) => k.innerText.replace(/\s+/g, '')),
      widths: rects.map((r) => +r.width.toFixed(1)),
      rowWidth: +el.getBoundingClientRect().width.toFixed(1),
      sum: +rects.reduce((a, r) => a + r.width, 0).toFixed(1),
    };
  });

  expect(info.count, '三颗行动：流水 / 市场 / 收款码').toBe(3);
  expect(
    info.sameRow,
    `三颗没落在同一行：可用 ${info.rowWidth}px，三颗合计 ${info.sum}px（${info.widths.join(' / ')}）`
  ).toBe(true);

  const vw = page.viewportSize()?.width ?? 0;
  if (vw <= 480) {
    expect(info.texts, '窄屏应当压缩成「流水 / 市场 / 收款码」').toEqual(['流水', '市场', '收款码']);
  } else {
    expect(info.texts, '桌面端不该压缩文案').toEqual(['查看流水', '鱼干市场', '收款码']);
  }

  // ★ 整条文案必须是 .fish-card__link（inline-flex）的**一个**子元素 ★
  // 散着写（前缀 span 与正文各自成为 flex 项）时中间会吃一道 gap，桌面端就渲染成
  // 「查看 流水」—— 视觉上词被劈开，而 innerText 归一化空白后照样是「查看流水」，
  // 上面那条断言看不出来。所以这里按**渲染宽度**再钉一次：整条文案比前缀宽出约两字。
  const labels = await page.locator('.fish-card__link-label').evaluateAll((els) =>
    els.map((el) => ({
      text: el.innerText.replace(/\s+/g, ''),
      full: +el.getBoundingClientRect().width.toFixed(1),
      prefix: +((el.querySelector('.fish-card__link-prefix') as HTMLElement)?.getBoundingClientRect().width ?? 0).toFixed(1),
    }))
  );
  expect(labels.length, '两条带前缀的文案都该有 .fish-card__link-label 这层壳').toBe(2);
  if (vw > 480) {
    for (const l of labels) {
      expect(
        l.full - l.prefix,
        `「${l.text}」只剩前缀宽度了（整条 ${l.full}px / 前缀 ${l.prefix}px）——文案八成被拆成了多个 flex 项`
      ).toBeGreaterThan(20); // 两字 ≈ 28.8px，取 20 留字体度量余量
    }
  }
});
