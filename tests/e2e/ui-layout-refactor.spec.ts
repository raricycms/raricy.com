// 功能页**行为**端到端（2026-10 UI 重构后保留下来的部分）
//
// 页头与站点容器的宽度阶梯、签到概览的上下分区、联系页的响应式列数、1440–320 的
// 整页不横向溢出、排行榜网格列数 —— 这些是排版/外观，按仓库纪律不再由 e2e 钉住，
// 由受影响页面与视口的实际检查负责（见 reports/round4/parts/e2e-visual.md）。
//
// 这里保留的是「接口层看不到、只有真浏览器走一遍才对」的行为：账户最近流水与实际
// 账本一致、签到排行榜的折叠/展开与名次保留、设置深链与加载失败重试、商城深链落在
// 固定顶栏之下（命中测试）。
//
// 【不污染种子】流水与长排行榜都用一次性账号（registerFreshUser）；长排行榜的 25 个
// 榜上账号只写独立 e2e 库（E2E_DB 前缀硬校验），afterEach 清掉。

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

test('设置：深链可达、加载失败可重试', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.core.username);
  await desktop(page);

  await page.goto('/settings');
  const nav = page.getByRole('navigation', { name: '设置分组' });
  await expect(nav.locator('a')).toHaveCount(5);
  await expect(page.locator('.settings-section').first()).toBeVisible();

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
