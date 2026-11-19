// 页内滚动容器（components/Scrollbars.tsx）的行为用例。
//
// 这里只断言「能用」与「不丢」两件事，不比对像素外观（仓库不对样式做快照）：
//   1. 横向溢出的盒子（`pre`、横向表格）被接管后，横向仍然滚得动 —— 隐藏规则只
//      清纵向的 `::-webkit-scrollbar { width }`，横向条必须留着；
//   2. 局部容器的滑块跟着滚动走，内容被整体替换（innerHTML）后滑块还在。
//
// 第二条是真实回归点：滑块是容器的子节点，整体替换会把它一起删掉，靠同步时的
// `thumb.isConnected` 判断补回来。桌面项目才有意义（触屏不接管，见组件注释）。

import { test, expect } from '@playwright/test';

test.describe('页内滚动条', () => {
  test.skip(({ isMobile }) => isMobile, '触屏不接管局部滚动容器');

  test('局部容器：滑块跟随滚动，内容整体替换后仍在', async ({ page }) => {
    await page.goto('/explore', { waitUntil: 'domcontentloaded' });

    const port = page.locator('#scroll-probe');
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'scroll-probe';
      // fixed 定位：页面本身的 body 布局（flex / min-height）会把流内元素压成 0 高。
      box.style.cssText = 'position: fixed; top: 0; left: 0; width: 300px; height: 200px; overflow-y: auto; z-index: 9999;';
      box.innerHTML = '<div style="height: 900px;"></div>';
      document.body.appendChild(box);
    });

    // 接管发生在下一帧；类名是接管的唯一外部标记。
    await expect(port).toHaveClass(/scroll-port/, { timeout: 5000 });
    const thumb = port.locator('.scroll-port__thumb');
    await expect(thumb).toHaveCount(1);
    await expect(thumb).not.toHaveClass(/is-hidden/);

    const before = await thumb.evaluate((el) => getComputedStyle(el).transform);
    await page.evaluate(() => {
      const box = document.getElementById('scroll-probe')!;
      box.scrollTop = 300;
    });
    await expect
      .poll(async () => thumb.evaluate((el) => getComputedStyle(el).transform))
      .not.toBe(before);

    // 整体替换内容：滑块被一起删掉，同步时补回来。
    await page.evaluate(() => {
      const box = document.getElementById('scroll-probe')!;
      box.innerHTML = '<div style="height: 1200px;"></div>';
    });
    await expect(port.locator('.scroll-port__thumb')).toHaveCount(1, { timeout: 5000 });

    await page.evaluate(() => document.getElementById('scroll-probe')?.remove());
  });

  test('横向溢出的盒子仍能横向滚动', async ({ page }) => {
    await page.goto('/explore', { waitUntil: 'domcontentloaded' });

    await page.evaluate(() => {
      const pre = document.createElement('pre');
      pre.id = 'wide-probe';
      pre.style.cssText = 'width: 200px; overflow-x: auto; overflow-y: auto;';
      pre.textContent = 'x'.repeat(400);
      document.body.appendChild(pre);
    });

    const result = await page.evaluate(() => {
      const pre = document.getElementById('wide-probe')!;
      return {
        scrollable: pre.scrollWidth > pre.clientWidth + 1,
        overflowX: getComputedStyle(pre).overflowX,
      };
    });
    expect(result.scrollable, '横向溢出应当可滚').toBe(true);
    expect(result.overflowX).toBe('auto');

    await page.evaluate(() => document.getElementById('wide-probe')?.remove());
  });
});
