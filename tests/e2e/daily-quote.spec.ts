import { test, expect, type Locator, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { dayStart, nowForDb, todayStr } from '../../src/lib/db-time';
import { loginViaApi, registerFreshUser, publishBlog, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';
import classics from '../../src/data/daily-quote-classics.json';

// ─────────────────────────────────────────────────────────────────────────────
// 每日一言 e2e：签到弹窗（今日）+ 往期一言（历史入口）+ 一言集（私密收藏）。
//
// 【两套夹具，各自只管一件事】
//   · 当天那期：`edition()` 把今天的 edition 指向 classics[0]（正文、免费/付费两种
//     真实交互都在弹窗里验）。
//   · 往期：`seedPastEdition()` 现造（`npx prisma db push` 建出来的独立 e2e 库，
//     文件名硬校验过前缀，绝不会连到开发/生产库）。只在需要历史入口的用例里造。
//
// 【为什么 afterEach 要把往期 fixture 全清掉】desktop 与 mobile 两个 project
// **共用同一个库**：分页用例留下的 21 条往期会让另一遍「往期只有 2 条」的断言当场
// 变红，而那看起来像产品坏了。清的是 `day < today` 的全部 edition —— e2e 库里没有
// 种子往期，往期只可能来自本文件。用例中途失败也照清（afterEach 一定会跑）。
//
// 【为什么不写真实日期】夹具日期一律由 db-time 的 todayStr() 相对推算（pastDay(n)），
// 不用 `new Date()` 的本地日期 —— 换时区、换运行时刻都得到同一组夹具。
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_PREFIX = 'e2e-quote-fixture-';

let db: PrismaClient | null = null;

/** 独立 e2e 库（照 `edition()` 原有的写法，前缀硬校验保留）。 */
function e2eDb(): PrismaClient {
  const file = process.env.E2E_DB;
  if (!file?.replace(/\\/g, '/').includes('/tests/.tmp/e2e-')) throw new Error('拒绝连接非 e2e 库');
  db ??= new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  return db;
}

/** 相对今天的过去某天（UTC+8 墙上日期，daysAgo >= 1）。 */
function pastDay(daysAgo: number): string {
  return new Date(dayStart(todayStr()).getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

// 只在独立 e2e 库设置当天内容夹具。选取并发与稳定性由 service 测试覆盖；
// 浏览器用例需要分别进入「经典免费」与「匿名投稿付费」两种真实交互。
async function edition(quoteId: string) {
  const today = todayStr();
  await e2eDb().dailyQuoteEdition.upsert({
    where: { day: today },
    create: { day: today, quoteId, createdAt: nowForDb() },
    update: { quoteId },
  });
  await e2eDb().dailyQuote.updateMany({ where: { id: quoteId, kind: 'community', firstSelectedDay: null }, data: { firstSelectedDay: today } });
}

type PastEditionSpec = {
  /** 相对今天的天数（>= 1）。 */
  daysAgo: number;
  /** 复用经典语录：下标指向 src/data/daily-quote-classics.json。给了就不再造正文。 */
  classicIndex?: number;
  /** 社区投稿正文（必须唯一，用 uniqueTag 拼）。 */
  content?: string;
  submitterId?: string;
  signature?: 'nickname' | 'anonymous';
  /** 审核状态，默认 approved —— 往期只展示通过的内容。 */
  status?: string;
};

/**
 * 造一条往期：可指定日期的 edition（内容要么复用经典语录，要么现造一条社区投稿）。
 *
 * 社区投稿的 id 带 `e2e-quote-fixture-` 前缀 —— 清理靠这个前缀找回来，所以别用别的
 * 形状生成 id。经典语录直接用种子行（global-setup 已按 approved 灌好）。
 */
async function seedPastEdition(spec: PastEditionSpec): Promise<{ day: string; quoteId: string }> {
  const client = e2eDb();
  const day = pastDay(spec.daysAgo);
  let quoteId: string;
  if (spec.classicIndex !== undefined) {
    quoteId = classics[spec.classicIndex].id;
  } else {
    if (!spec.content || !spec.submitterId) throw new Error('社区投稿夹具必须给 content 与 submitterId');
    quoteId = `${FIXTURE_PREFIX}${uniqueTag()}`;
    await client.dailyQuote.create({
      data: {
        id: quoteId,
        kind: 'community',
        content: spec.content,
        // contentKey 只要求全库唯一；正经的归一化哈希由 service 的 submitQuote 负责，
        // 夹具不必复刻（读口一次都不读它）。
        contentKey: `${quoteId}-content-key`,
        category: '治愈',
        signature: spec.signature ?? 'nickname',
        sourceType: 'original',
        submitterId: spec.submitterId,
        status: spec.status ?? 'approved',
        createdAt: nowForDb(),
      },
    });
  }
  await client.dailyQuoteEdition.create({ data: { day, quoteId, createdAt: nowForDb() } });
  return { day, quoteId };
}

/**
 * 注册一个 core 新号：注册走真实接口（顺带验注册链路），**提权直写库**。
 *
 * 【为什么不用 registerFreshUser({ core: true })】那个 helper 借管理员 PATCH 提权，
 * 于是每条用例都多一次 `e2e_admin` 登录；而密码校验是**按用户** 20 次/分限频的
 * （RULES.passwordPerUser，见 src/lib/password-budget.ts，成功也计数）。e2e_admin 是
 * 全套用例共用的种子号：desktop + mobile 两遍放在**同一轮**里跑时，本文件的注册次数
 * 就能把它顶满 —— 实测两遍连跑时第 21 次 admin 登录直接 429，从那条起所有往期用例
 * 都挂在「注册失败」上（看起来像注册坏了，实际是同一个桶）。角色是夹具要构造的状态，
 * 不值得为它反复登录共用账号。
 */
async function registerCoreUser(page: Page, withBlog = true) {
  const user = await registerFreshUser(page);
  await e2eDb().user.update({ where: { id: user.id }, data: { role: 'core' } });
  if (withBlog) await publishBlog(page);
  return user;
}

/** 用例临时改过审核状态的种子行（下架用例）：值原样恢复，别把种子数据留成 retired。 */
const statusRestores: Array<{ id: string; status: string }> = [];

async function restoreQuoteStatuses() {
  const client = e2eDb();
  for (const item of statusRestores.splice(0)) {
    await client.dailyQuote.updateMany({ where: { id: item.id }, data: { status: item.status } });
  }
}

/** 清掉本文件造的全部往期夹具（edition 先删，再删它引用的新内容）。 */
async function cleanupPastFixtures() {
  const client = e2eDb();
  await client.dailyQuoteEdition.deleteMany({ where: { day: { lt: todayStr() } } });
  const mine = { quoteId: { startsWith: FIXTURE_PREFIX } };
  // 先删引用方（外键是 Restrict），否则删 daily_quotes 会被挡下。
  await client.dailyQuoteRevision.deleteMany({ where: mine });
  await client.dailyQuoteResonanceOnce.deleteMany({ where: mine });
  await client.dailyQuoteResonance.deleteMany({ where: mine });
  await client.dailyQuoteFavorite.deleteMany({ where: mine });
  await client.dailyQuote.deleteMany({ where: { id: { startsWith: FIXTURE_PREFIX } } });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await edition('builtin-001');
});
test.afterEach(async () => {
  await edition('builtin-001');
  await restoreQuoteStatuses();
  await cleanupPastFixtures();
});
test.afterAll(async () => {
  await db?.$disconnect();
  db = null;
});

// ── 往期页的交互小工具 ──────────────────────────────────────────────────────
//
// 往期列表是客户端组件（QuoteHistory）—— SSR 出来的按钮在水合完成前点上一下是
// **静默空操作**：没有报错、没有请求，只有「点了没反应」。所以这里的点击一律
// 「点到状态真的变了为止」，而不是点一次就算。两条都只往**单调方向**重试
//（共鸣一生一次；收藏重试是 POST upsert，重复提交得到同一状态），不会把状态点反。

/** 点一张往期卡上的共鸣按钮，直到它真的进了「已共鸣」态。 */
async function resonateCard(card: Locator) {
  const done = card.getByRole('button', { name: '已共鸣', exact: true });
  await expect(async () => {
    if (await done.count()) return;
    await card.getByRole('button', { name: /^共鸣，/ }).click();
    await expect(done).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** 点一张往期卡上的收藏按钮，直到它真的进了「已收藏」态。 */
async function favoriteCard(card: Locator) {
  const done = card.getByRole('button', { name: '已收藏', exact: true });
  const idle = card.getByRole('button', { name: '收藏', exact: true });
  await expect(async () => {
    if (await done.count()) return;
    // 请求在途时按钮是 disabled 的：此时别重点（否则等它 enabled 后会再点一次）
    if (await idle.isDisabled().catch(() => false)) throw new Error('收藏请求在途，等下一轮');
    await idle.click();
    await expect(done).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** 一张往期 / 一言集卡片（整页卡片数一般 >1，所以按正文过滤）。 */
function quoteCard(page: Page, content: string): Locator {
  return page.locator('article.daily-quote-card').filter({ hasText: content });
}

async function historyApi(page: Page) {
  const response = await page.request.get('/api/daily-quotes/history');
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    page: number;
    pages: number;
    total: number;
    editions: Array<{
      day: string;
      quote: {
        id: string;
        resonated: boolean;
        favorited: boolean;
        resonance_count: number;
        can_resonate: boolean;
      } | null;
    }>;
  };
}

async function fishBalance(page: Page): Promise<number> {
  const response = await page.request.get('/api/fish/balance');
  expect(response.status()).toBe(200);
  return (await response.json()).balance;
}

/**
 * 整页不许出现横向滚动。
 *
 * 往期卡片是「正文 + 两枚按钮 + 费用」的紧凑行，窄屏最容易把操作行撑出视口；
 * 而撑宽之后整页能横着拖、固定层会跟着错位 —— 与签到粒子那条用例同一个判据。
 */
async function expectNoHorizontalScroll(page: Page) {
  const metrics = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    metrics.scroll,
    `文档被撑宽（可横向滚动）：scrollWidth=${metrics.scroll} clientWidth=${metrics.client}`
  ).toBeLessThanOrEqual(metrics.client);
}

test('无博客时各一言页面统一引导，发文后恢复，删光后再次受限', async ({ page }) => {
  const user = await registerCoreUser(page, false);
  for (const url of ['/checkin', '/checkin/quotes', '/favorite/quotes', '/checkin/submissions']) {
    await page.goto(url);
    await expect(page.getByText('请先发表一篇博客，再使用每日一言。不妨从自我介绍开始。')).toBeVisible();
    await expect(page.getByRole('link', { name: '发表博客', exact: true })).toBeVisible();
    await expect(page.locator('.daily-quote-list')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  }
  expect(await (await page.request.get('/api/daily-quotes/history')).json()).toMatchObject({ code: 403, reason: 'BLOG_REQUIRED' });
  await publishBlog(page);
  await page.goto('/checkin/submissions');
  await expect(page.getByRole('form', { name: '提交一言' })).toBeVisible();
  await e2eDb().blog.updateMany({ where: { authorId: user.id }, data: { ignore: true } });
  await page.reload();
  await expect(page.getByRole('link', { name: '发表博客', exact: true })).toBeVisible();
  expect((await page.request.post('/api/daily-quotes/submissions', { data: { content: '不能绕过发文门槛' } })).status()).toBe(403);
});

test('投稿人降级后可以免费共鸣；恢复资格不补扣、不重复计数', async ({ page }) => {
  const author = await registerCoreUser(page);
  const content = `免费共鸣样本${uniqueTag()}`;
  const { quoteId } = await seedPastEdition({ daysAgo: 1, content, submitterId: author.id });
  await e2eDb().user.update({ where: { id: author.id }, data: { role: 'user' } });
  await registerCoreUser(page);
  await page.goto('/checkin/quotes');
  const card = quoteCard(page, content);
  await expect(card.getByRole('button', { name: '共鸣', exact: true })).toBeEnabled();
  await resonateCard(card);
  expect(await fishBalance(page)).toBe(0);
  expect((await e2eDb().dailyQuoteResonance.findFirstOrThrow({ where: { quoteId } })).paidUnits).toBe(0);
  expect(await e2eDb().fishTransaction.count({ where: { referenceId: quoteId } })).toBe(0);
  await e2eDb().user.update({ where: { id: author.id }, data: { role: 'core' } });
  const repeat = await page.request.post(`/api/daily-quotes/${quoteId}/resonance`, { data: { max_fish: 0 } });
  expect(await repeat.json()).toMatchObject({ already_resonated: true, charged_fish: 0, resonance_count: 1 });
  expect(await fishBalance(page)).toBe(0);
});

test('页面展示免费后收款资格恢复，先更新费用再由用户点击付费', async ({ page }) => {
  const author = await registerCoreUser(page);
  const content = `费用变化样本${uniqueTag()}`;
  await seedPastEdition({ daysAgo: 1, content, submitterId: author.id });
  await e2eDb().user.update({ where: { id: author.id }, data: { role: 'user' } });
  await registerCoreUser(page);
  expect((await page.request.post('/api/checkin')).status()).toBe(200);
  await page.goto('/checkin/quotes');
  const card = quoteCard(page, content);
  await expect(card.getByRole('button', { name: '共鸣', exact: true })).toBeVisible();
  await e2eDb().user.update({ where: { id: author.id }, data: { role: 'core' } });
  await card.getByRole('button', { name: '共鸣', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('共鸣费用已变化');
  expect(await fishBalance(page)).toBe(3);
  await expect(card.getByRole('button', { name: '共鸣，投喂 1 条鱼干', exact: true })).toBeEnabled();
  await resonateCard(card);
  expect(await fishBalance(page)).toBe(2);
});

test('签到弹窗、免费共鸣、私密收藏、当天回看与窄屏焦点', async ({ page }, info) => {
  await registerCoreUser(page);
  await page.goto('/checkin'); await page.getByRole('button', { name: /每日签到/ }).click();
  const dialog = page.getByRole('dialog', { name: '每日一言', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('blockquote')).toHaveText(classics[0].content);
  const rect = await dialog.boundingBox(); const viewport = page.viewportSize()!;
  expect(rect!.x).toBeGreaterThanOrEqual(15); expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width - 15);
  expect(rect!.height).toBeLessThanOrEqual(viewport.height - 30);
  await page.screenshot({ path: `tests/.tmp/daily-quote-${info.project.name}-light.png` });
  await dialog.getByRole('button', { name: '共鸣' }).click();
  // 按钮进终态：可见文案是「已共鸣」（不再有「今日」二字），且一生一次 ⇒ disabled
  await expect(dialog.getByRole('button', { name: '已共鸣', exact: true })).toBeDisabled();
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
  // 弹窗底栏只剩「去别处看」的两项：往期一言 / 一言集
  await expect(dialog.getByRole('link', { name: '往期一言', exact: true })).toBeVisible();
  await dialog.getByRole('link', { name: '每日一言', exact: true }).click();
  await page.getByRole('navigation', { name: '每日一言', exact: true }).getByRole('link', { name: '我的收藏', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的收藏', exact: true })).toBeVisible();
  await expect(page.locator('blockquote')).toHaveText(classics[0].content);
  await page.getByRole('button', { name: '已收藏', exact: true }).click();
  await expect(page.getByText('还没有收藏的一言。')).toBeVisible();
  await page.goto('/checkin'); await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看今日一言' })).toBeVisible();
});

test('弹窗投稿→管理员审核→匿名全额投喂与重复保护', async ({ page }, info) => {
  const author = await registerCoreUser(page);
  await page.goto('/checkin'); await page.getByRole('button', { name: /每日签到/ }).click();
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
  await publishBlog(page);
  await page.goto('/admin/daily-quotes');
  const row = page.locator('.daily-quote-panel').filter({ hasText: content });
  await expect(row).toBeVisible(); await row.getByRole('button', { name: '通过', exact: true }).click();
  await expect(row).toHaveCount(0);
  await edition(id);
  await registerCoreUser(page);
  await page.goto('/checkin'); await page.getByRole('button', { name: /每日签到/ }).click();
  await expect(dialog.locator('blockquote')).toHaveText(content);
  await expect(dialog.getByText('匿名 投稿')).toBeVisible();
  await expect(dialog).not.toContainText(author.username);
  // 付费档的按钮名里「投喂 1 条鱼干」中间有空格（aria-label 由 fee 常量拼出）
  await dialog.getByRole('button', { name: '共鸣，投喂 1 条鱼干' }).click();
  await expect(dialog.getByRole('button', { name: '已共鸣', exact: true })).toBeDisabled();
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(2);
  // 重复请求：200 + 幂等重放（不再扣鱼干、不再计人数）
  const repeat = await page.request.post(`/api/daily-quotes/${id}/resonance`, { data: { max_fish: 1 } });
  expect(repeat.status()).toBe(200);
  expect(await repeat.json()).toMatchObject({ already_resonated: true, resonated: true, can_resonate: false, resonance_count: 1 });
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(2);
  const ledger = (await (await page.request.get('/api/fish/transactions?type=quote_all')).json()).transactions;
  expect(ledger).toHaveLength(1); expect(ledger[0].amount).toBe(-1); expect(ledger[0].related_user_id).toBeNull();
  await loginViaApi(page, author.username);
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(4);
});

test('最近投稿可回填、取消与保存；拒稿修改后原稿重审，审核后的稿件不可覆盖', async ({ page }) => {
  async function openEditor(card: Locator) {
    // SSR 按钮可能先于水合出现；只重复「打开」这一单调操作，不重复保存请求。
    await expect(async () => {
      if (await card.getByRole('form', { name: '编辑一言投稿' }).count()) return;
      await card.getByRole('button', { name: '编辑投稿' }).click();
      await expect(card.getByRole('form', { name: '编辑一言投稿' })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  }
  await registerCoreUser(page);
  const content = `待编辑稿件${uniqueTag()}`;
  const created = await page.request.post('/api/daily-quotes/submissions', { data: {
    content, category: '哲思', signature: 'anonymous', source_type: 'quotation', source_name: '原作品出处',
  } });
  expect(created.status()).toBe(200);
  const { submission } = await created.json();
  await page.goto('/checkin/submissions');
  const row = page.locator('article.daily-quote-panel').filter({ hasText: content });
  await openEditor(row);
  // 正文在编辑时会变化，表单按固定名称定位，不能继续依赖卡片的旧正文。
  const form = page.getByRole('form', { name: '编辑一言投稿' });
  await expect(form.getByLabel('一言内容')).toHaveValue(content);
  await expect(form.locator('[name="category"]')).toHaveValue('哲思');
  await expect(form.locator('[name="signature"]')).toHaveValue('anonymous');
  await expect(form.locator('[name="source_type"]')).toHaveValue('quotation');
  await expect(form.getByLabel('原作者或出处')).toHaveValue('原作品出处');
  await form.getByLabel('一言内容').fill('取消时不应保存');
  await form.getByRole('button', { name: '取消编辑' }).click();
  await expect(row.getByRole('button', { name: '编辑投稿' })).toBeFocused();
  await expect(row.locator('.daily-quote-submission-text').first()).toHaveText(content);

  await openEditor(row);
  await expect(form.getByLabel('一言内容')).toHaveValue(content);
  const changed = `保存后的稿件${uniqueTag()}`;
  await form.getByLabel('一言内容').fill(changed);
  for (const [field, option] of [['类型', '励志'], ['署名方式', '昵称'], ['来源', '原创']]) {
    await form.getByRole('button', { name: field, exact: true }).click();
    await form.getByRole('option', { name: option, exact: true }).click();
  }
  await form.getByRole('button', { name: '保存修改' }).click();
  const changedRow = page.locator('article.daily-quote-panel').filter({ hasText: changed });
  await expect(changedRow.getByRole('status')).toHaveText('修改已保存，等待管理员审核。');
  const saved = (await (await page.request.get('/api/daily-quotes/submissions')).json()).submissions;
  expect(saved).toEqual([expect.objectContaining({
    id: submission.id, content: changed, category: '励志', signature: 'nickname', source_type: 'original', source_name: null, status: 'pending',
  })]);
  await expectNoHorizontalScroll(page);

  // 直接构造拒稿状态；审核接口及审计日志的成功路径由本文件上一个用例覆盖。
  await e2eDb().dailyQuote.update({ where: { id: submission.id }, data: { status: 'rejected', reviewReason: '请补正出处' } });
  await e2eDb().dailyQuoteRevision.updateMany({ where: { quoteId: submission.id, revision: saved[0].version }, data: { status: 'rejected', reviewReason: '请补正出处' } });
  await page.reload();
  await openEditor(changedRow);
  const revised = changed;
  await form.getByRole('button', { name: '来源', exact: true }).click();
  await form.getByRole('option', { name: '引用', exact: true }).click();
  await form.getByLabel('原作者或出处').fill('补正后的出处');
  await form.getByRole('button', { name: '修改并重新提交' }).click();
  const revisedRow = page.locator('article.daily-quote-panel').filter({ hasText: revised });
  await expect(revisedRow).toContainText('待审核');
  const submissions = (await (await page.request.get('/api/daily-quotes/submissions')).json()).submissions;
  const revisedId = submissions.find((item: { content: string }) => item.content === revised).id;
  expect(revisedId).toBe(submission.id);
  await revisedRow.getByText('稿件与审核历史', { exact: true }).click();
  await expect(revisedRow).toContainText('审核说明：请补正出处');
  expect(submissions).toHaveLength(1);

  await openEditor(revisedRow);
  await form.getByLabel('一言内容').fill('审核后不能替换正文');
  await e2eDb().dailyQuote.update({ where: { id: revisedId }, data: { status: 'approved' } });
  await form.getByRole('button', { name: '保存修改' }).click();
  await expect(form.getByRole('alert')).toContainText('稿件已通过审核或已下架，不能编辑');
  await page.reload();
  await expect(revisedRow.getByRole('button', { name: '编辑投稿' })).toHaveCount(0);
  await expect(revisedRow).toContainText('已通过');
  await expect(revisedRow.locator(':scope > .daily-quote-submission-text')).toHaveText(revised);
});

test('一言加载失败可单独重试，签到奖励已到账', async ({ page }) => {
  await registerCoreUser(page);
  await page.route('**/api/daily-quotes/today', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 503, message: '一言加载测试失败' }) }));
  await page.goto('/checkin'); await page.getByRole('button', { name: /每日签到/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toHaveText('一言加载测试失败');
  expect((await (await page.request.get('/api/fish/balance')).json()).balance).toBe(3);
  await expect(page.locator('.checkin-button')).toContainText('+3');
  await page.unroute('**/api/daily-quotes/today');
  await dialog.getByRole('button', { name: '重新加载' }).click();
  await expect(dialog.locator('blockquote')).toHaveText(classics[0].content);
});

// 弹窗的盒子高度会变两次以上：占位 → 正片（高得多），点「我也要投稿」换成表单，
// 共鸣/收藏成功后卡片下方多一行反馈。**窄屏必须钉住上沿**：中心固定的话，每次高度
// 变化都会把整个盒子上下各挪半个高度差（390×664 实测 130px），手机上网络慢、占位帧
// 停留得久，用户看到的就是「弹窗突然移动又弹回来」。这里用延迟响应把占位帧固定下来，
// 直接量两次的上沿。
test('窄屏弹窗上沿固定、遮罩是平铺色', async ({ page, isMobile }) => {
  await registerCoreUser(page);
  await page.route('**/api/daily-quotes/today', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto('/checkin'); await page.getByRole('button', { name: /每日签到/ }).click();
  const dialog = page.getByRole('dialog', { name: '每日一言', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText('正在打开今日一言…');
  const placeholder = (await dialog.boundingBox())!;
  await expect(dialog.locator('blockquote')).toBeVisible();
  const loaded = (await dialog.boundingBox())!;

  // 遮罩走 §3.6 的平铺令牌；全屏 backdrop-filter 在手机上既白烧 GPU，又是
  // 「打开瞬间整块弹窗被合成到错误偏移」那类闪动的来源。
  const backdrop = await dialog.evaluate((el) => {
    const style = getComputedStyle(el, '::backdrop');
    return { background: style.backgroundColor, filter: style.backdropFilter };
  });
  expect(backdrop.background).toBe('rgba(0, 0, 0, 0.5)');
  expect(backdrop.filter).toBe('none');

  if (isMobile) {
    // 上沿不动、只向下长 —— 这是本条用例的全部意义
    expect(loaded.y).toBeCloseTo(placeholder.y, 0);
    expect(loaded.height).toBeGreaterThan(placeholder.height);
    expect(loaded.y).toBeLessThan(30);
  }
  await page.unroute('**/api/daily-quotes/today');
});

// 签到成功的粒子环是按钮外的伪元素、再 scale 到 3×：手机上传出视口，整页会多一块
// 横向可滚区域（修复前 390 宽的手机上 scrollWidth 到 539）。手机上页面能横着滚，
// 手势/焦点就可能把视口横拖一段、动画结束溢出消失再被夹回 0 —— 表现是「整页连
// 固定层突然右移半屏又弹回来」。这里按帧采样整段动画，只守「文档不许被撑宽」。
test('签到粒子动画期间整页不出现横向滚动', async ({ page }) => {
  await registerCoreUser(page);
  await page.goto('/checkin');
  await page.getByRole('button', { name: /每日签到/ }).click();
  const widest = await page.evaluate(async () => {
    const doc = document.documentElement;
    let max = doc.scrollWidth;
    const until = performance.now() + 900;
    while (performance.now() < until) {
      max = Math.max(max, doc.scrollWidth);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    return { max, client: doc.clientWidth };
  });
  expect(widest.max).toBeLessThanOrEqual(widest.client);
});

// ── 往期一言（H1 / H2 / H4 / H5 / S2） ──────────────────────────────────────
//
// 往期是**纯读**入口：不要求今天签到、也不替过去补抽。「那天有没有一言」只看
// daily_quote_editions；正文与审核状态只看 daily_quotes。下面每条都从真实浏览器入口
// 进去操作，而不是只断言按钮存在。

test('未签到也能回看往期，今日接口仍 403（H1）', async ({ page }) => {
  const classic = classics[1];
  const community = `往期站友投稿${uniqueTag()}`;
  const { day: day1 } = await seedPastEdition({ daysAgo: 1, classicIndex: 1 });
  const { day: day2 } = await seedPastEdition({ daysAgo: 2, content: community, submitterId: SEED_USERS.core.id });
  // 这个 core 已有博客，但没有当天签到
  await registerCoreUser(page);

  await page.goto('/checkin');
  // 有博客的 core 未签到也能使用三个相关入口
  const nav = page.locator('.daily-quote-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link')).toHaveCount(3);
  // 今日内容仍要签到后才给看 —— 往期不是绕过签到的旁路
  expect((await page.request.get('/api/daily-quotes/today')).status()).toBe(403);

  await nav.getByRole('link', { name: '往期一言', exact: true }).click();
  await expect(page.getByRole('heading', { name: '往期一言', exact: true })).toBeVisible();
  const cards = page.locator('.daily-quote-list > article');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('.daily-quote-card__date')).toHaveText(day1);
  await expect(cards.nth(1).locator('.daily-quote-card__date')).toHaveText(day2);
  await expect(page.locator('.daily-quote-list')).toContainText(classic.content);
  await expect(page.locator('.daily-quote-list')).toContainText(community);
  await expect(cards.nth(1)).toContainText('站友投稿');
  await expect(cards.nth(1)).toContainText('e2e_core 投稿');
  // 今天那一期（签到弹窗里的 classics[0]）不出现在往期列表
  await expect(page.locator('.daily-quote-list')).not.toContainText(classics[0].content);

  // 接口与页面同源：只回过去日期，今天被排除在外
  const history = await historyApi(page);
  expect(history.total).toBe(2);
  expect(history.editions.map((row) => row.day)).toEqual([day1, day2]);
  expect(history.editions.some((row) => row.day === todayStr())).toBe(false);
});

test('往期条目上共鸣 + 收藏：跨页一致、重复请求幂等（H2 / R1 / U1）', async ({ page }) => {
  const content = `往期投稿${uniqueTag()}`;
  const { day, quoteId } = await seedPastEdition({ daysAgo: 1, content, submitterId: SEED_USERS.core.id });
  await registerCoreUser(page);
  await publishBlog(page);
  const checkin = await page.request.post('/api/checkin');
  expect(checkin.status()).toBe(200);
  expect((await checkin.json()).code).toBe(200);
  expect(await fishBalance(page)).toBe(3);

  // 从**签到弹窗底栏**那颗「往期一言」进历史页 —— 这是新加的入口，顺带证明它真通这里
  await page.goto('/checkin');
  await page.getByRole('button', { name: '查看今日一言' }).click();
  const dialog = page.getByRole('dialog', { name: '每日一言', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('link', { name: '往期一言', exact: true }).click();
  await expect(page.getByRole('heading', { name: '往期一言', exact: true })).toBeVisible();

  const card = quoteCard(page, content);
  await expect(card).toHaveCount(1);
  await expect(card.locator('.daily-quote-card__date')).toHaveText(day);
  await expect(card).toContainText('站友投稿');
  await expect(card).toContainText('e2e_core 投稿');
  // 付费档的费用贴着操作行给出（不常驻长段规则）
  await expect(card.getByText('投喂 1 条鱼干', { exact: true })).toBeVisible();

  await resonateCard(card);
  await expect(card.getByRole('status')).toHaveText('已共鸣，已向投稿人投喂 1 条鱼干');
  await expect(card.locator('.daily-quote-card__count')).toHaveText('1');
  await expect(card.getByRole('button', { name: '已共鸣', exact: true })).toBeDisabled();
  await expect(card.getByText('每人每句限一次', { exact: true })).toHaveCount(0);
  expect(await fishBalance(page)).toBe(2);

  await favoriteCard(card);
  await expect(card.getByRole('status')).toHaveText('已收藏');

  // 页面状态 == 服务端真值（同一个批量组装器），别只信 DOM
  const history = await historyApi(page);
  expect(history.editions.find((row) => row.day === day)?.quote).toMatchObject({
    id: quoteId,
    resonated: true,
    favorited: true,
    resonance_count: 1,
    can_resonate: false,
  });

  // 一言集是另一个入口：状态要一致，日期是收藏时间，选登日期另行说明
  await page.goto('/quotes/saved');
  await expect(page.getByRole('heading', { name: '我的收藏', exact: true })).toBeVisible();
  const saved = quoteCard(page, content);
  await expect(saved.locator('.daily-quote-card__date')).toHaveText(`收藏于 ${todayStr()}`);
  await expect(saved.getByRole('button', { name: '已共鸣', exact: true })).toHaveCount(1);
  await expect(saved.getByRole('button', { name: '已收藏', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // 幂等：同一句再请求一次 —— 不重复扣鱼干、不重复计人数，回权威结果
  const replayResponse = await page.request.post(`/api/daily-quotes/${quoteId}/resonance`, { data: { max_fish: 1 } });
  expect(replayResponse.status()).toBe(200);
  expect(await replayResponse.json()).toMatchObject({
    already_resonated: true,
    resonated: true,
    can_resonate: false,
    resonance_count: 1,
    balance: 2,
  });
  expect(await fishBalance(page)).toBe(2);
  const ledger = (await (await page.request.get('/api/fish/transactions?type=quote_all')).json()).transactions;
  expect(ledger).toHaveLength(1);
  expect(ledger[0].amount).toBe(-1);
});

test('同一句两个入选日期：两条同时存在，操作一条另一条同步（H5 / U1）', async ({ page }) => {
  const classic = classics[3];
  // 90 天不重复是**选句**的规则，不是历史的约束：同一句可以在两个日期各入选一次
  const { day: day1 } = await seedPastEdition({ daysAgo: 1, classicIndex: 3 });
  const { day: day2 } = await seedPastEdition({ daysAgo: 2, classicIndex: 3 });
  await registerCoreUser(page);

  await page.goto('/checkin/quotes');
  const cards = page.locator('.daily-quote-list > article');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator('.daily-quote-card__date')).toHaveText(day1);
  await expect(cards.nth(1).locator('.daily-quote-card__date')).toHaveText(day2);
  await expect(cards.nth(0)).toContainText(classic.content);
  await expect(cards.nth(1)).toContainText(classic.content);
  await expect(cards.nth(0).getByText('免费', { exact: true })).toHaveCount(0);

  await resonateCard(cards.nth(0));
  // 互动状态按 quoteId 共享：另一张卡**不用刷新**就跟着变成已共鸣
  await expect(cards.nth(0).getByRole('button', { name: '已共鸣', exact: true })).toHaveCount(1);
  await expect(cards.nth(1).getByRole('button', { name: '已共鸣', exact: true })).toHaveCount(1);
  await expect(cards.nth(1).getByRole('button', { name: '已共鸣', exact: true })).toBeDisabled();

  // 人数是**全站真值**，不写死 1：同一个库会被 desktop 与 mobile 两遍各共鸣一次。
  // 这里要钉的是「两条卡显示同一个数，且等于服务端的人数」。
  const history = await historyApi(page);
  expect(history.editions.map((row) => row.day)).toEqual([day1, day2]);
  expect(history.editions.every((row) => row.quote?.resonated === true)).toBe(true);
  const serverCount = history.editions[0].quote?.resonance_count ?? 0;
  expect(serverCount).toBeGreaterThanOrEqual(1);
  await expect(cards.nth(0).locator('.daily-quote-card__count')).toHaveText(String(serverCount));
  await expect(cards.nth(1).locator('.daily-quote-card__count')).toHaveText(String(serverCount));
});

test('下架条目：日期仍在、正文不可见、不能共鸣、仍可移出收藏（S2）', async ({ page }) => {
  const classic = classics[5];
  const { day } = await seedPastEdition({ daysAgo: 1, classicIndex: 5 });
  await registerCoreUser(page);

  // 先在店里收藏（下架后仍要能从一言集里移掉，否则私密分类留下清不掉的条目）
  await page.goto('/checkin/quotes');
  const card = quoteCard(page, classic.content);
  await expect(card).toHaveCount(1);
  await favoriteCard(card);

  // 下架 = 审核状态改判（作者归档同理）：读口把正文变成 null，但**日期必须留着**
  statusRestores.push({ id: classic.id, status: 'approved' });
  await e2eDb().dailyQuote.update({ where: { id: classic.id }, data: { status: 'retired' } });
  // 不是「页面上藏了按钮」：接口同样拒绝共鸣
  expect((await page.request.post(`/api/daily-quotes/${classic.id}/resonance`, { data: { max_fish: 1 } })).status()).toBe(404);

  await page.goto('/checkin/quotes');
  const after = page.locator('.daily-quote-list > article');
  await expect(after).toHaveCount(1);
  await expect(after.first().locator('.daily-quote-card__date')).toHaveText(day);
  await expect(after.first()).toContainText('该日内容已不可用');
  await expect(page.locator('.daily-quote-list')).not.toContainText(classic.content);
  await expect(page.locator('.daily-quote-list').getByRole('button')).toHaveCount(0);

  // 一言集：占位 + 收藏日期 + 移出按钮
  await page.goto('/favorite/quotes');
  await expect(page.getByText('这句一言已下架。')).toBeVisible();
  await expect(page.getByText(`收藏于 ${todayStr()}`)).toBeVisible();
  const remove = page.getByRole('button', { name: '取消收藏' });
  await expect(async () => {
    if (!(await remove.count())) return;
    await remove.click();
    await expect(page.getByText('这句一言已下架。')).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByText('还没有收藏的一言。')).toBeVisible();
});

test('往期分页：每页 20 条、可翻页、越界页码收敛到末页（H4）', async ({ page }) => {
  // 21 条 → 2 页（1..20 与 21）。用不同经典 id，避免同一句在两个日期上的状态串台。
  const editions = Array.from({ length: 21 }, (_, index) => ({
    day: pastDay(index + 1),
    quoteId: classics[100 + index].id,
    createdAt: nowForDb(),
  }));
  await e2eDb().dailyQuoteEdition.createMany({ data: editions });
  await registerCoreUser(page);

  await page.goto('/checkin/quotes');
  const cards = page.locator('.daily-quote-list > article');
  await expect(cards).toHaveCount(20);
  await expect(cards.first().locator('.daily-quote-card__date')).toHaveText(pastDay(1));
  const pager = page.locator('nav.pagination');
  await expect(pager).toBeVisible();
  await expect(pager.locator('a[aria-current="page"]')).toHaveText('1');

  await pager.getByRole('link', { name: '下一页' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(cards).toHaveCount(1);
  await expect(cards.first().locator('.daily-quote-card__date')).toHaveText(pastDay(21));
  await expect(pager.locator('a[aria-current="page"]')).toHaveText('2');

  // 越界页码收敛到有效末页（不是空列表、也不是 500）
  await page.goto('/checkin/quotes?page=999');
  await expect(page.locator('.daily-quote-list > article')).toHaveCount(1);
  await expect(page.locator('nav.pagination a[aria-current="page"]')).toHaveText('2');

  // 非法页码退回第一页
  await page.goto('/checkin/quotes?page=abc');
  await expect(page.locator('.daily-quote-list > article')).toHaveCount(20);
  await expect(page.locator('nav.pagination a[aria-current="page"]')).toHaveText('1');
});

test('往期页在桌面与窄屏都不横向溢出，卡片按钮可点', async ({ page }) => {
  const { day } = await seedPastEdition({ daysAgo: 1, classicIndex: 4 });
  await seedPastEdition({ daysAgo: 2, content: `往期几何样本${uniqueTag()}`, submitterId: SEED_USERS.core.id });
  await registerCoreUser(page);

  await page.goto('/checkin/quotes');
  const cards = page.locator('.daily-quote-list > article');
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator('.daily-quote-card__date')).toHaveText(day);
  await expectNoHorizontalScroll(page);

  // 几何不能只看数字：操作行真的点得动（费用文案换行后不许盖住按钮）
  const classicCard = quoteCard(page, classics[4].content);
  await favoriteCard(classicCard);
  await expect(classicCard.getByRole('button', { name: '已收藏', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectNoHorizontalScroll(page);
});
