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
import fs from 'node:fs';
import path from 'node:path';
import {
  DEV_TOOLS,
  DEV_TOOL_CATEGORIES,
  DEV_TOOL_ICON_NAMES,
  DEV_TOOL_SLUGS,
  devToolHref,
  devToolMetadata,
  findDevTool,
} from '@/lib/dev-tools/registry';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DEV_DIR = path.join(ROOT, 'src', 'app', 'tool', 'dev');
const TOOL_DIR = path.join(ROOT, 'src', 'app', 'tool');

const NEW_TOOLS = DEV_TOOLS.filter((t) => !t.legacy);
const LEGACY_TOOLS = DEV_TOOLS.filter((t) => t.legacy);

describe('开发者工具清单：数据完整性', () => {
  it('自检：清单不是空的，且新工具 / 既有工具两类都存在', () => {
    expect(DEV_TOOLS.length).toBeGreaterThanOrEqual(30);
    expect(NEW_TOOLS.length).toBeGreaterThanOrEqual(25);
    expect(LEGACY_TOOLS.length).toBeGreaterThanOrEqual(5);
  });

  it('slug / 标题 / href 都不重复', () => {
    const dup = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
    expect(dup(DEV_TOOLS.map((t) => t.slug))).toEqual([]);
    expect(dup(DEV_TOOLS.map((t) => t.title))).toEqual([]);
    expect(dup(DEV_TOOLS.map((t) => devToolHref(t)))).toEqual([]);
  });

  it('每条都填了关键词与标签，且标签不重复', () => {
    for (const t of DEV_TOOLS) {
      expect(t.keywords.trim(), `${t.slug} 缺关键词`).not.toBe('');
      expect(t.tags.length, `${t.slug} 缺标签`).toBeGreaterThan(0);
      expect(new Set(t.tags).size, `${t.slug} 标签重复`).toBe(t.tags.length);
      expect(t.desc.trim(), `${t.slug} 缺说明`).not.toBe('');
    }
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

  it('图标名都合法，且每个图标都真的被用上（别留死名字）', () => {
    const known = new Set<string>(DEV_TOOL_ICON_NAMES);
    for (const t of DEV_TOOLS) {
      expect(known.has(t.icon), `${t.slug} 的图标 ${t.icon} 不在 DEV_TOOL_ICON_NAMES 里`).toBe(true);
    }
    const used = new Set(DEV_TOOLS.map((t) => t.icon));
    const dead = DEV_TOOL_ICON_NAMES.filter((n) => !used.has(n));
    expect(dead, `这些图标名在清单里没有任何工具使用：${dead.join(', ')}`).toEqual([]);
  });

  it('DEV_TOOL_SLUGS 与清单里的新工具一一对应', () => {
    expect([...DEV_TOOL_SLUGS]).toEqual(NEW_TOOLS.map((t) => t.slug));
  });
});

describe('开发者工具清单：与路由目录双向对账', () => {
  it('每个新工具都有 src/app/tool/dev/<slug>/page.tsx', () => {
    const missing = NEW_TOOLS.filter(
      (t) => !fs.existsSync(path.join(DEV_DIR, t.slug, 'page.tsx'))
    ).map((t) => `src/app/tool/dev/${t.slug}/page.tsx`);
    expect(missing, `清单里有、页面不存在：\n${missing.join('\n')}`).toEqual([]);
  });

  it('每个新工具页都用 DevToolShell + devToolMetadata（防止抄漏外壳 / metadata）', () => {
    const bad: string[] = [];
    for (const t of NEW_TOOLS) {
      const file = path.join(DEV_DIR, t.slug, 'page.tsx');
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (!/DevToolShell/.test(src)) bad.push(`${t.slug}: 没有用 DevToolShell`);
      if (!/devToolMetadata\(\s*['"]/.test(src)) bad.push(`${t.slug}: metadata 没走 devToolMetadata`);
      if (!new RegExp(`devToolMetadata\\(\\s*['"]${t.slug}['"]`).test(src)) {
        bad.push(`${t.slug}: devToolMetadata 的 slug 与目录名不一致`);
      }
    }
    expect(bad, `\n${bad.join('\n')}`).toEqual([]);
  });

  it('每个既有工具都还指向真实存在的页面（合集只索引，不搬家）', () => {
    const missing = LEGACY_TOOLS.filter(
      (t) => !fs.existsSync(path.join(TOOL_DIR, t.slug, 'page.tsx'))
    ).map((t) => `/tool/${t.slug}`);
    expect(missing, `既有工具页面不存在：${missing.join(', ')}`).toEqual([]);
    for (const t of LEGACY_TOOLS) {
      expect(devToolHref(t)).toBe(`/tool/${t.slug}`);
    }
  });

  it('合集目录下没有「未登记」的工具页（建了页面却没有入口）', () => {
    const registered = new Set<string>(DEV_TOOL_SLUGS);
    const dirs = fs
      .readdirSync(DEV_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const orphan = dirs.filter((d) => !registered.has(d));
    expect(
      orphan,
      `这些目录下有页面，但 registry 里没有登记，合集中不会出现：${orphan.join(', ')}`
    ).toEqual([]);
  });
});

describe('开发者工具清单：辅助函数', () => {
  it('devToolHref 按 legacy 分岔', () => {
    expect(devToolHref({ slug: 'json' })).toBe('/tool/dev/json');
    expect(devToolHref({ slug: 'base', legacy: true })).toBe('/tool/base');
  });

  it('findDevTool 找得到已知项，找不到返回 undefined', () => {
    expect(findDevTool('json')?.title).toBe('JSON 格式化与校验');
    expect(findDevTool('does-not-exist')).toBeUndefined();
  });

  it('devToolMetadata 的标题带统一后缀，说明与清单一致', () => {
    const tool = findDevTool('json');
    if (!tool) throw new Error('registry 里没有 json');
    expect(devToolMetadata('json')).toEqual({
      title: `${tool.title} - 聪明山工具箱`,
      description: tool.desc,
    });
  });
});
