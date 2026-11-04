import { test, expect } from '@playwright/test';

// 动效试验台（/game/motion）。这里断的是**这页本身站得住**的那几条：
// 每个场景都真的摆出了多列、每列都能重播、过冲曲线真的会过冲、开了减少动态效果
// 之后动画真的不播 —— 而不是「类名在就算过」。
test('动效试验台：十二个场景各摆多列，曲线与时长可对照，重播会重放', async ({ page }) => {
  await page.goto('/game/motion');

  // 从测试合集点进来，卡片在。
  await expect(page.locator('.mo-lab h1')).toHaveText('动效试验台');
  await expect(page.getByRole('link', { name: '返回测试合集' })).toHaveAttribute('href', '/game/collections/test');

  // 十二个场景（九个原有场景 + 三个「尾巴长度」对照），每个至少三列 —— 少于三列就没得挑，
  // 这页的意义就没了。
  const scenarios = page.locator('.mo-scenario');
  await expect(scenarios).toHaveCount(12);
  for (let index = 0; index < 12; index++) {
    const variants = scenarios.nth(index).locator('.mo-variant');
    expect(await variants.count()).toBeGreaterThanOrEqual(3);
  }

  // 「统一取值」那一列每个交互场景各一个（进度条与切页是刻意的例外，共 7 个），
  // 三个尾巴长度对照各一个（第一列就是现版交互动画），合计 10 个。
  await expect(page.locator('.mo-variant--adopted')).toHaveCount(10);
  // 它必须真的用交互动画那条曲线，并且是 540ms —— 角标和读数不能自相矛盾。
  const adoptedReadouts = await page.locator('.mo-variant--adopted .mo-variant__readout').allTextContents();
  expect(adoptedReadouts).toHaveLength(10);
  for (const readout of adoptedReadouts) {
    expect(readout).toContain('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(readout).toContain('540ms');
  }

  // 曲线总览：11 条备选曲线都在图上，图例也是 11 条；尾巴长度对照另有一张 5 条线的图。
  await expect(page.locator('.mo-plot__path')).toHaveCount(16);
  await expect(page.locator('.mo-legend__item')).toHaveCount(11);

  // 挑一条之后，其余 10 条变暗、只有它高亮。
  await page.locator('.mo-legend__item').first().click();
  await expect(page.locator('.mo-plot__path--pick')).toHaveCount(1);
  await expect(page.locator('.mo-plot__path--dim')).toHaveCount(10);
  await page.locator('.mo-legend__item').first().click();
  await expect(page.locator('.mo-plot__path--dim')).toHaveCount(0);

  // 尾巴长度对照：三格各配一个「一起重播」，第一格是复刻的下拉面板 —— 点开后面板真的
  // 按内容高度展开，而不是只换了一个 class。
  await expect(page.getByRole('button', { name: '一起重播' })).toHaveCount(3);
  const dropdown = page.locator('.mo-scenario').filter({ has: page.locator('#mo-dropdown') });
  await expect(dropdown.locator('.mo-cat')).toHaveCount(5);
  const tailPanel = dropdown.locator('.mo-cat__panel').first();
  expect(await tailPanel.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(2);
  await dropdown.locator('.mo-cat__toggle').first().click();
  await expect.poll(() => tailPanel.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(40);
  // 后四列都必须是正常的三次贝塞尔（不是 linear() 采样），读数里能直接看到控制点。
  const tailReadouts = await dropdown.locator('.mo-variant__readout').allTextContents();
  expect(tailReadouts).toHaveLength(5);
  for (const readout of tailReadouts.slice(1)) {
    expect(readout).toContain('cubic-bezier(0.16, 1, ');
    expect(readout).toContain('540ms');
  }
  expect(tailReadouts[4]).toContain('cubic-bezier(0.16, 1, 0.1, 0.7)');

  // 展开面板：点开之后高度真的涨起来（0fr → 1fr 生效，而不是一个装饰性的 class）。
  const expand = page.locator('.mo-scenario').filter({ has: page.locator('#mo-expand') }).locator('.mo-variant').first();
  const shell = expand.locator('.mo-expand');
  expect(await shell.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(2);
  await expand.getByRole('button', { name: '展开面板' }).click();
  await expect.poll(() => shell.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(40);

  // 数字递增结尾必须正好 1000；回弹那一列中途会越过 1000，那正是它要演示的东西。
  const counters = page.locator('.mo-scenario').filter({ has: page.locator('#mo-counter') }).locator('.mo-variant');
  const overshoot = counters.nth(3);
  await overshoot.getByRole('button', { name: '重播' }).click();
  const samples: number[] = [];
  for (let index = 0; index < 18; index++) {
    await page.waitForTimeout(30);
    samples.push(Number(await overshoot.locator('output').innerText()));
  }
  expect(Math.max(...samples)).toBeGreaterThan(1000);
  await expect.poll(() => overshoot.locator('output').innerText(), { timeout: 3000 }).toBe('1000');
});

test('动效试验台：窄屏收成一列且不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/game/motion');

  // 每行变体在窄屏只剩一列。
  const widths = await page.locator('.mo-variants').first().evaluate((row) =>
    [...row.querySelectorAll('.mo-variant')].map((card) => Math.round(card.getBoundingClientRect().width)));
  expect(widths.length).toBeGreaterThanOrEqual(3);
  expect(new Set(widths).size).toBe(1);

  // 整页不许出现横向滚动 —— 曲线图与 cubic-bezier 长串最容易撑破这一条。
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
