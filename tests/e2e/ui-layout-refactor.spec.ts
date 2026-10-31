// 功能页版式（2026-10 UI 重构）—— 外壳阶梯、分区版式、加载态与窄屏
//
// 【为什么走 e2e】这一批改的全是**排版关系**：页头是不是和站点容器同一条左右边缘、
// 账户页两个分区在不在同一行、商城是不是真的排成多列、签到主卡与排行榜分没分栏、
// 设置目录有没有变成竖排侧栏。读样式表只能证明「写了一条规则」，证明不了这些盒子
// 在真实排版里落在哪 —— 而这一批恰恰是「规则都在、盒子没动」也不会报错的那类改动。
//
// 【窄屏为什么在同一个文件里量】本文件显式 setViewportSize，不依赖 project：
// desktop 那一遍就跑完全部用例（含 320/390）；不登记 RESPONSIVE_SPECS，避免
// 同一个文件在 mobile 项目里再跑一遍做重复的事。
//
// 【不污染种子】签到两种状态都用一次性账号（registerFreshUser）：
// 共享的 e2e_core 是 desktop/mobile 两轮共用的，签到会发鱼干、写流水、留签到记录。
// 其余用例只读种子账号。

import { test, expect, type Page } from '@playwright/test';
import { loginViaApi, publishBlog, registerFreshUser } from './helpers';
import { SEED_USERS } from './seed';

const DESKTOP = { width: 1440, height: 900 };

async function desktop(page: Page) {
  await page.setViewportSize(DESKTOP);
}

/** 一页的 PageHeader 盒子（这一批普通功能页都该有且只有一个）。 */
async function headerBox(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const header = page.locator('.page-header').first();
  await expect(header).toBeVisible();
  const box = await header.boundingBox();
  expect(box, `${url} 量不到 PageHeader`).not.toBeNull();
  return box!;
}

test('普通功能页的页头与站点容器同一条宽度阶梯', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await desktop(page);

  const routes = [
    '/fish',
    '/fish/transfer',
    '/fish/transactions',
    '/fish/api',
    '/fish/shop',
    '/checkin',
    '/settings',
    '/vote',
    '/contact',
  ];
  const boxes: { url: string; box: Awaited<ReturnType<typeof headerBox>> }[] = [];
  for (const url of routes) boxes.push({ url, box: await headerBox(page, url) });

  // 参照物 = 顶栏的 .site-container（与 .container 共用 site-width-ladder）。
  // 去掉它的左右内距，就是正文内容列的左右边缘 —— 页头必须落在同一条上。
  const chrome = await page.locator('.site-container').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const c = getComputedStyle(el);
    const left = parseFloat(c.paddingLeft);
    const right = parseFloat(c.paddingRight);
    return { x: r.x + left, width: r.width - left - right };
  });
  expect(chrome.width).toBeGreaterThan(1000);

  for (const { url, box } of boxes) {
    expect(Math.abs(box.x - chrome.x), `${url} 的左边缘与顶栏内容列不一致`).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - chrome.width), `${url} 的宽度与顶栏内容列不一致`).toBeLessThanOrEqual(1);
  }
});

test('账户页主次分区、商城多列', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await desktop(page);

  await page.goto('/fish');
  const card = page.locator('.fish-card');
  const more = page.locator('.fish-more');
  await expect(card).toBeVisible();
  await expect(more).toBeVisible();
  const [cardBox, moreBox] = [await card.boundingBox(), await more.boundingBox()];
  expect(cardBox && moreBox).toBeTruthy();
  // 同一行：纵向有交叠；主区在左，次级入口在右。
  expect(cardBox!.y).toBeLessThan(moreBox!.y + moreBox!.height);
  expect(moreBox!.y).toBeLessThan(cardBox!.y + cardBox!.height);
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(moreBox!.x);

  await page.goto('/fish/shop');
  await expect(page.locator('.market-card[data-frame="fishblue"]')).toBeVisible();
  const grid = page.locator('.market-shop__grid');
  await expect(grid).toBeVisible();
  const columns = await grid.evaluate((el) =>
    getComputedStyle(el).gridTemplateColumns.split(/\s+/).filter(Boolean).length
  );
  expect(columns, '桌面商城应排成多列').toBeGreaterThanOrEqual(2);

  const cards = page.locator('.market-shop__grid > .market-card');
  await expect(cards.nth(1)).toBeVisible();
  const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
  expect(a && b).toBeTruthy();
  expect(Math.abs(a!.y - b!.y), '两张卡应在同一行').toBeLessThanOrEqual(2);
  expect(a!.x).toBeLessThan(b!.x);
});

test('签到：桌面主辅分栏 + 完成态主操作；未发文时引导主次分明', async ({ page }) => {
  await desktop(page);

  // ① 已签到：主卡在左、排行榜在右；签到按钮退成状态，「查看今日一言」是主操作。
  await registerFreshUser(page, { core: true });
  await publishBlog(page);
  const checked = await page.request.post('/api/checkin', { data: {} });
  expect((await checked.json()).code, '签到应在干净账号上成功').toBe(200);

  await page.goto('/checkin');
  await expect(page.locator('.checkin-button')).toContainText('已签到');
  const quote = page.getByRole('button', { name: '查看今日一言' });
  await expect(quote).toBeVisible();
  await expect(quote).toHaveClass(/daily-quote-primary/);

  const card = await page.locator('.checkin-card').boundingBox();
  const board = await page.locator('.checkin-leaderboard').boundingBox();
  expect(card && board).toBeTruthy();
  expect(card!.y).toBeLessThan(board!.y + board!.height);
  expect(board!.y).toBeLessThan(card!.y + card!.height);
  expect(card!.x + card!.width).toBeLessThanOrEqual(board!.x);

  // ② 未发文：没有签到按钮；「发表博客」是主操作，「自我介绍」是次级入口。
  await page.context().clearCookies();
  await registerFreshUser(page, { core: true });
  await page.goto('/checkin');
  await expect(page.locator('.checkin-button')).toHaveCount(0);
  const write = page.getByRole('link', { name: '发表博客', exact: true });
  const intro = page.getByRole('link', { name: '看看大家的「自我介绍」', exact: true });
  await expect(write).toHaveClass(/daily-quote-primary/);
  await expect(intro).toHaveClass(/daily-quote-secondary/);
});

test('设置：桌面竖排侧目录、深链可达、加载失败可重试', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await desktop(page);

  await page.goto('/settings');
  const nav = page.getByRole('navigation', { name: '设置分组' });
  await expect(nav.locator('a')).toHaveCount(5);
  await expect(page.locator('.settings-section').first()).toBeVisible();

  // 竖排目录：前两项左边缘相同、纵向依次向下；目录整列在内容左侧。
  const [one, two] = [await nav.locator('a').nth(0).boundingBox(), await nav.locator('a').nth(1).boundingBox()];
  expect(one && two).toBeTruthy();
  expect(Math.abs(one!.x - two!.x)).toBeLessThanOrEqual(1);
  expect(two!.y).toBeGreaterThan(one!.y);
  const section = await page.locator('.settings-section').first().boundingBox();
  expect(one!.x + one!.width).toBeLessThanOrEqual(section!.x);

  // 深链：两段不同层级的锚点都要真的滚到视口里（数据是客户端拉的，
  // 后插入的节点不会让浏览器自动再滚一次 —— 这是本页最容易静默失灵的地方）。
  // 每次从别的页面整页进来，避免同文档 hash 变化让浏览器自己滚到位、掩盖冷启动问题。
  await page.goto('/fish');
  await page.goto('/settings#developer');
  await expect(page.locator('#developer')).toBeInViewport();
  await page.goto('/fish');
  await page.goto('/settings#focus-mode');
  await expect(page.locator('#focus-mode')).toBeInViewport();

  // 加载失败 → 不出现任何可编辑字段 → 重试后恢复。
  // 换一个查询串强制整页加载（同一地址换 hash 不会重新挂载组件）。
  await page.route('**/api/users/me', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 500 }) })
  );
  await page.goto('/settings?load=fail');
  const state = page.locator('.settings-state');
  await expect(state).toBeVisible();
  await expect(state).toContainText('设置加载失败');
  await expect(page.locator('#editBio')).toHaveCount(0);
  await expect(page.locator('.settings-section')).toHaveCount(0);

  await page.unroute('**/api/users/me');
  await state.getByRole('button', { name: '重试' }).click();
  await expect(page.locator('#editBio')).toBeVisible();
  await expect(nav.locator('a')).toHaveCount(5);
});

/** 元素里文本实际占了几行（Range 的行盒数，比 clientHeight 更能识破逐字折行）。 */
async function textLines(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getClientRects().length;
  });
}

test('320 转账余额摘要：标签与单位不断字，长余额不撑破卡片', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/fish/transfer');
  await expect(page.locator('.market-card__balance-value')).toBeVisible();

  // 三样不再并排：标签独立一行；数值与单位在同一行，两者都不逐字折断。
  expect(await textLines(page, '.market-card__balance-label'), '「我的余额」被折断').toBe(1);
  expect(await textLines(page, '.market-card__balance-unit'), '「小鱼干」被折断').toBe(1);
  const [label, value, number, unit] = await Promise.all([
    page.locator('.market-card__balance-label').boundingBox(),
    page.locator('.market-card__balance-value').boundingBox(),
    page.locator('.market-card__balance-number').boundingBox(),
    page.locator('.market-card__balance-unit').boundingBox(),
  ]);
  expect(label && value && number && unit).toBeTruthy();
  expect(label!.y + label!.height).toBeLessThanOrEqual(value!.y + 1);
  // 数值与单位在同一行（纵向有交叠），而不是单位被挤到下一行。
  expect(number!.y).toBeLessThan(unit!.y + unit!.height);
  expect(unit!.y).toBeLessThan(number!.y + number!.height);

  // 只在展示层换一个长余额：账本与真实余额不动，验证的是 CSS 承载。
  await page.locator('.market-card__balance-number').evaluate((el) => {
    el.textContent = '1234567890.1234';
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  expect(await textLines(page, '.market-card__balance-label')).toBe(1);
  expect(await textLines(page, '.market-card__balance-unit'), '长余额把单位挤断了').toBe(1);
  const headFits = await page.locator('.market-card__head').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(headFits, '长余额把摘要条撑出横向滚动').toBe(true);
  const doc = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(doc.doc).toBeLessThanOrEqual(doc.view);
});

test('320 / 390 页头：单个短操作与标题同行，放不下才换行', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const url of ['/checkin', '/fish/transfer']) {
      await page.goto(url);
      const header = page.locator('.page-header').first();
      await expect(header).toBeVisible();
      const [main, actions, box] = await Promise.all([
        page.locator('.page-header__main').boundingBox(),
        page.locator('.page-header__actions').boundingBox(),
        header.boundingBox(),
      ]);
      expect(main && actions && box).toBeTruthy();
      // 同一行：纵向有交叠，且操作整组在标题列的右边。
      expect(actions!.y).toBeLessThan(main!.y + main!.height);
      expect(actions!.y + actions!.height).toBeGreaterThan(main!.y);
      expect(actions!.x).toBeGreaterThanOrEqual(main!.x + main!.width - 1);
      // 抬头没有多出一整行（换行时高度会接近两者之和）。
      expect(box!.height).toBeLessThanOrEqual(Math.max(main!.height, actions!.height) + 2);
      // 标题本身仍是一行，没有被操作挤断。
      expect(await textLines(page, '.page-header__title'), `${url} 在 ${width}px 下标题被折断`).toBe(1);
    }
  }
});

test('联系页：邮箱触控高度与响应式列数', async ({ page }, testInfo) => {
  // ① 320：邮箱是主要点击入口，可点区域至少 44px 高。
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/contact');
  const mail = page.locator('a.contact-row__value[href^="mailto:"]');
  await expect(mail).toBeVisible();
  const box = await mail.boundingBox();
  expect(box, '量不到邮箱链接').not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // ② 768：三条联系方式必须是一列 —— 三列时「问题反馈」的说明只有约 70px 宽，
  // 会被挤成三四个字一行的细列。这里按真实矩形量外壳与说明列宽。
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/contact');
  const rows = page.locator('.contact-row');
  await expect(rows).toHaveCount(3);
  const rowBoxes = await rows.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })
  );
  for (const r of rowBoxes.slice(1)) {
    expect(Math.abs(r.x - rowBoxes[0].x), '单列时三行左边缘应一致').toBeLessThanOrEqual(1);
    expect(Math.abs(r.width - rowBoxes[0].width), '单列时三行宽度应一致').toBeLessThanOrEqual(1);
  }
  for (let i = 1; i < rowBoxes.length; i++) {
    expect(rowBoxes[i].y, '单列时下一行应在前一行下方').toBeGreaterThanOrEqual(
      rowBoxes[i - 1].y + rowBoxes[i - 1].height - 1
    );
  }
  const desc = await page.locator('.contact-row__desc').boundingBox();
  expect(desc, '量不到反馈说明').not.toBeNull();
  expect(desc!.width, '768 下反馈说明被挤成了细列').toBeGreaterThan(240);
  await page.screenshot({ path: testInfo.outputPath('contact-tablet.png'), fullPage: true });

  // ③ 1440：三列回到同一行，左到右依次排列。
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/contact');
  const wide = await page.locator('.contact-row').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y };
    })
  );
  expect(wide).toHaveLength(3);
  expect(Math.abs(wide[0].y - wide[1].y), '三列应在同一行').toBeLessThanOrEqual(2);
  expect(Math.abs(wide[1].y - wide[2].y), '三列应在同一行').toBeLessThanOrEqual(2);
  expect(wide[0].x).toBeLessThan(wide[1].x);
  expect(wide[1].x).toBeLessThan(wide[2].x);
});

test('商城 #shop 深链落在固定顶栏之下（含旧 market 兼容跳转）', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);

  const cases = [
    { url: '/fish/market#shop', expected: /\/fish\/shop#shop$/ },
    { url: '/fish/shop?category=frame#shop', expected: /category=frame#shop$/ },
    { url: '/fish/shop?category=bubble#shop', expected: /category=bubble#shop$/ },
  ];

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const { url, expected } of cases) {
      // 从 /fish 整页进入，等价于冷启动直接打开深链（不是同文档 hash 变化）。
      await page.goto('/fish');
      await page.goto(url);
      await expect(page).toHaveURL(expected);

      const navBottom = await page.locator('.site-container').first().evaluate(
        (el) => el.getBoundingClientRect().bottom
      );
      const title = page.locator('h1#shop');
      await expect(title).toHaveCount(1);

      // 等锚点滚动落定：标题最终 top 必须在固定顶栏下沿之下，而不是 top: 0。
      await expect
        .poll(async () => (await title.boundingBox())?.y ?? -1, {
          message: `${url} 在 ${width}px 下标题没有滚到顶栏之下`,
        })
        .toBeGreaterThanOrEqual(navBottom - 0.5);

      const box = await title.boundingBox();
      expect(box, `${url} 量不到标题`).not.toBeNull();
      const viewport = page.viewportSize()!;
      // 真实矩形：上沿不被顶栏覆盖，且整块标题仍在视口内。
      expect(box!.y, `${url} 标题上沿被顶栏覆盖`).toBeGreaterThanOrEqual(navBottom - 0.5);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

      // 命中测试：标题中线上的元素是标题本身，不是固定栏或别的覆盖层。
      const hit = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el ? (el.closest('#shop') ? 'title' : el.tagName) : null;
        },
        [box!.x + Math.min(20, box!.width / 2), box!.y + box!.height / 2]
      );
      expect(hit, `${url} 标题中线处被其他元素盖住`).toBe('title');
    }
  }
});

test('320 / 390 窄屏：普通功能页整页不横向溢出', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);

  const routes = [
    '/fish',
    '/fish/transfer',
    '/fish/transactions',
    '/fish/api',
    '/fish/shop',
    '/checkin',
    '/settings',
    '/vote',
    '/contact',
  ];
  // 每页至少等到自己的主体块出现再量 —— 客户端拉数据的页面，刚 domcontentloaded
  // 时内容还没长出来，量到的「不溢出」不作数。
  const ready: Record<string, string> = {
    '/fish': '.fish-card',
    '/fish/transfer': '.market-card',
    '/fish/transactions': '.fish-transaction-list, .empty-state',
    '/fish/api': '.fish-api-section',
    '/fish/shop': '.market-shop__grid',
    '/checkin': '.checkin-card',
    '/settings': '.settings-section',
    '/vote': '.vote-access',
    '/contact': '.contact-card',
  };
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const url of routes) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.page-header').first()).toBeVisible();
      await expect(page.locator(ready[url]).first()).toBeVisible();
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        view: window.innerWidth,
      }));
      expect(overflow.doc, `${url} 在 ${width}px 下横向溢出`).toBeLessThanOrEqual(overflow.view);
    }
  }
});
