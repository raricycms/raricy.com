// ─────────────────────────────────────────────────────────────────────────────
// editor-mobile-boundary.spec.ts —— 320 宽下四入口与字数不被横向裁切
//
// QA 截图里「插入」首字与底栏「0 字」疑似被编辑器圆角 / 横向滚动裁掉。
// 这里不靠截图猜：直接量编辑器裁剪框、按钮与字数的 rect / scrollLeft /
// overflow，并做 elementFromPoint；任何一项仅在滚动后才可见都算失败。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';

test('320 宽：四入口首字与「0 字」天然完整可见（不靠横向滚动）', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);

  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/clipboard/upload');
  const editor = page.locator('#clipboard-editor');
  await expect(editor.locator('.md-toolbar')).toBeVisible();

  // 打开「组件」菜单，复现 QA 的交互顺序。
  await editor.getByRole('button', { name: '组件', exact: true }).click();
  await expect(page.locator('#clipboard-editor .md-toolbar__menu')).toBeVisible();

  const report = await editor.evaluate((root) => {
    const clip = root.getBoundingClientRect();
    const measure = (selector: string) => {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        selector,
        text: (el.textContent ?? '').trim(),
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        scrollLeft: el.scrollLeft,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: cs.overflowX,
        hitInside: !!hit && (el === hit || el.contains(hit) || hit.contains(el)),
      };
    };
    const toolbar = root.querySelector<HTMLElement>('.md-toolbar');
    const entries = Array.from(root.querySelectorAll<HTMLElement>('.md-toolbar__btn--entry')).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: (el.textContent ?? '').trim(), left: r.left, right: r.right };
    });
    const chain: unknown[] = [];
    for (let node: Element | null = toolbar; node; node = node.parentElement) {
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      chain.push({
        cls: (node as HTMLElement).className,
        left: r.left,
        right: r.right,
        width: r.width,
        offsetLeft: (node as HTMLElement).offsetLeft,
        marginLeft: cs.marginLeft,
        paddingLeft: cs.paddingLeft,
        transform: cs.transform,
        position: cs.position,
      });
      if (node === root) break;
    }
    return {
      chain,
      scroll: { rootScrollLeft: root.scrollLeft, windowX: window.scrollX, windowY: window.scrollY },
      clip: { left: clip.left, right: clip.right },
      toolbar: toolbar
        ? {
            left: toolbar.getBoundingClientRect().left,
            right: toolbar.getBoundingClientRect().right,
            scrollLeft: toolbar.scrollLeft,
            scrollWidth: toolbar.scrollWidth,
            clientWidth: toolbar.clientWidth,
            overflowX: getComputedStyle(toolbar).overflowX,
          }
        : null,
      entries,
      insert: measure('.md-toolbar__btn--entry'),
      count: measure('.md-editor__count'),
      bodyScrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    };
  });
  console.log('BOUNDARY', JSON.stringify(report));

  // 四入口都在裁剪框内且第一颗的首字没有被滚动 / 负边距吃掉。
  expect(report.insert).not.toBeNull();
  for (const entry of report.entries) {
    expect(entry.left, `${entry.text} 左边被裁`).toBeGreaterThanOrEqual(report.clip.left - 1);
    expect(entry.right, `${entry.text} 右边被裁`).toBeLessThanOrEqual(report.clip.right + 1);
  }
  expect(report.insert!.left, '「插入」首字被编辑器左缘裁掉').toBeGreaterThanOrEqual(
    report.clip.left - 1
  );
  expect(report.insert!.hitInside, '「插入」命中点不在自身').toBe(true);
  if (report.toolbar) {
    expect(report.toolbar.scrollLeft, '工具条被横向滚动后才露出「插入」').toBe(0);
  }

  // 字数完整可见。
  expect(report.count).not.toBeNull();
  expect(report.count!.text).toMatch(/^\d+ 字$/);
  expect(report.count!.left, '「0 字」左边被裁').toBeGreaterThanOrEqual(report.clip.left - 1);
  expect(report.count!.right, '「0 字」右边被裁').toBeLessThanOrEqual(report.clip.right + 1);

  // 页面本身不因编辑器横向溢出。
  expect(report.bodyScrollWidth, '320 宽出现整页横向滚动').toBeLessThanOrEqual(report.viewport + 1);
});
