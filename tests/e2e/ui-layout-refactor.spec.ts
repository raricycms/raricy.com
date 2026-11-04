// 功能页版式（2026-10 UI 重构）—— 外壳阶梯、分区版式、加载态与窄屏
//
// 【为什么走 e2e】这一批改的全是**排版关系**：页头是不是和站点容器同一条左右边缘、
// 账户概览是不是整宽且服务卡在下方、商城是不是真的排成多列、签到概览与排行榜是不是
// 上下分区、设置目录有没有变成竖排侧栏。读样式表只能证明「写了一条规则」，证明不了
// 这些盒子在真实排版里落在哪 —— 而这一批恰恰是「规则都在、盒子没动」也不会报错的那类改动。
//
// 【视口为什么在同一个文件里量】本文件显式 setViewportSize，不依赖 project：
// desktop 那一遍就跑完全部用例（1440 / 1024 / 768 / 390 / 320）；不登记
// RESPONSIVE_SPECS，避免同一个文件在 mobile 项目里再跑一遍做重复的事。
//
// 【不污染种子】签到两种状态、最近流水与长排行榜都用一次性账号（registerFreshUser）；
// 长排行榜的 25 个榜上账号只写独立 e2e 库（E2E_DB 前缀硬校验），afterEach 清掉。
// 共享的 e2e_core 是 desktop/mobile 两轮共用的，签到会发鱼干、写流水、留签到记录。
// 其余用例只读种子账号。

import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { dayStart, nowForDb, todayStr } from '../../src/lib/db-time';
import { loginViaApi, publishBlog, registerFreshUser, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

// 排行榜长名单夹具只写独立 e2e 库（前缀硬校验，同 daily-quote.spec）。
let boardDb: PrismaClient | null = null;
const boardFixtureUserIds: string[] = [];
function e2eDb(): PrismaClient {
  const file = process.env.E2E_DB;
  if (!file?.replace(/\\/g, '/').includes('/tests/.tmp/e2e-')) throw new Error('拒绝连接非 e2e 库');
  boardDb ??= new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  return boardDb;
}

test.afterEach(async () => {
  if (!boardFixtureUserIds.length) return;
  const db = e2eDb();
  await db.dailyCheckIn.deleteMany({ where: { userId: { in: boardFixtureUserIds } } });
  await db.user.deleteMany({ where: { id: { in: boardFixtureUserIds } } });
  boardFixtureUserIds.length = 0;
});

test.afterAll(async () => {
  await boardDb?.$disconnect();
});

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

test('账户页：整宽概览在上，服务卡与最近流水在下，商城多列', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await desktop(page);

  await page.goto('/fish');
  const header = await page.locator('.page-header').first().boundingBox();
  const card = page.locator('.fish-card');
  const services = page.locator('.fish-services');
  const recent = page.locator('.fish-recent');
  await expect(card).toBeVisible();
  await expect(services).toBeVisible();
  await expect(recent).toBeVisible();
  const cardBox = await card.boundingBox();
  const servicesBox = await services.boundingBox();
  const recentBox = await recent.boundingBox();
  expect(header && cardBox && servicesBox && recentBox).toBeTruthy();

  // 概览卡是整宽的主区，不再是「左边一张卡 + 右边一小块」。
  expect(Math.abs(cardBox!.x - header!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(cardBox!.width - header!.width)).toBeLessThanOrEqual(1);
  // 服务卡与最近流水依次在下方，而不是右侧。
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(servicesBox!.y);
  expect(servicesBox!.y + servicesBox!.height).toBeLessThanOrEqual(recentBox!.y);

  // 桌面：余额在左、三个操作在右，同一行；三个操作都在那一个容器里。
  const balance = await page.locator('.fish-card__balance').boundingBox();
  const actions = await page.locator('.fish-card__actions').boundingBox();
  expect(balance && actions).toBeTruthy();
  expect(balance!.y).toBeLessThan(actions!.y + actions!.height);
  expect(actions!.y).toBeLessThan(balance!.y + balance!.height);
  expect(balance!.x + balance!.width).toBeLessThanOrEqual(actions!.x);
  await expect(page.locator('.fish-card__actions > *')).toHaveCount(3);

  // 商城 / 练手盘两张服务卡等宽并排；单张时也不会缩成侧栏。
  const serviceCards = page.locator('.fish-service');
  await expect(serviceCards).toHaveCount(2);
  const [s0, s1] = [await serviceCards.nth(0).boundingBox(), await serviceCards.nth(1).boundingBox()];
  expect(s0 && s1).toBeTruthy();
  expect(Math.abs(s0!.y - s1!.y), '两张服务卡应在同一行').toBeLessThanOrEqual(2);
  expect(Math.abs(s0!.width - s1!.width), '两张服务卡应等宽').toBeLessThanOrEqual(1);
  expect(s0!.x).toBeLessThan(s1!.x);

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

test('账户最近流水与实际账本一致，查看全部指向流水页', async ({ page }) => {
  const sender = await registerFreshUser(page, { core: true });
  await publishBlog(page);
  const checked = await page.request.post('/api/checkin', { data: {} });
  expect((await checked.json()).code, '签到应成功').toBe(200);

  // 第二个一次性账号作收款人 —— 不碰任何共享种子账号。
  await page.context().clearCookies();
  const receiver = await registerFreshUser(page, { core: true });
  await loginViaApi(page, sender.username);
  for (let i = 0; i < 5; i++) {
    const sent = await page.request.post('/api/fish/market/transfer', {
      data: { to_user_id: receiver.id, amount: 0.1, note: `e2e 最近流水 ${i}` },
    });
    expect((await sent.json()).code, `第 ${i + 1} 笔转账应成功`).toBe(200);
  }
  // 再让收款人回一笔，覆盖「收入」行的正号格式。
  await page.context().clearCookies();
  await loginViaApi(page, receiver.username);
  const back = await page.request.post('/api/fish/market/transfer', {
    data: { to_user_id: sender.id, amount: 0.2, note: 'e2e 回礼' },
  });
  expect((await back.json()).code, '回礼应成功').toBe(200);
  await page.context().clearCookies();
  await loginViaApi(page, sender.username);

  // 该接口忽略 per_page；取默认分页后自己切前五，不把「请求了 5 条」当成显示条数证据。
  const res = await page.request.get('/api/fish/transactions?page=1');
  const ledger = (await res.json()) as {
    transactions: { amount: number; description: string | null; type: string }[];
  };
  expect(ledger.transactions.length, '签到 + 五笔转出 + 一笔收入').toBeGreaterThanOrEqual(6);
  const latest = ledger.transactions.slice(0, 5);

  await page.goto('/fish');
  const rows = page.locator('.fish-recent__row');
  await expect(rows).toHaveCount(5);
  for (const [i, tx] of latest.entries()) {
    const row = rows.nth(i);
    await expect(row.locator('.fish-recent__desc')).toHaveText(tx.description ?? tx.type);
    await expect(row.locator('.fish-recent__amount')).toContainText(
      `${tx.amount > 0 ? '+' : ''}${tx.amount.toFixed(4)}`
    );
    await expect(row.locator('.fish-recent__time')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  }
  // 最新五条里同时有收入（正号）与支出（负号）。
  expect(latest.some((tx) => tx.amount > 0), '应覆盖收入行').toBe(true);
  expect(latest.some((tx) => tx.amount < 0), '应覆盖支出行').toBe(true);
  expect(latest.length).toBeLessThan(ledger.transactions.length);
  await expect(page.locator('.fish-recent__all')).toHaveAttribute('href', '/fish/transactions');
});

test('签到：整宽概览在上、排行榜在下；完成态主操作；未发文时引导主次分明', async ({ page }) => {
  await desktop(page);

  // ① 已签到：概览卡与排行榜都是整宽，排行榜在下方；签到按钮退成状态，
  //    「查看今日一言」是主操作。
  await registerFreshUser(page, { core: true });
  await publishBlog(page);
  const checked = await page.request.post('/api/checkin', { data: {} });
  expect((await checked.json()).code, '签到应在干净账号上成功').toBe(200);

  await page.goto('/checkin');
  await expect(page.locator('.checkin-button')).toContainText('已签到');
  const quote = page.getByRole('button', { name: '查看今日一言' });
  await expect(quote).toBeVisible();
  await expect(quote).toHaveClass(/daily-quote-primary/);

  const header = await page.locator('.page-header').first().boundingBox();
  const card = await page.locator('.checkin-card').boundingBox();
  const board = await page.locator('.checkin-leaderboard').boundingBox();
  expect(header && card && board).toBeTruthy();
  // 两张卡都吃满容器宽度；排行榜在概览卡下方，而不是右侧。
  for (const box of [card!, board!]) {
    expect(Math.abs(box.x - header!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - header!.width)).toBeLessThanOrEqual(1);
  }
  expect(card!.y + card!.height).toBeLessThanOrEqual(board!.y);

  // 桌面概览内部：左侧是「问候 + 日期 + 累计天数」一组，右侧是今日操作。
  const [summary, task, greeting, date, stat] = await Promise.all([
    page.locator('.checkin-card__summary').boundingBox(),
    page.locator('.checkin-card__task').boundingBox(),
    page.locator('.checkin-card__greeting').boundingBox(),
    page.locator('.checkin-card__date').boundingBox(),
    page.locator('.checkin-stats').boundingBox(),
  ]);
  expect(summary && task && greeting && date && stat).toBeTruthy();
  // 两个信息组左右并排，且纵向有交叠。
  expect(summary!.x + summary!.width).toBeLessThanOrEqual(task!.x);
  expect(summary!.y).toBeLessThan(task!.y + task!.height);
  expect(task!.y).toBeLessThan(summary!.y + summary!.height);
  // 问候与日期相邻，而不是各占巨宽列的两端。
  expect(date!.x - (greeting!.x + greeting!.width)).toBeLessThanOrEqual(32);
  // 累计天数在左侧信息组里、问候之下。
  expect(stat!.x).toBeGreaterThanOrEqual(summary!.x - 1);
  expect(stat!.x + stat!.width).toBeLessThanOrEqual(summary!.x + summary!.width + 1);
  expect(greeting!.y + greeting!.height).toBeLessThanOrEqual(stat!.y);

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

test('签到排行榜：前十折叠、展开全部，自己排名保留', async ({ page }) => {
  // 当前账号 19 天；另造 25 个只在独立 e2e 库里的榜上账号（20–44 天），
  // 让「我」稳定落在前十之外。fixture 在 afterEach 清理。
  const me = await registerFreshUser(page, { core: true });
  const db = e2eDb();
  const tag = uniqueTag();
  const baseDay = dayStart(todayStr());
  for (let i = 0; i < 25; i++) {
    const id = `e2e-ui-board-${tag}-${i}`;
    const count = 44 - i;
    await db.user.create({
      data: {
        id,
        username: `e2e_board_${tag}_${i}`,
        email: `${id}@e2e.local`,
        passwordHash: 'e2e-fixture-no-login',
        role: 'core',
        createdAt: nowForDb(),
      },
    });
    boardFixtureUserIds.push(id);
    await db.dailyCheckIn.createMany({
      data: Array.from({ length: count }, (_, k) => ({
        userId: id,
        checkinDate: new Date(baseDay.getTime() - k * 86_400_000),
        createdAt: nowForDb(),
      })),
    });
  }
  await db.dailyCheckIn.createMany({
    data: Array.from({ length: 19 }, (_, k) => ({
      userId: me.id,
      checkinDate: new Date(baseDay.getTime() - k * 86_400_000),
      createdAt: nowForDb(),
    })),
  });

  await desktop(page);
  await page.goto('/checkin');
  // 用类名 + 作用域定位：展开后会出现第二个「收起」，按名称或裸类名都会撞 strict。
  const topToggle = page.locator('.checkin-leaderboard__head .checkin-leaderboard__toggle');
  const footToggle = page.locator('.checkin-leaderboard__foot .checkin-leaderboard__toggle');
  await expect(topToggle).toHaveText(/展开全部 \d+ 人/);
  await expect(topToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(footToggle).toHaveCount(0);
  await expect(topToggle).toHaveAttribute('aria-controls', 'checkin-leaderboard-body');

  const grid = page.locator('.checkin-leaderboard__list');
  await expect(grid.locator('.checkin-leaderboard__item')).toHaveCount(10);
  const self = page.locator('.checkin-leaderboard__self .checkin-leaderboard__item');
  await expect(self).toHaveCount(1);
  await expect(self).toContainText(me.username);
  const selfRank = Number((await self.locator('.checkin-leaderboard__rank').innerText()).replace('#', ''));
  expect(selfRank, '自己的名次必须保留真实值且在前十之外').toBeGreaterThan(10);

  // 桌面两列；不产生内部滚动。
  expect(
    await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(/\s+/).filter(Boolean).length)
  ).toBe(2);
  expect(await grid.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

  // innerText 会在非行内子元素（数字的 .numeric span）两侧插换行，读 textContent
  // 并做空白归一化；匹配失败必须有可读的报错，而不是对 null 取 [1]。
  const toggleText = ((await topToggle.textContent()) ?? '').replace(/\s+/g, ' ');
  const totalMatch = /展开全部\s*(\d+)\s*人/.exec(toggleText);
  expect(totalMatch, `顶部展开按钮文本无法解析：${JSON.stringify(toggleText)}`).not.toBeNull();
  const total = Number(totalMatch![1]);
  expect(total).toBeGreaterThan(10);
  await topToggle.click();
  await expect(topToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(topToggle).toHaveText('收起');
  await expect(footToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(grid.locator('.checkin-leaderboard__item')).toHaveCount(total);
  await expect(page.locator('.checkin-leaderboard__self')).toHaveCount(0);
  expect(await grid.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

  // 手机单列；再点一次收起，自己那一行回到折叠视图。
  await page.setViewportSize({ width: 390, height: 800 });
  expect(
    await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(/\s+/).filter(Boolean).length)
  ).toBe(1);
  // 底部的收起入口（展开后才有）：不用滚回顶部。
  await footToggle.click();
  await expect(topToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(topToggle).toBeFocused();
  await expect(footToggle).toHaveCount(0);
  await expect(grid.locator('.checkin-leaderboard__item')).toHaveCount(10);
  await expect(page.locator('.checkin-leaderboard__self')).toHaveCount(1);

  // 顶部按钮本身仍可再次展开并收起。
  await topToggle.click();
  await expect(topToggle).toHaveAttribute('aria-expanded', 'true');
  await topToggle.click();
  await expect(topToggle).toHaveAttribute('aria-expanded', 'false');
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

test('转账：桌面双栏（右栏在表单右侧）、窄屏单列（右栏落在表单下方）', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);

  // 1440：表单仍是 560 的左列，右栏与它同一顶线并贴在右侧 —— 右半边不再空着。
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/fish/transfer');
  const card = page.locator('.fish-transfer__layout .market-card').first();
  await expect(card).toBeVisible();
  await expect(page.locator('.fish-transfer__aside')).toBeVisible();

  const wide = { card: await card.boundingBox(), aside: await page.locator('.fish-transfer__aside').boundingBox() };
  expect(wide.card && wide.aside, '量不到双栏盒子').toBeTruthy();
  expect(wide.aside!.x, '右栏没有落在表单右侧').toBeGreaterThanOrEqual(wide.card!.x + wide.card!.width - 0.5);
  expect(Math.abs(wide.aside!.y - wide.card!.y), '右栏与表单没有对齐顶线').toBeLessThanOrEqual(1);
  // 右栏必须真的吃掉剩余宽度，而不是又缩成一张窄卡。
  expect(wide.aside!.width, '右栏仍然很窄').toBeGreaterThan(300);
  const wideOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(wideOverflow, '双栏把页面撑出横向滚动').toBeLessThanOrEqual(0);

  // 992：同一容器阶梯的起点，右栏只剩 ~344px，仍须在右侧且不溢出。
  await page.setViewportSize({ width: 992, height: 900 });
  await page.reload();
  await expect(page.locator('.fish-transfer__aside')).toBeVisible();
  const narrow = { card: await card.boundingBox(), aside: await page.locator('.fish-transfer__aside').boundingBox() };
  expect(narrow.card && narrow.aside).toBeTruthy();
  expect(narrow.aside!.x, '992 档右栏没有落在表单右侧').toBeGreaterThanOrEqual(narrow.card!.x + narrow.card!.width - 0.5);
  const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(narrowOverflow, '992 档把页面撑出横向滚动').toBeLessThanOrEqual(0);

  // 390：折成单列，右栏整体落到表单下方（顺序不变：先转账，后信息）。
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await expect(page.locator('.fish-transfer__aside')).toBeVisible();
  const stacked = { card: await card.boundingBox(), aside: await page.locator('.fish-transfer__aside').boundingBox() };
  expect(stacked.card && stacked.aside).toBeTruthy();
  expect(stacked.aside!.y, '窄屏右栏没有落到表单下方').toBeGreaterThanOrEqual(stacked.card!.y + stacked.card!.height - 0.5);
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

test('1440–320 普通功能页整页不横向溢出', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);

  const flattened = [
    '/fish/transfer',
    '/fish/transactions',
    '/fish/api',
    '/fish/shop',
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

  // 本轮重排的页面（账户 / 签到 / 转账双栏）覆盖全部五档宽度。
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const url of ['/fish', '/checkin', '/fish/transfer']) {
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

  // 其余普通页仍按手机两档验收。
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const url of flattened) {
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
