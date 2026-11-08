import {test,expect} from '@playwright/test';
import {loginViaApi} from './helpers';
import {SEED_USERS} from './seed';
// 鱼干账户与练手盘的**导航可达性**。版式（操作区不溢出、按钮 44px 高、替身卡片的
// 排布）属于外观，按仓库纪律不在测试里固定 —— 由受影响页面与视口的实际检查负责。
test('账户操作入口可达，练手盘子页不占账户入口',async({page})=>{
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
  }
});
