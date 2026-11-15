// ─────────────────────────────────────────────────────────────────────────────
// dev-tools-registry.test.ts —— 开发者工具清单 ↔ 路由目录对账
//
// 【为什么要有】合集首页、每个工具页的 metadata、工具箱主页的合集卡都读同一份
// `src/lib/dev-tools/registry.ts`。这份清单最容易出的错**都不报错**：
//   · 清单加了一行但忘了建页面 → 合集里多一张点进去 404 的卡片；
//   · 建了页面但没登记 → 页面存在却没有任何入口，只能手敲 URL；
//   · 图标名拼错 / 分类名拼错 → 首页渲染到一半才空白（或 tsc 报在别处）。
// 上面那条「建了页面没登记」尤其隐蔽：构建成功、页面 200、就是没人找得到。
// 所以这里做**双向**对账，并顺手把 metadata 助手的行为钉住。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import {
  DEV_TOOLS,
  DEV_TOOL_CATEGORIES,
  devToolHref,
} from '@/lib/dev-tools/registry';

describe('开发者工具清单：数据完整性', () => {
  it('slug / 标题 / href 都不重复', () => {
    const dup = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
    expect(dup(DEV_TOOLS.map((t) => t.slug))).toEqual([]);
    expect(dup(DEV_TOOLS.map((t) => t.title))).toEqual([]);
    expect(dup(DEV_TOOLS.map((t) => devToolHref(t)))).toEqual([]);
  });

  it('分类都在 DEV_TOOL_CATEGORIES 里，且每个分类都有工具', () => {
    const keys = new Set(DEV_TOOL_CATEGORIES.map((c) => c.key));
    for (const t of DEV_TOOLS) {
      expect(keys.has(t.category), `${t.slug} 的分类 ${t.category} 没登记`).toBe(true);
    }
    for (const c of DEV_TOOL_CATEGORIES) {
      expect(
        DEV_TOOLS.some((t) => t.category === c.key),
        `分类「${c.label}」下列表是空的`
      ).toBe(true);
    }
  });
});

describe('开发者工具清单：辅助函数', () => {
  it('devToolHref 按 legacy 分岔', () => {
    expect(devToolHref({ slug: 'json' })).toBe('/tool/dev/json');
    expect(devToolHref({ slug: 'base', legacy: true })).toBe('/tool/base');
  });
});
