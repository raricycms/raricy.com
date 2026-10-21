import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { nowForDb, todayStr } from '../../src/lib/db-time';
import { loginViaApi, registerFreshUser, publishBlog, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';
import classics from '../../src/data/daily-quote-classics.json';

// 只在独立 e2e 库设置当天内容夹具。选取并发与稳定性由 service 测试覆盖；
// 浏览器用例需要分别进入「经典免费」与「匿名投稿付费」两种真实交互。
async function edition(quoteId: string) {
  const file = process.env.E2E_DB;
  if (!file?.replace(/\\/g, '/').includes('/tests/.tmp/e2e-')) throw new Error('拒绝连接非 e2e 库');
  const db = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  try {
    await db.dailyQuoteEdition.upsert({ where: { day: todayStr() },
      create: { day: todayStr(), quoteId, createdAt: nowForDb() }, update: { quoteId } });
  } finally { await db.$disconnect(); }
}
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await edition('builtin-001');
});
test.afterEach(async () => edition('builtin-001'));

test('签到弹窗、免费共鸣、私密收藏、当天回看与窄屏焦点', async ({ page }, info) => {
  await registerFreshUser(page, { core: true }); await publishBlog(page);
  await page.goto('/checkin'); await page.getByRole('button', { name: '每日签到', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '每日一言', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('blockquote')).toHaveText(classics[0].content);
  const rect = await dialog.boundingBox(); const viewport = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(15); expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width - 15);
  expect(rect!.height).toBeLessThanOrEqual(viewport.height - 30);
  await page.screenshot({ path: `tests/.tmp/daily-quote-${info.project.name}-light.png` });
  await dialog.getByRole('button', { name: '共鸣，免费' }).click();
  await expect(dialog.getByRole('button', { name: '今日已共鸣' })).toBeDisabled();
  await dialog.getByRole('button', { name: '收藏', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '已收藏', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(3);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  const trigger = page.getByRole('button', { name: '查看今日一言' });
  await expect(trigger).toBeFocused(); await trigger.click();
  await expect(dialog.locator('blockquote')).toHaveText(classics[0].content);
  await page.evaluate(() => (window as unknown as { switchTheme: (theme: string) => void }).switchTheme('dark'));
  await expect(dialog).toHaveCSS('background-color', 'rgb(24, 26, 29)');
  await expect(dialog.locator('blockquote')).toHaveCSS('color', 'rgb(241, 245, 249)');
  await page.screenshot({ path: `tests/.tmp/daily-quote-${info.project.name}-dark.png` });
  await dialog.getByRole('link', { name: '一言集', exact: true }).click();
  await expect(page.getByRole('heading', { name: '一言集', exact: true })).toBeVisible();
  await expect(page.locator('blockquote')).toHaveText(classics[0].content);
  await page.getByRole('button', { name: '已收藏', exact: true }).click();
  await expect(page.getByText('还没有收藏的一言。')).toBeVisible();
  await page.goto('/checkin'); await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看今日一言' })).toBeVisible();
});

test('弹窗投稿→管理员审核→匿名全额投喂与重复保护', async ({ page }, info) => {
  const author = await registerFreshUser(page, { core: true }); await publishBlog(page);
  await page.goto('/checkin'); await page.getByRole('button', { name: '每日签到', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '我也要投稿', exact: true }).click();
  const content = `愿你每天都有好心情${uniqueTag()}`;
  await dialog.getByLabel('一言内容').fill(content);
  await dialog.getByRole('button', { name: '署名方式', exact: true }).click();
  await dialog.getByRole('option', { name: '匿名', exact: true }).click();
  await page.screenshot({ path: `tests/.tmp/daily-quote-${info.project.name}-form.png` });
  await dialog.getByRole('button', { name: '提交投稿', exact: true }).click();
  await expect(dialog.getByText('投稿已提交，等待管理员审核。')).toBeVisible();
  const submissions = (await (await page.request.get('/api/daily-quotes/submissions')).json()).submissions;
  const id = submissions.find((row: { content: string }) => row.content === content).id;
  await loginViaApi(page, SEED_USERS.admin.username);
  await page.goto('/admin/daily-quotes');
  const row = page.locator('.daily-quote-panel').filter({ hasText: content });
  await expect(row).toBeVisible(); await row.getByRole('button', { name: '通过', exact: true }).click();
  await expect(row).toHaveCount(0);
  await edition(id);
  await registerFreshUser(page, { core: true }); await publishBlog(page);
  await page.goto('/checkin'); await page.getByRole('button', { name: '每日签到', exact: true }).click();
  await expect(dialog.locator('blockquote')).toHaveText(content);
  await expect(dialog.getByText('匿名 投稿')).toBeVisible();
  await expect(dialog).not.toContainText(author.username);
  await dialog.getByRole('button', { name: '共鸣，投喂1条鱼干', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '今日已共鸣' })).toBeDisabled();
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(2);
  expect((await page.request.post(`/api/daily-quotes/${id}/resonance`)).status()).toBe(200);
  const ledger = (await (await page.request.get('/api/fish/transactions?type=quote_all')).json()).transactions;
  expect(ledger).toHaveLength(1); expect(ledger[0].amount).toBe(-1); expect(ledger[0].related_user_id).toBeNull();
  await loginViaApi(page, author.username);
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(4);
});

test('一言加载失败可单独重试，签到奖励已到账', async ({ page }) => {
  await registerFreshUser(page, { core: true }); await publishBlog(page);
  await page.route('**/api/daily-quotes/today', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 503, message: '一言加载测试失败' }) }));
  await page.goto('/checkin'); await page.getByRole('button', { name: '每日签到', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toHaveText('一言加载测试失败');
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(3);
  await expect(page.locator('.checkin-today-reward')).toContainText('+3');
  await page.unroute('**/api/daily-quotes/today');
  await dialog.getByRole('button', { name: '重新加载' }).click();
  await expect(dialog.locator('blockquote')).toHaveText(classics[0].content);
});
