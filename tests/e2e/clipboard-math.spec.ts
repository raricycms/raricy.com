// ─────────────────────────────────────────────────────────────────────────────
// clipboard-math.spec.ts —— 云剪贴板详情页的 LaTeX 渲染。
//
// 【为什么单独一条】线上用户反馈的就是这个页面：「详情页公式完全不渲染」。根因在
// 共享的 MarkdownRenderer（占位符还原把 `$$` 吞成 `$`，跨行块级公式连 MathJax 都
// 不启动；另有公式里的 `<` 未转义被 HTML 解析器吃掉），单测见
// tests/unit/markdown-math.test.ts。这里按用户视角跑一遍真实链路：
// 建一篇含公式的剪贴板 → 打开详情页 → 块级公式必须是块级、且没有解析错误。
//
// 详情页需要 core 用户（requireCoreUser），所以先 API 登录再建内容。
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from '@playwright/test';
import { loginViaApi, uniqueTag } from './helpers';
import { SEED_USERS } from './seed';

test.describe('云剪贴板：LaTeX 公式', () => {
  test('跨行块级公式渲染为块级，行内公式保持行内', async ({ page }) => {
    await loginViaApi(page, SEED_USERS.core.username);

    const content =
      '$$\n\\begin{cases} x>b & \\text{大} \\\\ x<b & \\text{小} \\end{cases}\n$$\n\n' +
      '行内公式 $x^2$ 保持行内。\n';
    const res = await page.request.post('/api/clipboard', {
      data: { title: `e2e-math-${uniqueTag()}`, content, publicity: true },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { id } = (await res.json()) as { id: string };

    await page.goto(`/clipboard/${id}`);

    // 统一引擎：块级公式是 `.local-math-display`，行内是 `.local-math-inline`。
    const display = page.locator('.local-math-display');
    await expect(display).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.local-math-inline')).toHaveCount(1);
    // 不允许退化成 fallback 源码（那说明 formulas 没被识别）。
    await expect(page.locator('.local-math-fallback')).toHaveCount(0);
  });
});
