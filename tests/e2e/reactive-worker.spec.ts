// ─────────────────────────────────────────────────────────────────────────────
// reactive-worker.spec.ts —— 格式分析真的在 Worker 里跑，且没有回退主线程
//
// 计划验收要求「真实 worker 启动（page worker 事件 + 成功分析 / 无本地回退）」。
// 单测只能证明调度器接口；这里的判据是浏览器真的创建了 Worker，分析完成后
// 面板显示「未发现问题」而不是「（本地检查）」。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';

test('编辑器格式分析在真实 Worker 中完成，不回退本地检查', async ({ page }) => {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));

  const login = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);

  await page.goto('/blog/upload');
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.insertText('<panel title="示例">\n\n正文\n\n</panel>');

  // 真实 Worker 文件被创建（不是主线程 fallback）。
  await expect.poll(() => workers.length, { timeout: 15_000 }).toBeGreaterThan(0);

  const state = page.locator('.md-authoring__state');
  await expect(state).toContainText('未发现问题', { timeout: 20_000 });
  await expect(page.locator('.md-authoring')).not.toContainText('本地检查');

  // 诊断面板的格式化状态不应出现“检查中”这种挂起态。
  await expect(state).not.toContainText('检查中');

  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText('<panel title="未闭合">\n\n局部正文\n\n## 后续章节\n\n继续显示');
  await expect(state).toContainText('错误 0 · 警告 1');
  await page.locator('.md-editor__mode', { hasText: '预览' }).click();
  const preview = page.locator('.md-editor__preview-body');
  await expect(preview.getByRole('heading', { name: '后续章节' })).toBeVisible();
  await expect(preview).toContainText('继续显示');
});
