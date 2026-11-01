// ─────────────────────────────────────────────────────────────────────────────
// editor-mobile-boundary.spec.ts —— 320 宽：四入口 / 字数 / 所有浮层都不被裁
//
// QA 截图：组件弹层从第二个按钮处向右展开，被编辑器右缘裁掉关闭 X 与搜索框
// 右半；“插入”首字与底栏“0 字”也曾被外壳横向滚动裁掉。
// 这里不用截图猜：直接量编辑器裁剪框与每个浮层 / 关闭按钮 / 搜索框的 rect，
// 做 elementFromPoint，并真实点击关闭 X。博客与云剪贴板各跑一遍。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';

const EDITORS = [
  { name: '博客', url: '/blog/upload', id: '#editor' },
  { name: '云剪贴板', url: '/clipboard/upload', id: '#clipboard-editor' },
] as const;

async function openEditor(page: Page, url: string, id: string) {
  const login = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(url);
  const editor = page.locator(id);
  await expect(editor.locator('.md-toolbar')).toBeVisible();
  // 博客表单在 320 宽时标题 / 摘要会把编辑器推到首屏以下；elementFromPoint 对
  // 视口外坐标返回 null。先把编辑器滚进视口，再量边界。
  await editor.scrollIntoViewIfNeeded();
  return editor;
}

interface Measured {
  key: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  hit: boolean;
  hitEl: string;
}

/** 在编辑器的实际裁剪框（= 它的 border box）内量一组元素并做命中测试。 */
async function measureInsideEditor(
  editor: ReturnType<Page['locator']>,
  items: Array<{ key: string; selector: string }>
): Promise<{ clip: { left: number; right: number; top: number; bottom: number }; items: Measured[] }> {
  return editor.evaluate((root, requested) => {
    const box = root.getBoundingClientRect();
    const measured = requested.map(({ key, selector }) => {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`missing ${selector}`);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        key,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        hit: !!hit && (el === hit || el.contains(hit) || hit.contains(el)),
        hitEl: hit ? `${(hit as HTMLElement).tagName}.${(hit as HTMLElement).className}` : 'null',
      };
    });
    return {
      clip: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      items: measured,
    };
  }, items);
}

function assertInside(
  report: Awaited<ReturnType<typeof measureInsideEditor>>,
  label: string
): void {
  for (const item of report.items) {
    expect(item.left, `${label} / ${item.key} 左边被裁`).toBeGreaterThanOrEqual(
      report.clip.left - 1
    );
    expect(item.right, `${label} / ${item.key} 右边被裁`).toBeLessThanOrEqual(
      report.clip.right + 1
    );
    expect(item.top, `${label} / ${item.key} 顶部被裁`).toBeGreaterThanOrEqual(
      report.clip.top - 1
    );
    expect(item.bottom, `${label} / ${item.key} 底部被裁`).toBeLessThanOrEqual(
      report.clip.bottom + 1
    );
    expect(item.hit, `${label} / ${item.key} 命中点不在自身（命中 ${item.hitEl}）`).toBe(true);
  }
}

for (const { name, url, id } of EDITORS) {
  test(`${name} 320：四入口 / 字数完整，组件与其它浮层都收在编辑器内`, async ({ page }) => {
    const editor = await openEditor(page, url, id);

    // ── 基线：外壳没有被横向滚动，四入口与字数完整 ──────────────────────
    const base = await measureInsideEditor(editor, [
      { key: '插入', selector: '.md-toolbar__btn--entry' },
      { key: '字数', selector: '.md-editor__count' },
    ]);
    assertInside(base, '基线');
    expect(await editor.evaluate((root) => root.scrollLeft)).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(320 + 1);

    // ── 组件弹层：标题 / 搜索 / 列表 / 关闭 X 全部在编辑器框内且可点 ─────
    await editor.getByRole('button', { name: '组件', exact: true }).click();
    const components = editor.locator('.md-toolbar__menu--components');
    await expect(components).toBeVisible();
    assertInside(
      await measureInsideEditor(editor, [
        { key: '组件弹层', selector: '.md-toolbar__menu--components' },
        { key: '组件搜索', selector: '.md-component-picker__search' },
        { key: '组件列表', selector: '.md-component-picker__scroll' },
        { key: '组件关闭', selector: '.md-component-picker__close' },
      ]),
      '组件弹层'
    );
    // 真实点击关闭 X，而不是 Escape 绕过。
    await editor.locator('.md-component-picker__close').click();
    await expect(components).toHaveCount(0);

    // ── Insert 弹层：整块与可见条目在框内，点一条真实关闭 ────────────────
    await editor.getByRole('button', { name: '插入', exact: true }).click();
    const insert = editor.locator('.md-toolbar__menu--insert');
    await expect(insert).toBeVisible();
    assertInside(
      await measureInsideEditor(editor, [
        { key: 'Insert 弹层', selector: '.md-toolbar__menu--insert' },
        { key: 'Insert 第一条', selector: '.md-toolbar__menu--insert .md-toolbar__menu-item' },
      ]),
      'Insert 弹层'
    );
    await insert.locator('.md-toolbar__menu-item').first().click();
    await expect(insert).toHaveCount(0);

    // ── 更多弹层：同样在框内，点一条真实命令关闭 ────────────────────────
    await editor.getByRole('button', { name: '更多', exact: true }).click();
    const more = editor.locator('.md-toolbar__menu--right');
    await expect(more).toBeVisible();
    assertInside(
      await measureInsideEditor(editor, [
        { key: '更多弹层', selector: '.md-toolbar__menu--right' },
        { key: '更多首项', selector: '.md-toolbar__menu--right .md-toolbar__menu-item' },
      ]),
      '更多弹层'
    );
    await more.getByRole('menuitem', { name: '格式化', exact: true }).click();
    await expect(more).toHaveCount(0);

    // ── 插入引用对话框：在视口内，关闭按钮可点并真实关闭 ────────────────
    await editor.getByRole('button', { name: '插入引用', exact: true }).click();
    const modal = page.locator('.md-res-modal');
    await expect(modal).toBeVisible();
    const modalBox = await modal.boundingBox();
    expect(modalBox).not.toBeNull();
    expect(modalBox!.x).toBeGreaterThanOrEqual(0);
    expect(modalBox!.x + modalBox!.width).toBeLessThanOrEqual(321);
    const close = modal.locator('.chat-modal-close');
    await expect(close).toBeVisible();
    expect(
      await close.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (el === hit || el.contains(hit) || hit.contains(el));
      })
    ).toBe(true);
    await close.click();
    await expect(modal).toHaveCount(0);
  });
}
