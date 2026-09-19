// ─────────────────────────────────────────────────────────────────────────────
// blog-visibility-guard.test.ts —— 静态检查：判「对外可见」不许用「不等于最不可见的那档」
//
// 【绊的是什么】`Blog.visibility` 是个**开区间**的白名单：今天三档
// internal / link / public，明天很可能加第四档（比如「仅登录用户可见」）。
// 而下面这两种写法在加第四档时会**静默把新档一起放出去**：
//
//     where.visibility = { not: 'internal' }          // ← 新档自动变成「对外可见」
//     if (blog.visibility !== 'internal') { ... }
//
// 而「放出去」是**不可逆的**：搜索引擎与第三方存档会抓走副本，改回来也收不回
// （见 docs/architecture.md §6.11 的风险清单）。所以它必须是白名单式的：
//
//     EXTERNAL_VISIBILITIES  /  EXTERNAL_VISIBLE_BLOG_WHERE   ← 只列「算数的那几档」
//
// 加第四档时，白名单不会自动带上它 —— 你得**亲手**决定它算不算对外可见。这正是要的。
//
// ── 【2026-09 改名：private → internal，所以旧名也一起禁】────────────────────────
//
// 这一档原来叫 `private`，改名是因为它在**本仓库已经是另一个东西的名字**：剪贴板的
// 「不公开」与收藏夹的「私密」都是「只有本人」，而这一档是「所有 core+ 成员都能看」。
// 顺带对齐了审计域 —— `AdminActionLog.visibility` 本来就是 'public' / 'internal'。
//
// ⚠️ **旧名必须继续禁，而且理由比原来更硬**：改名之后没有任何一行再是 `'private'`，
// 于是 `visibility !== 'private'` 对**每一行都成立** —— 同一个写法从「新档会漏出去」
// 升级成「**全部文章都当成对外可见**」。漏掉的旧拼写会变成一发静默的全量公开。
//
// 【为什么需要静态守卫】tsc 拦不住：`string` 与 `'private'` 比较永远合法。构建不报。
// 单测也拦不住 —— 除非恰好有一条用例覆盖到「第四档」这个当时还不存在的值。
// 跟 db-time-guard / anonymous-read-guard 同属一类：**只有静态检查能钉住**。
//
// 【判据为什么这么窄】只扫 `visibility` 与档位字面量**同一行**同时出现。
// 全仓另有三个同名字段，必须不误伤（都已实地确认）：
//   · `ImageHosting.isPublic`、`Favorite.isPublic` —— 布尔，没有字符串档位
//   · `ClipBoard.publicity` —— 字段名不同，值是 true/false，没有 'private'
//   · `AdminActionLog.visibility` —— **字段同名**，但它用的是 'public'/'internal'，
//     全仓唯一一处 `{ not: ... }` 就在 audit-service（`{ not: 'public' }`）。
//     ⚠️ 注意：改名之后 `'internal'` 在**两个域里都合法**了（博客的第一档、审计的内部
//     日志）—— 所以第一组 BANNED 只禁「不等于」那三种形状，不会碰 `visibility: 'internal'`。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

/**
 * 第一组：当前档位名（`internal`）的「不等于最不可见那一档」三种写法。
 *
 * ⚠️ 这三种都是 `visibility` 与档位字面量 **同一行**才命中 —— 见文件头的判据讨论。
 */
const BANNED_CURRENT = [
  /visibility\s*!==?\s*['"]internal['"]/,
  /visibility\s*:\s*\{\s*not\s*:\s*['"]internal['"]/,
  /visibility\s*:\s*['"]internal['"]\s*\?\s*undefined\s*:\s*\{\s*not/,
];

/**
 * 第二组：**旧档位名**（`private`）出现在 `visibility` 旁边 —— 一律禁，任何形状。
 *
 * 比第一组更宽是有意的：改名之后 `'private'` 在博客可见性里**没有任何合法用途**了。
 * 而上面那三种「不等于」的写法一旦是旧名，就从「加新档会漏」升级成「**每一行都漏**」
 * （没有行再是 'private'），所以旧拼写不是「历史遗留」而是「现役的全量公开漏洞」。
 *
 * 顺手也接住 `visibility === 'private'` 这种**死分支**（永不匹配，静默失效）——
 * 它不危险，但它会让人以为自己还在读一份有效的判定。
 */
const BANNED_LEGACY = [
  // 与第一组同形的三种（这三种才是「加第四档会漏」的那个坑）
  /visibility\s*!==?\s*['"]private['"]/,
  /visibility\s*:\s*\{\s*not\s*:\s*['"]private['"]/,
  /visibility\s*:\s*['"]private['"]\s*\?\s*undefined\s*:\s*\{\s*not/,
  // 另外两种：赋值（`where.visibility = 'private'`）与相等比较（`=== 'private'`）。
  // 它们不会「漏出去」，是**死值 / 死分支** —— 但一个永不匹配的判定会让人以为
  // 自己还在读一份有效的代码，所以一并禁掉。
  /visibility\s*[:=]\s*['"]private['"]/,
  /visibility\s*===?\s*['"]private['"]/,
];

const BANNED = [...BANNED_CURRENT, ...BANNED_LEGACY];

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

describe('判「对外可见」必须是白名单，不许写「不等于最不可见的那一档」', () => {
  // ★ 产出自检 ★ —— 这条不是凑数的：正则写错（少个转义、写错引号）时，
  // 下面那条扫描会**一片绿**，而它其实什么都没扫到。先证明它认得出违规样本。
  it('自检：当前档位名的三种违规写法都能被认出来', () => {
    const sample = [
      "  const w = { visibility: { not: 'internal' } };",
      '  if (blog.visibility !== "internal") return true;',
      "  if (row.visibility != 'internal') return true;",
    ].join('\n');
    expect(scan(sample, 'sample.ts').length, '三种写法都要命中').toBe(3);
  });

  it('★ 自检：**旧档位名**的任何写法都要被认出来（它现在是全量公开漏洞，不是遗留）', () => {
    // 改名之后没有一行是 'private'，所以这一条里的每种写法都**恒真** → 全部对外可见。
    const sample = [
      "  const w = { visibility: { not: 'private' } };",
      '  if (blog.visibility !== "private") return true;',
      "  if (row.visibility != 'private') return true;",
      "  if (blog.visibility === 'private') return null;",
      "  where.visibility = 'private';",
    ].join('\n');
    expect(scan(sample, 'sample.ts').length, '五种写法都要命中').toBe(5);
  });

  it('自检：合法写法与注释不该被命中（否则这条守卫会天天误报，最后被人关掉）', () => {
    const sample = [
      // 注释里的反例 —— blog-service 文件头就是这么写的
      "//   绝不写 `visibility !== 'internal'`，也别写 `not: 'internal'`。",
      ' * 同理，`visibility !== "internal"` 也是错的',
      // 合法写法
      '  ...(viewer?.isCore ? {} : EXTERNAL_VISIBLE_BLOG_WHERE),',
      '  visibility: { in: [...EXTERNAL_VISIBILITIES] },',
      "  if (blog.visibility === 'internal') return null;",
      // 审计域的 internal 也必须不误伤 —— 改名后两个域共用这个词
      "  if (params.visibility === 'internal') where.visibility = { not: 'public' };",
      // 同名的其它域，必须不误伤
      "  else if (params.publicity === 'private') where.publicity = false;",
      '  <span className={`favorite-badge--${row.isPublic ? \'public\' : \'private\'}`}>',
    ].join('\n');
    expect(scan(sample, 'sample.ts'), '合法写法与注释都不该命中').toEqual([]);
  });

  it('全仓扫描：没有任何地方用「不等于档位」判对外可见，也没有旧档位名的残留', () => {
    const hits = sourceFiles(SRC).flatMap((f) =>
      scan(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f).split(path.sep).join('/'))
    );

    expect(
      hits,
      '判「对外可见」请用 EXTERNAL_VISIBILITIES / EXTERNAL_VISIBLE_BLOG_WHERE\n' +
        '（src/lib/blog-visibility.ts）。「不等于最不可见的那一档」在加第四档时会**静默把\n' +
        '新档一起放出去**，而放出去是不可逆的。\n' +
        '⚠️ 若违规处里出现的是旧档位名 private：改名后它恒真 —— 那是**全部文章都被当成\n' +
        '对外可见**，不是历史遗留。违规处：\n  ' +
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
