// ─────────────────────────────────────────────────────────────────────────────
// guide-docs.test.ts —— 静态检查：指南页引用的 Markdown 必须真实存在
//
// 【为什么要有】站内有 4 个页面（/clipboard/guide、/image/guide、/vote/guide、
// /tool/cattca-guide）通过 MarkdownGuide.loadGuideHtml() 在**请求时**读盘渲染
// docs/ 下的 Markdown。这些文件不是普通文档，是**运行时资产** —— 文件名是接口。
//
// 危险在于失效是**全静默**的：loadGuideHtml 的 catch 兜底返回一句
// 「指南文档暂时无法加载。」配 HTTP 200。于是重命名一个 .md、或者把
// MarkdownGuide 的基准目录改错，tsc 不管、构建不报、e2e 没有覆盖 ——
// 线上直接变成一句占位文案，没有任何人会发现。
//
// 这个守卫把「页面 ↔ 文档」的绑定钉成会报错的契约。它**不硬编码路径**：
// 基准目录是从 MarkdownGuide.tsx 里解析出来的，所以页面侧和文档侧
// 任何一边单独移动都会红；只有两边一起改对才绿。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MARKDOWN_GUIDE = path.join(ROOT, 'src', 'app', 'components', 'MarkdownGuide.tsx');

/** 页面里调 loadGuideHtml('xxx.md') 的调用点。只认字面量实参。 */
const RE_CALL = /loadGuideHtml\(\s*'([^']+)'\s*\)/g;
/** 只要有调用（哪怕实参是变量），用来识别「有页面在用但守卫认不出来」的情况。 */
const RE_ANY_CALL = /loadGuideHtml\s*\(/g;

/**
 * 去掉**整行**注释，避免把注释里提到的调用当成真调用。
 *
 * 只剥整行、不剥行尾 —— 与 tests/unit/db-time-guard.test.ts 同一套保守做法：
 * 行尾剥离需要正确识别字符串字面量，否则 `'https://…'` 会被当成注释截断。
 */
function stripComments(src: string): string {
  return src.replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 从 MarkdownGuide.tsx 解析出文档基准目录，例如 `docs/guide`。
 *
 * 只认 `path.join(process.cwd(), 'a', 'b', ..., docFileName)` 这种形状 ——
 * 我们的实现就是这样写的。认不出来就抛，**绝不静默跳过**：守卫失效比没有守卫更糟。
 */
function resolveGuideBaseDir(): string[] {
  const src = fs.readFileSync(MARKDOWN_GUIDE, 'utf-8');
  const m = /path\.join\(\s*process\.cwd\(\)\s*,\s*([^)]*)\)/.exec(src);
  if (!m) {
    throw new Error(
      `无法从 ${path.relative(ROOT, MARKDOWN_GUIDE)} 解析出基准目录。\n` +
        `守卫依赖 path.join(process.cwd(), 'docs', ..., docFileName) 这一写法；` +
        `若实现已改，请同步更新本测试的解析逻辑。`
    );
  }
  const dirs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (dirs.length === 0) {
    throw new Error(`解析到了 path.join 但其中没有任何字符串目录：${m[1]}`);
  }
  return dirs;
}

/**
 * 扫出 src/app 下所有含 loadGuideHtml 调用的**页面**（App Router 约定为 page.tsx）。
 *
 * 限定 page.tsx 有两个好处：① 语义准确 —— 我们关心的就是「哪个页面渲染哪篇指南」；
 * ② 天然排除组件文件里的文档示例（MarkdownGuide.tsx 的用法注释就写着
 * `loadGuideHtml('xxx.md')`，全文件扫描会把它当成一个不存在的引用）。
 */
function collectGuidePages(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectGuidePages(p, out);
    else if (e.name === 'page.tsx') {
      if (RE_ANY_CALL.test(stripComments(fs.readFileSync(p, 'utf-8')))) out.push(p);
      RE_ANY_CALL.lastIndex = 0;
    }
  }
  return out;
}

const BASE_DIRS = resolveGuideBaseDir();
const GUIDE_PAGES = collectGuidePages(path.join(ROOT, 'src', 'app'));

describe('指南页 ↔ docs 文档的绑定', () => {
  it('基准目录能被解析出来', () => {
    expect(BASE_DIRS.length).toBeGreaterThan(0);
  });

  it('至少发现一个指南页（防止扫描逻辑悄悄失效）', () => {
    expect(GUIDE_PAGES.length).toBeGreaterThan(0);
  });

  it('每个调用点的实参都是字符串字面量 —— 否则下面的检查会漏过它', () => {
    const unresolved: string[] = [];
    for (const page of GUIDE_PAGES) {
      const src = stripComments(fs.readFileSync(page, 'utf-8'));
      const literalCount = [...src.matchAll(RE_CALL)].length;
      const anyCount = [...src.matchAll(RE_ANY_CALL)].length;
      if (literalCount !== anyCount) {
        unresolved.push(`${path.relative(ROOT, page)}（${anyCount} 个调用 / ${literalCount} 个字面量）`);
      }
    }
    expect(
      unresolved,
      `这些页面的 loadGuideHtml 实参不是字符串字面量，静态守卫无法校验其指向：\n  ${unresolved.join('\n  ')}`
    ).toEqual([]);
  });

  it('每个被引用的文档都真实存在，且有 H1 标题', () => {
    const missing: string[] = [];
    const noHeading: string[] = [];

    for (const page of GUIDE_PAGES) {
      const src = fs.readFileSync(page, 'utf-8');
      const rel = path.relative(ROOT, page);
      for (const [, docFileName] of src.matchAll(RE_CALL)) {
        const abs = path.join(ROOT, ...BASE_DIRS, docFileName);
        if (!fs.existsSync(abs)) {
          missing.push(`${rel} → ${path.join(...BASE_DIRS, docFileName)}`);
          continue;
        }
        // 首行必须是 H1：裸 marked 解析下，没有标题的文档会在页面里失去层级
        const firstLine = fs.readFileSync(abs, 'utf-8').split('\n')[0].trim();
        if (!/^#\s+\S/.test(firstLine)) {
          noHeading.push(`${path.join(...BASE_DIRS, docFileName)} 首行是「${firstLine}」`);
        }
      }
    }

    expect(
      missing,
      `指南页引用的文档不存在 —— 线上会静默显示「指南文档暂时无法加载。」：\n  ${missing.join('\n  ')}`
    ).toEqual([]);
    expect(noHeading, `这些指南文档没有 H1 标题：\n  ${noHeading.join('\n  ')}`).toEqual([]);
  });
});
