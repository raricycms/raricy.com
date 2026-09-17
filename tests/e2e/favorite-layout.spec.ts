// 收藏夹：**布局**端到端（真浏览器 + 真视口）
//
// 【为什么这几条必须走 e2e，单测与截图都证明不了】
// 这三条全是「真渲染出来才发现不对」的问题，而且共同点是**静态看代码看不出错**：
//   · 星标未收藏时就亮着 —— 是 currentColor 被一行 `background-color` 覆盖掉了，
//     CSS 里两处都「对」，只有并排看到三颗按钮才看得出「已收藏」没有辨识度。
//   · 选择器里「创建公开」被挤到第二行 —— 是中文按 500px 宽的弹窗正好差几个像素，
//     算不出来，得让浏览器排版。
//   · 窄屏三颗按钮不在同一行 —— 同理，全靠字体度量。
// 所以判据一律取**渲染后的几何**（boundingBox / getComputedStyle），不取类名或属性。
//
// 【本文件在 RESPONSIVE_SPECS 里】它按视口分支断言，必须两个 project 都跑：
// desktop 那一遍验的是「三颗同行、弹窗两按钮并排」，mobile 那一遍才是窄屏的正面用例。
//
// 【必须用一次性用户】同 favorite.spec.ts：建收藏夹是按用户计限频的（20/时），
// 两个 project 共用同一个限频桶，用种子号会在第二轮的首条操作上吃 429。

import { test, expect } from '@playwright/test';
import { registerFreshUser, uniqueTag } from './helpers';

/** 建一篇博客（走真实接口），返回 id。 */
async function createBlog(
  page: import('@playwright/test').Page,
  title: string
): Promise<string> {
  const res = await page.request.post('/api/blogs', {
    data: { title, description: 'e2e 造数', content: '# 正文' },
  });
  expect(res.status(), `建文章失败：${await res.text()}`).toBe(200);
  return (await res.json()).blog_id as string;
}

/**
 * 三个盒子是否落在同一行。
 *
 * 不用「top 相等」：`.read-controls__row` 是 `align-items: center`，三颗高度差
 * 零点几像素时 top 就对不齐，而它们明明在同一行。改用**纵向区间相交**——
 * 换行时第二行的区间与第一行完全不相交，判定不会有歧义。
 */
async function rowInfo(row: import('@playwright/test').Locator) {
  return row.evaluate((el) => {
    // ★ 只能取**直接子**按钮 ★ FavoriteButton 返回的是 fragment：真实那颗按钮与
    // 选择器弹窗（内含 .btn-close + 两颗创建按钮）**都**挂在 .read-controls__row 下。
    // 用 querySelectorAll('button') 会把弹窗里那三颗也算进来 —— 弹窗关着时它们
    // display:none、宽度为 0，于是「同一行」判定必然失败（第一版就栽在这，
    // 报「宽度 122.8 / 122.8 / 91.2 / 0 / 0 / 0」）。
    const btns = [...el.querySelectorAll(':scope > button')];
    const rects = btns.map((b) => b.getBoundingClientRect());
    const first = rects[0];
    return {
      count: btns.length,
      sameRow: rects.every((r) => r.top < first.bottom - 2 && first.top < r.bottom - 2),
      widths: rects.map((r) => +r.width.toFixed(1)),
      // 标签是否折行：行高 ~1.2em，超过 1.6 倍就是折了
      wrapped: btns
        .filter((b) => {
          const span = b.querySelector('span:not([class])');
          if (!span) return false;
          return (
            span.getBoundingClientRect().height >
            parseFloat(getComputedStyle(span).fontSize) * 1.6
          );
        })
        .map((b) => (b.textContent || '').trim()),
    };
  });
}

test('详情页：点赞 / 投喂 / 收藏 三颗在同一行，且标签不折行', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `布局用例 ${uniqueTag()}`);
  await page.goto(`/blog/${blogId}`);

  const row0 = page.locator('#read-controls .read-controls__row').first();
  await expect(row0.getByRole('button')).toHaveCount(3);

  const info = await rowInfo(row0);
  expect(info.sameRow, `三颗按钮没落在同一行（宽度 ${info.widths.join(' / ')}）`).toBe(true);
  expect(info.wrapped, `按钮标签折行了：${info.wrapped.join('、')}`).toEqual([]);

  // ★ 窄屏专属契约：三颗**等宽**平分。桌面端刻意不等宽（跟随各自内容宽度，
  //   与改造前一致）；<360px 又退回按内容宽度（见 _blog.scss 的兜底）。
  //   所以这条只落在 360~768px 这一档 —— 它正是「压到一行」的做法本身。
  const vw = page.viewportSize()?.width ?? 0;
  if (vw >= 360 && vw <= 768) {
    const [a, b, c] = info.widths;
    expect(
      Math.max(a, b, c) - Math.min(a, b, c),
      `${vw}px 下三颗应当等宽，实际 ${info.widths.join(' / ')}`
    ).toBeLessThan(2);
  }
});

test('详情页：星标未收藏时不亮，收藏后才变黄', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `星标用例 ${uniqueTag()}`);
  await page.goto(`/blog/${blogId}`);

  // 把 CSS 变量交给浏览器自己归一成 rgb()，避免手写 hex → rgb 的换算
  const colors = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const norm = (v: string) => {
      const d = document.createElement('div');
      d.style.color = v.trim();
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    };
    return {
      star: norm(cs.getPropertyValue('--color-star-primary')),
      muted: norm(cs.getPropertyValue('--color-text-secondary')),
    };
  });
  const iconBg = () =>
    page
      .locator('#favorite-btn .icon-star-fill')
      .evaluate((el) => getComputedStyle(el).backgroundColor);

  const btn = page.locator('#favorite-btn');
  await expect(btn).toContainText('收藏');
  // ★ 需求：未收藏时星标**不亮**（跟着文字走 currentColor，与心形/小鱼同机制）
  expect(await iconBg(), '未收藏时星标就已经亮着了').toBe(colors.muted);

  // 建一个私密收藏夹并顺手收藏本文
  await btn.click();
  const modal = page.locator('#favoritePickerModal.is-open');
  await expect(modal).toBeVisible();
  await modal.locator('.favorite-picker__input').fill(`星标夹 ${uniqueTag()}`);
  await modal.getByRole('button', { name: '创建私密收藏夹' }).click();
  await expect(btn).toContainText('已收藏', { timeout: 15_000 });

  // 收藏后才亮成黄色。
  // ★ 必须轮询，不能读一次 ★ `.favorite-btn` 带 `transition: all 0.3s ease`，
  // 类名一挂上动画就开始了 —— 立刻 getComputedStyle 拿到的是**过渡中间值**
  // （实测 rgb(105,119,134)，从灰到黄刚起步），断言会莫名其妙地红。
  await expect
    .poll(iconBg, { message: '已收藏了，星标却没变黄', timeout: 5_000 })
    .toBe(colors.star);
});

test('收藏选择器：名称独占一行，两颗创建按钮并排且等宽、标签不折行', async ({ page }) => {
  await registerFreshUser(page, { core: true });
  const blogId = await createBlog(page, `选择器用例 ${uniqueTag()}`);
  await page.goto(`/blog/${blogId}`);

  await page.locator('#favorite-btn').click();
  const modal = page.locator('#favoritePickerModal.is-open');
  await expect(modal).toBeVisible();

  const geom = await modal.evaluate((el) => {
    const input = el.querySelector('.favorite-picker__input') as HTMLElement;
    const actions = el.querySelector('.favorite-picker__new-actions') as HTMLElement;
    const btns = [...actions.querySelectorAll('button')] as HTMLElement[];
    const ir = input.getBoundingClientRect();
    const brs = btns.map((b) => b.getBoundingClientRect());
    return {
      inputAboveBtns: brs[0].top >= ir.bottom - 1,
      inputSharesRowWithBtns: brs[0].top < ir.bottom - 1 && ir.top < brs[0].bottom - 1,
      btnCount: btns.length,
      btnsSameRow: Math.abs(brs[0].top - brs[1].top) < 2,
      btnWidths: brs.map((r) => +r.width.toFixed(1)),
      wrapped: btns
        .filter(
          (b) =>
            b.getBoundingClientRect().height >
            // 单行按钮的高度上限：行高 1.2em + 上下内边距 + 边框余量
            parseFloat(getComputedStyle(b).fontSize) * 1.6 +
              parseFloat(getComputedStyle(b).paddingTop) * 2
        )
        .map((b) => (b.textContent || '').trim()),
    };
  });

  expect(geom.btnCount, '创建入口应当恰好两颗（私密 / 公开）').toBe(2);
  // ★ 用户报的问题：名称与「创建私密」占一行、「创建公开」被挤到第二行
  expect(geom.inputSharesRowWithBtns, '名称不该和创建按钮挤在同一行').toBe(false);
  expect(geom.inputAboveBtns, '名称应当在创建按钮的上方').toBe(true);
  expect(geom.wrapped, `创建按钮的标签折行了：${geom.wrapped.join('、')}`).toEqual([]);

  // 极窄屏（<360px）刻意退回上下堆叠，所以「并排」这条从 360px 起才成立
  const narrow = (page.viewportSize()?.width ?? 0) < 360;
  if (!narrow) {
    // 注意：`narrow` 为真时下面两条不该断言，但**上面两条永远成立** ——
    // 「名称独占一行」与「标签不折行」在堆叠态下照样必须满足。
    expect(geom.btnsSameRow, '两颗创建按钮没并排').toBe(true);
    expect(
      Math.abs(geom.btnWidths[0] - geom.btnWidths[1]),
      `两颗应当等宽，实际 ${geom.btnWidths.join(' / ')}`
    ).toBeLessThan(2);
  }

  // 页脚有通往管理页的入口（否则 /favorite 只能靠手敲 URL）。
  // 断可见性而不只是 href：放在 .modal-footer 里但不给样式的话它照样在 DOM 里，
  // 只是没人看得见 —— 那和没有入口是一回事。
  const manage = modal.locator('.favorite-picker__manage');
  await expect(manage).toBeVisible();
  await expect(manage).toHaveAttribute('href', '/favorite');
});
