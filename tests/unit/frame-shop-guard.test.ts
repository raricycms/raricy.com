// ─────────────────────────────────────────────────────────────────────────────
// frame-shop-guard.test.ts —— 「商城面板只画第一款」这条已知限制的绊线
//
// 【绊的是什么】`ShopPanel.tsx` 是按「在售只有一款」写的：
//
//     const item = items[0];      // 代码里的注释写明这是刻意的
//
// 于是**给第二款框定价会让第一款从商城里消失** —— 服务端照样接受那个 key
//（`rentableFrameKeys()` 现算、`rentFrame` 也不挑），页面不报任何错，只是它在
// 页面上不见了。这正是本仓库最忌讳的那类静默失效。
//
// 【它不拦什么】不拦「上架第二款」。它拦的是**「定了价却没改面板」**：
// 一旦在售清单超过一条、而面板还在只画 `items[0]`，这里当场红，并给出两条出路
//（改面板成逐款一块表单，或者撤回定价）。判据是静态的：面板里出现 `items[0]`
// 且没有 `items.map` = 还没改。
//
// 【与 e2e 的分工】`tests/e2e/frame-shop.spec.ts` 钉的是「这一款买得通」（真浏览器
// 走完整条链路）；本用例钉的是**清单与面板的形状对不上**这件事，不需要起服务。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rentableFrameKeys } from '@/lib/frame-refs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PANEL = path.join(ROOT, 'src/app/fish/market/ShopPanel.tsx');

describe('鱼干商城：在售清单与面板形状', () => {
  it('面板还只画 items[0] 时，在售款数不得超过 1', () => {
    const src = fs.readFileSync(PANEL, 'utf8');
    const singleItemOnly = /items\[0\]/.test(src) && !/items\.map/.test(src);
    if (!singleItemOnly) return; // 面板已经改成逐款渲染 —— 这条绊线自然解除

    const keys = rentableFrameKeys();
    expect(
      keys.length,
      `在售有 ${keys.length} 款（${keys.join('、')}），而 ShopPanel 只画第一款（items[0]）——\n` +
        '  多出来的那些在页面上是**不存在**的（不报错、服务端也照样卖）。\n' +
        '  出路：① 把面板改成逐款一块表单（items.map）；② 或者撤回新增那款的 rentPerDay。\n' +
        '  背景见 docs/guide/头像框使用指南.md §7 与 ShopPanel.tsx 的注释。'
    ).toBeLessThanOrEqual(1);
  });
});
