// ─────────────────────────────────────────────────────────────────────────────
// blog-visibility-guard.test.ts —— 静态检查：判「对外可见」不许用「不等于 private」
//
// 【绊的是什么】`Blog.visibility` 是个**开区间**的白名单：今天三档
// private / link / public，明天很可能加第四档（比如「仅登录用户可见」）。
// 而下面这两种写法在加第四档时会**静默把新档一起放出去**：
//
//     where.visibility = { not: 'private' }          // ← 新档自动变成「对外可见」
//     if (blog.visibility !== 'private') { ... }
//
// 而「放出去」是**不可逆的**：搜索引擎与第三方存档会抓走副本，改回来也收不回
// （见 docs/architecture.md §6.11 的风险清单）。所以它必须是白名单式的：
//
//     EXTERNAL_VISIBILITIES  /  EXTERNAL_VISIBLE_BLOG_WHERE   ← 只列「算数的那几档」
//
// 加第四档时，白名单不会自动带上它 —— 你得**亲手**决定它算不算对外可见。这正是要的。
//
// 【为什么需要静态守卫】tsc 拦不住：`string` 与 `'private'` 比较永远合法。构建不报。
// 单测也拦不住 —— 除非恰好有一条用例覆盖到「第四档」这个当时还不存在的值。
// 跟 db-time-guard / anonymous-read-guard 同属一类：**只有静态检查能钉住**。
//
// 【判据为什么这么窄】只扫 `visibility` 与 `'private'` **同一行**同时出现。
// 全仓另有三个同名字段，必须不误伤（都已实地确认）：
//   · `ImageHosting.isPublic`、`Favorite.isPublic` —— 布尔，没有 'private' 值
//   · `ClipBoard.publicity` —— 字段名不同，值是 true/false，没有 'private'
//   · `AdminActionLog.visibility` —— **字段同名**，但它用的是 'public'/'internal'，
//     全仓唯一一处 `{ not: ... }` 就在 audit-service（`{ not: 'public' }`），
//     `'private'` 这个字面量在审计域里根本不出现
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

/**
 * 「不等于 private」的三种写法。
 *
 * ⚠️ 这三种都是 `visibility` 与 `'private'` **同一行**才命中 —— 见文件头的判据讨论。
 */
const BANNED = [
  /visibility\s*!==?\s*['"]private['"]/,
  /visibility\s*:\s*\{\s*not\s*:\s*['"]private['"]/,
  /visibility\s*:\s*['"]private['"]\s*\?\s*undefined\s*:\s*\{\s*not/,
];

/** 是不是纯注释行（行首 `//` / `*` / `/*`）。 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** 扫全仓，返回违规处的 `相对路径:行号: 内容`。 */
function scan(text: string, rel: string): string[] {
  const hits: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    // 注释行跳过 —— blog-service 的文件头**故意**把这两种写法当反例写在注释里，
    // 不跳过的话这条守卫会把自己的文档判成违规。
    if (isCommentLine(line)) return;
    if (BANNED.some((re) => re.test(line))) {
      hits.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

describe('判「对外可见」必须是白名单，不许写「不等于 private」', () => {
  // ★ 产出自检 ★ —— 这条不是凑数的：正则写错（少个转义、写错引号）时，
  // 下面那条扫描会**一片绿**，而它其实什么都没扫到。先证明它认得出违规样本。
  it('自检：三种违规写法都能被认出来', () => {
    const sample = [
      "  const w = { visibility: { not: 'private' } };",
      '  if (blog.visibility !== "private") return true;',
      "  if (row.visibility != 'private') return true;",
    ].join('\n');
    expect(scan(sample, 'sample.ts').length, '三种写法都要命中').toBe(3);
  });

  it('自检：合法写法与注释不该被命中（否则这条守卫会天天误报，最后被人关掉）', () => {
    const sample = [
      // 注释里的反例 —— blog-service 文件头就是这么写的
      "//   绝不写 `visibility !== 'private'`，也别写 `not: 'private'`。",
      ' * 同理，`visibility !== "private"` 也是错的',
      // 合法写法
      '  ...(viewer?.isCore ? {} : EXTERNAL_VISIBLE_BLOG_WHERE),',
      "  visibility: { in: [...EXTERNAL_VISIBILITIES] },",
      "  if (blog.visibility === 'private') return null;",
      // 同名的其它域，必须不误伤
      "  else if (params.visibility === 'internal') where.visibility = { not: 'public' };",
      "  else if (params.publicity === 'private') where.publicity = false;",
      '  <span className={`favorite-badge--${row.isPublic ? \'public\' : \'private\'}`}>',
    ].join('\n');
    expect(scan(sample, 'sample.ts'), '合法写法与注释都不该命中').toEqual([]);
  });

  it('全仓扫描：没有任何地方用「不等于 private」判对外可见', () => {
    const hits = sourceFiles(SRC).flatMap((f) =>
      scan(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f).split(path.sep).join('/'))
    );

    expect(
      hits,
      '判「对外可见」请用 EXTERNAL_VISIBILITIES / EXTERNAL_VISIBLE_BLOG_WHERE\n' +
        '（src/lib/blog-visibility.ts）。「不等于 private」在加第四档时会**静默把新档\n' +
        '一起放出去**，而放出去是不可逆的。违规处：\n  ' +
        (hits.join('\n  ') || '（无）')
    ).toEqual([]);
  });

  it('扫描面自检：真的扫到了文件（路径写错时上面那条会假绿）', () => {
    const files = sourceFiles(SRC);
    expect(files.length, 'src/ 下应当有大量 ts/tsx').toBeGreaterThan(100);
    // blog-service 一定在扫描面内 —— 白名单就住在隔壁模块
    expect(files.some((f) => f.endsWith(path.join('lib', 'blog-service.ts')))).toBe(true);
  });
});
