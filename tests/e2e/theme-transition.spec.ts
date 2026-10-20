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
  for (const timing of result.timings) expect(timing).toMatchObject({ duration: 300, easing: 'ease' });
  expect(result.current).toBe(result.from);
  expect(result.pseudo).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => (window as unknown as { switchTheme: (theme: string) => void }).switchTheme('dark'));
  await expect(page.locator('.blog-filters')).toHaveCSS('background-color', 'rgb(24, 26, 29)');
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.id === 'theme-colors').length)).toBe(0);
});
