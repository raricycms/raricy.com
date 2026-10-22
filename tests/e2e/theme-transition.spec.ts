import { expect, test } from '@playwright/test';
import { loginViaApi } from './helpers';
import { SEED_USERS } from './seed';

test('主题颜色共用时间线，覆盖卡片、字段、滑槽及蒙版；快速切回从当前颜色续接', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.directory.username);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/blog?scope=mine');
  await expect(page.locator('.blog-item').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { switchTheme?: unknown }).switchTheme)).toBe('function');
  const result = await page.evaluate(() => {
    const change = (window as unknown as { switchTheme: (theme: string) => void }).switchTheme;
    const selectors = ['.site-navbar', '.blog-filters', '.blog-item', '.search-input', '.segmented'];
    const elements = selectors.map((selector) => document.querySelector(selector)!);
    change('dark');
    const all = document.getAnimations().filter((animation) => animation.id === 'theme-colors');
    const backgrounds = elements.map((element) => all.find((animation) => (animation.effect as KeyframeEffect).target === element && (animation.effect as KeyframeEffect).getKeyframes().some((frame) => frame.backgroundColor))!);
    const timings = backgrounds.map((animation) => ({ start: animation.startTime, duration: animation.effect!.getTiming().duration, easing: animation.effect!.getTiming().easing }));
    all.forEach((animation) => { animation.pause(); animation.currentTime = 150; });
    const current = getComputedStyle(elements[0]).backgroundColor;
    change('light');
    const restarted = elements[0].getAnimations().find((animation) => animation.id === 'theme-colors')!;
    const from = (restarted.effect as KeyframeEffect).getKeyframes()[0].backgroundColor;
    return { timings, current, from, pseudo: all.some((animation) => (animation.effect as KeyframeEffect).pseudoElement === '::before') };
  });
  expect(result.timings).toHaveLength(5);
  expect(new Set(result.timings.map((timing) => timing.start)).size).toBe(1);
  for (const timing of result.timings) expect(timing).toMatchObject({ duration: 480, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  expect(result.current).toBe(result.from);
  expect(result.pseudo).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => (window as unknown as { switchTheme: (theme: string) => void }).switchTheme('dark'));
  await expect(page.locator('.blog-filters')).toHaveCSS('background-color', 'rgb(24, 26, 29)');
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.id === 'theme-colors').length)).toBe(0);
});

// 【回归】2026-10：博客目录页切主题时「背景色直接跳色、没有渐变」。
//
// 根因不是时间线，而是**目标数量**：目录一页 50 篇，每个元素的颜色都要单独建一条
// WAAPI 动画，实测 810 条，其中 630 多条的目标在视口外（屏幕里只放得下 4 张卡）。
// 每帧都要把这 800 多个元素重算一遍样式，帧间隔被拖到 100ms 以上 —— 480ms 的时间线
// 只画得出 2~4 帧，观感就是没有过渡；同一时刻打开轻页面（设置页）却平滑。
//
// 修复只给「绘制盒与视口相交」的元素建动画（零尺寸盒子量不出可见性，照旧动画）。
// 这里钉住两件事：视口内的卡片**有**动画、视口外的卡片**没有** —— 谁把那条可见性
// 过滤删掉，第二条会当场变红。
test('重页面上只给视口内的元素建换色动画（目录页 50 篇不能整页重算）', async ({ page }) => {
  await loginViaApi(page, SEED_USERS.directory.username);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/blog?scope=mine');
  await expect(page.locator('.blog-item')).toHaveCount(50);
  await expect(page.locator('.blog-item').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { switchTheme?: unknown }).switchTheme)).toBe('function');

  const result = await page.evaluate(() => {
    const switchTheme = (window as unknown as { switchTheme: (theme: string) => void }).switchTheme;
    // 起点固定为浅色：初始主题跟随系统偏好，跑到深色机器上 switchTheme 会直接早退。
    document.documentElement.setAttribute('data-theme', 'light');
    const cards = Array.from(document.querySelectorAll('.blog-item'));
    const rectOf = (card: Element) => card.getBoundingClientRect();
    const onScreen = cards.find((card) => { const r = rectOf(card); return r.top < window.innerHeight && r.bottom > 0; })!;
    const offScreen = cards.find((card) => rectOf(card).top >= window.innerHeight)!;
    const animationsOf = (target: Element) => document.getAnimations().filter(
      (animation) => animation.id === 'theme-colors' && (animation.effect as KeyframeEffect).target === target,
    );
    switchTheme('dark');
    const all = document.getAnimations().filter((animation) => animation.id === 'theme-colors');
    return {
      onScreen: animationsOf(onScreen).length,
      offScreen: animationsOf(offScreen).length,
      body: animationsOf(document.body).length,
      total: all.length,
      offScreenTop: Math.round(rectOf(offScreen).top),
    };
  });

  expect(result.onScreen, '视口内的卡片没有换色动画 —— 可见区域会跳色').toBeGreaterThan(0);
  expect(result.offScreen, `视口外的卡片也在建动画（top=${result.offScreenTop}）—— 整页重算会把帧预算吃光`).toBe(0);
  expect(result.body, '页面底色（body）必须参与换色动画').toBeGreaterThan(0);
  // 50 篇全建动画时实测 800+ 条；只留视口内应该是一个数量级的下降。
  expect(result.total).toBeLessThan(400);
});

