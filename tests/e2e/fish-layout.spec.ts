import {test,expect} from '@playwright/test';
import {loginViaApi} from './helpers';
import {SEED_USERS} from './seed';
test('账户操作可达、宽窄屏不溢出，练手盘子页不占账户入口',async({page})=>{
  await loginViaApi(page,SEED_USERS.core.username);
  await page.goto('/fish');
  for(const [label,href] of [['转账','/fish/transfer'],['流水','/fish/transactions'],['商城','/fish/shop']]) {
    const link=page.getByRole('link',{name:label,exact:true});
    await expect(link).toHaveAttribute('href',href);
    await expect(link).toBeVisible();
  }
  await expect(page.getByRole('button',{name:'收款码',exact:true})).toBeVisible();
  await expect(page.locator('a[href="/fish/trade"]')).toHaveCount(1);
  await expect(page.locator('a[href="/fish/trade/stats"]')).toHaveCount(0);
  await expect(page.locator('a[href="/fish/trade/history"]')).toHaveCount(0);
  const vw=page.viewportSize()!.width;
  for(const box of await page.locator('.fish-card__actions > *').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,scroll:el.scrollWidth,width:r.width};}))) {
    expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(vw);expect(box.height).toBeGreaterThanOrEqual(44);expect(box.scroll).toBeLessThanOrEqual(box.width+1);
  }
});
test('旧市场保留任务选择，旧商品锚点到商城',async({page})=>{
  await loginViaApi(page,SEED_USERS.core.username);
  await page.goto('/fish/market');
  await expect(page.getByRole('link',{name:'转账',exact:true})).toHaveAttribute('href','/fish/transfer');
  await page.goto('/fish/market#shop');
  await expect(page).toHaveURL(/\/fish\/shop#shop$/);
  await expect(page.locator('h1')).toHaveText('鱼干商城');
});
test('练手盘记录与统计保留内部导航和返回入口',async({page})=>{
  await loginViaApi(page,SEED_USERS.core.username);
  for(const route of ['/fish/trade/history','/fish/trade/stats']) {
    await page.goto(route);
    const nav=page.getByRole('navigation',{name:'练手盘',exact:true});
    await expect(nav.locator('a, [aria-current]')).toHaveCount(3);
    const parent=route.endsWith('history')?'/fish':'/fish/trade';
    await expect(page.locator(`a[href="${parent}"]`).last()).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
});
