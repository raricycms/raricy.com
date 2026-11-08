import { test, expect, type Page } from '@playwright/test';
import { LEVELS } from '../../src/games/lumen2/levels';

async function open(page: Page) {
  await page.goto('/game/lumen2');
  await expect(page.getByRole('button', { name: '选关', exact: true })).toBeEnabled();
}
async function select(page: Page, id: string) {
  await page.getByRole('button', { name: '选关', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`第 ${id} 关`) }).click();
  await expect(page.locator('.l2-board')).toHaveAttribute('data-level', id);
}
const tool = (page: Page, value: number) => page.getByRole('button', { name: value === 1 ? '放置 / 镜片' : '放置 \\ 镜片', exact: true });

test('键盘摆放、库存限制、撤销重做、刷新续玩与已解记录', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const socket = page.getByRole('button', { name: 'B3，空位', exact: true });
  await socket.focus(); await page.keyboard.press('Space');
  await expect(page.getByTestId('lumen2-stock')).toHaveText('0 / 1');
  await page.getByRole('button', { name: 'C3，空位', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('镜片已用完');
  // Touch does not necessarily leave focus on a button. Shortcuts intentionally
  // apply only while a game control has keyboard focus.
  await page.getByRole('button', { name: 'C3，空位', exact: true }).focus();
  await page.keyboard.press('z');
  await expect(page.getByTestId('lumen2-stock')).toHaveText('1 / 1');
  await page.keyboard.press('y');
  await expect(page.getByRole('button', { name: 'B3，/ 镜片', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'B3，/ 镜片', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'B3，/ 镜片', exact: true }).click();
  await page.getByRole('button', { name: 'C3，空位', exact: true }).click();
  await expect(page.locator('.l2-board')).toHaveAttribute('data-solved', 'true');
  await page.getByRole('button', { name: '撤销', exact: false }).click();
  await expect(page.locator('.l2-board')).toHaveAttribute('data-solved', 'false');
  await page.getByRole('button', { name: '重做', exact: false }).click();
  await expect(page.locator('.l2-board')).toHaveAttribute('data-solved', 'true');
  await page.reload();
  await expect(page.locator('.l2-board')).toHaveAttribute('data-solved', 'true');
  await expect(page.locator('.l2-completion')).toContainText('1 / 12');
  expect(errors).toEqual([]);
});

test('线索逐层展开，对话框焦点恢复', async ({ page }) => {
  await open(page); await select(page, '12');
  for (const hint of LEVELS[11].hints) {
    await page.getByRole('button', { name: /展开第一条|再展开一条/ }).click();
    await expect(page.locator('.l2-hints')).toContainText(hint);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // 弹窗的焦点返回在手机视口验证，覆盖原有移动端检查。
  await page.getByRole('button', { name: '玩法说明' }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '玩法说明' })).toBeFocused();
  await page.getByRole('button', { name: '选关', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '选关', exact: true })).toBeFocused();
});

test('禁用存储不影响游玩，收回工具在触屏同样可用', async ({ page, isMobile }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
  });
  await open(page);
  await expect(page.locator('.l2-save-note')).toContainText('未允许存档');
  async function activate(name: string) {
    const button = page.getByRole('button', { name, exact: true });
    if (isMobile) await button.tap(); else await button.click();
  }
  await activate('C3，空位');
  await expect(page.locator('.l2-board')).toHaveAttribute('data-solved', 'true');
  await activate('收回镜片');
  await activate('C3，/ 镜片');
  await expect(page.locator('.l2-board')).toHaveAttribute('data-solved', 'false');
});
