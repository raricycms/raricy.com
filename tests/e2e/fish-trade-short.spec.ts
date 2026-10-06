// 空头的确认屏、自由杠杆输入与真实到账。用例自己覆盖三档视口，
// 不再放进 RESPONSIVE_SPECS 重跑同样的几何。
// 展示报价可控，成交仍走本地行情替身：弹窗估算必须与最终流水一致。
import { test, expect } from '@playwright/test';
import { registerFreshUser, publishBlog } from './helpers';

const MARKET_MOCK = 'http://127.0.0.1:3102';

for (const width of [320, 390, 1280]) {
  test(`空头平仓：自由输入、确认方向与到账一致（${width}px）`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await registerFreshUser(page, { core: true });
    await publishBlog(page);
    expect((await page.request.post('/api/checkin', { data: {} })).status()).toBe(200);

    const setPrice = async (price: number) => {
      const res = await request.post(`${MARKET_MOCK}/__e2e__/set-price?symbol=BTCUSDT&price=${price}`);
      expect(res.status(), await res.text()).toBe(200);
    };
    await setPrice(80000);
    let displayPrice = 80000;
    await page.route('**/api/fish/trade/quote', (route) => route.fulfill({
      json: {
        code: 200,
        ok: true,
        quotes: [
          { symbol: 'BTCUSDT', display: 'BTC', price: displayPrice, change_percent: 0, stale: false, source: 'poll' },
          { symbol: 'ETHUSDT', display: 'ETH', price: 3000, change_percent: 0, stale: false, source: 'poll' },
        ],
      },
    }));
    await page.goto('/fish/trade');
    await page.getByRole('button', { name: '做空', exact: true }).click();
    await page.locator('#trade-amount').fill('1');

    const input = page.locator('.trade-leverage__input');
    for (const invalid of ['', '0', '101', '1.5', '1e2']) {
      await input.fill(invalid);
      await expect(page.locator('.trade-submit'), `非法杠杆 ${JSON.stringify(invalid)} 不可提交`).toBeDisabled();
    }
    await input.fill('37');
    await expect(page.locator('.trade-submit')).toBeEnabled();

    // 新增的自由输入框与单位说明必须在视口内，窄屏不能挤掉数字或撑宽整页。
    const geometry = await page.evaluate(() => {
      const input = document.querySelector('.trade-leverage__input')!.getBoundingClientRect();
      const label = document.querySelector('.trade-leverage__unit')!.getBoundingClientRect();
      return { inputWidth: input.width, right: label.right, scrollWidth: document.documentElement.scrollWidth, width: innerWidth };
    });
    expect(geometry.inputWidth).toBeGreaterThan(35);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);

    await page.locator('.trade-submit').click();
    const openConfirm = page.getByRole('dialog', { name: '确认做空', exact: true });
    await expect(openConfirm.locator('.modal-title')).toHaveText('确认做空');
    await openConfirm.getByRole('button', { name: '确认做空', exact: true }).click();
    await expect(openConfirm).toHaveCount(0);
    await expect(page.locator('.trade-position__dir')).toHaveText('空');
    await expect(page.locator('.trade-position__lev')).toHaveText('37×');

    // 投 1 条，37× 空头跌 1%：毛额 1.37，扣费与 floor 后实得 1.3626。
    displayPrice = 79200;
    await setPrice(displayPrice);
    await expect(page.locator('.trade-position__profit')).toContainText('+0.3626');
    await page.locator('.trade-position__sell').click();
    const closeConfirm = page.getByRole('dialog', { name: '确认平空', exact: true });
    await expect(closeConfirm.locator('.modal-title')).toHaveText('确认平空');
    await expect(closeConfirm.locator('.trade-confirm__row').filter({
      has: page.locator('dt', { hasText: '平仓毛额' }),
    })).toContainText('1.3700');
    await expect(closeConfirm.locator('.trade-confirm__row').filter({
      has: page.locator('dt', { hasText: '预计到手' }),
    })).toContainText('1.3626');
    await closeConfirm.getByRole('button', { name: '确认平空', exact: true }).click();
    await expect(page.locator('.trade-position')).toHaveCount(0);
    await expect(page.locator('.trade-card__balance-number')).toHaveText('3.3626');
    await expect(page.locator('.trade-settled__dir')).toHaveText('空');
    await expect(page.locator('.trade-settled__tag')).toHaveText('平空');

    const res = await page.request.get('/api/fish/transactions?type=market_all');
    expect(res.status(), await res.text()).toBe(200);
    const ledger = await res.json();
    expect(ledger.transactions.find((t: { type: string }) => t.type === 'market_sell'))
      .toMatchObject({ amount: 1.3626, description: expect.stringContaining('平空') });
  });
}
