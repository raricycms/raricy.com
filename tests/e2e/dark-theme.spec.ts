import { test, expect, type Page } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_LOGS, SEED_USERS } from './seed';

// 深色主题下的配色回归。
//
// 【为什么是 E2E】这类 bug 后端用例一点都碰不到：页面 200、DOM 结构对、类名也在，
// 只有把浏览器切到暗色、再去读**落定后的计算样式**才看得见。历史上有两类反复出现：
//   · 组件用了主题体系里并不存在的旧变量（--surface / --ink / --box-bg …），
//     fallback 永远是浅色值 —— 暗色下白底黑字；
//   · 暗色覆盖压根不命中（body.dark-mode 这类选择器）或特异性不足（棋子被刷成灰色）。
//
// 断言的是**语义**（暗色表面应当暗、棋子色应当区别于空格子），不是具体色值 ——
// 换配色时这些用例不该跟着改。

/** 把站点预置成暗色（写 localStorage，防闪烁脚本会在首帧前应用）。 */
async function useDarkTheme(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('theme', 'dark');
    } catch {
      /* noop */
    }
  });
}

/** 计算样式的亮度（0–255）；透明色视为 0。 */
function luminance(color: string): number {
  const nums = color.match(/[\d.]+/g)?.map(Number) ?? [];
  if (nums.length === 0) return NaN;
  const [r, g, b] = nums;
  if (nums.length > 3 && nums[3] === 0) return 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

test.describe('深色主题配色', () => {
  test('申诉详情：「暂无申诉」条目不是浅底', async ({ page }) => {
    await useDarkTheme(page);
    await loginViaApi(page, SEED_USERS.core.username);
    await page.goto(`/audit/${SEED_LOGS.desktop.id}`);

    const item = page.locator('.list-group-item').first();
    await expect(item).toHaveText('暂无申诉');

    // 旧变量 --box-bg 不存在时 fallback 是纯白 —— 这条断言正是冲着它来的
    const bg = await item.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(luminance(bg), `条目底色 ${bg} 仍是浅色`).toBeLessThan(128);

    // 文字要能在暗底上读：必须是浅色
    const color = await item.evaluate((el) => getComputedStyle(el).color);
    expect(luminance(color), `条目文字色 ${color} 太暗`).toBeGreaterThan(128);
  });

  test('立方棋：暗色下红蓝棋子与空格子底色不同', async ({ page }) => {
    await useDarkTheme(page);
    await page.goto('/game/cubetictactoe');

    // 落一子（组件是本地双人，红方先手）
    await page.locator('.cubettt-cube').first().dispatchEvent('click');
    await expect(page.locator('.cubettt-cube--red')).toHaveCount(1);

    const faceBg = (sel: string) =>
      page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);

    // .cubettt-face 上有 background-color 的 0.2s 过渡：落子瞬间读到的是起始色，
    // 必须等它落定再断言（否则用例时快时慢地"测出"回归）。
    await expect
      .poll(async () => {
        const [red, empty] = await Promise.all([
          faceBg('.cubettt-cube--red .cubettt-face'),
          faceBg('.cubettt-cube--empty .cubettt-face'),
        ]);
        return red !== empty;
      })
      .toBe(true);

    // 回归点：暗色规则曾把红蓝棋子一并刷成空格子的灰，棋子看起来"消失"
    const red = await faceBg('.cubettt-cube--red .cubettt-face');
    const [r, g, b] = (red.match(/[\d.]+/g) ?? []).map(Number);
    expect(r, `红方棋子底色 ${red} 不偏红`).toBeGreaterThan(g);
    expect(r, `红方棋子底色 ${red} 不偏红`).toBeGreaterThan(b);
  });

  test('投票详情：暗色下底部按钮有可见边框与文字色', async ({ page }) => {
    await useDarkTheme(page);
    await loginViaApi(page, SEED_USERS.core.username);

    const res = await page.request.post('/api/votes', {
      data: { title: 'E2E 暗色按钮', options: ['甲', '乙'] },
    });
    const { data } = (await res.json()) as { data: { id: string } };
    await page.goto(`/vote/${data.id}`);

    // 回归点：这些 .btn--* 修饰符此前只有类名没有样式，浏览器默认色在暗色下几乎不可见
    const ghost = page.getByRole('button', { name: '返回上页' });
    await expect(ghost).toBeVisible();

    const color = await ghost.evaluate((el) => getComputedStyle(el).color);
    expect(luminance(color), `按钮文字色 ${color} 在暗色下太暗`).toBeGreaterThan(128);

    const border = await ghost.evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(border, '按钮边框不可见').not.toMatch(/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/);
  });
});
