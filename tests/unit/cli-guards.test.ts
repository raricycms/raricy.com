// ─────────────────────────────────────────────────────────────────────────────
// cli-guards.test.ts —— 静态检查：运维 CLI 的两条硬约定
//
// 【约定一：--help 不许加载 Prisma】
// scripts/cli.ts 的入口把 Prisma 的加载推迟到「确定要执行命令」之后，于是
// `npm run cli -- --help` 与交互式菜单在**没有任何数据库**的机器上也能渲染，
// 而且是瞬时的（不用担心连不上库时连帮助都看不了）。
// 这条约定极容易被无意破坏：只要在某个命令模块顶上写一句
//   import { prisma } from '../../../src/lib/db'
// 就全废了 —— tsc 不管、build 不报、测试也照过（测试环境有库），
// 只有在生产上库连不上的那一刻才暴露。所以钉成静态检查。
// 正确写法是在 run() 里 `await import(...)`（或者只 `import type`）。
//
// 【约定二：时间戳只用同一把钟】
// 与 tests/unit/db-time-guard.test.ts 同样的理由，但那个守卫的扫描范围是
// src/lib、src/app/api、middleware、tests/helpers —— **不含 scripts/**。
// CLI 会写库、会比对库内时间（比如审计日志的时间窗），所以这里补上。
// 取「当前时刻」一律 nowForDb()；展示一律 ymd/ymdhms 或 getUTC*。
//
// 【约定三：不许顶层 await】
// 本仓库根 package.json 没有 "type": "module"，scripts/ 下的 .ts 按 CJS 语义执行，
// 而 CJS 没有顶层 await。全部 await 必须待在 async 函数里。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI_ENTRY = path.join(ROOT, 'scripts', 'cli.ts');
const CLI_DIR = path.join(ROOT, 'scripts', 'cli');

/** 顶层静态 import：行首（无缩进）的 import，且不是 `import type`。 */
const RE_TOP_IMPORT = /^import\s+(?!type\b)([\s\S]*?)from\s+['"]([^'"]+)['"]/gm;
const RE_ARGLESS_NEW_DATE = /new\s+Date\s*\(\s*\)/g;
const RE_NEW_DATE_NOW = /new\s+Date\s*\(\s*Date\.now\s*\(/g;
const RE_MIXED_SUBTRACTION =
  /\.getTime\(\)\s*-\s*Date\.now\(\)|Date\.now\(\)\s*-\s*[\w.$]+\.getTime\(\)/g;
const RE_TO_LOCALE = /toLocale(String|DateString|TimeString|Format)/g;
const RE_TOP_LEVEL_AWAIT = /^await\s/gm;

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 去掉注释，避免把「文档里提到 new Date()」误判成代码。块注释替换为等长空白以保住行号。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const CLI_FILES = [CLI_ENTRY, ...collectFiles(CLI_DIR)];

/** 在文件里跑一个正则，返回 `相对路径:行号` 形式的命中列表。 */
function hits(re: RegExp): string[] {
  const found: string[] = [];
  for (const file of CLI_FILES) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split('\n').length;
      found.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${line}  ${m[0].trim()}`);
    }
  }
  return found;
}

describe('运维 CLI：--help 不加载 Prisma', () => {
  it('scripts/cli/** 不许顶层静态 import src/lib 的运行时值（只许 import type）', () => {
    const offenders: string[] = [];
    for (const file of CLI_FILES) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of src.matchAll(RE_TOP_IMPORT)) {
        const spec = m[2];
        if (!spec.includes('src/lib') && !spec.startsWith('@/lib')) continue;
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${line}  from '${spec}'`);
      }
    }
    expect(
      offenders,
      `这些顶层 import 会让 --help 也要加载 Prisma。改成 run() 里的 await import()，或改为 import type：\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });
});

describe('运维 CLI：时间戳只用一把钟', () => {
  it('不许无参 new Date()（取当前时刻用 nowForDb()）', () => {
    expect(hits(RE_ARGLESS_NEW_DATE)).toEqual([]);
  });

  it('不许 new Date(Date.now(...))（同上，只是套了层壳）', () => {
    expect(hits(RE_NEW_DATE_NOW)).toEqual([]);
  });

  it('不许库内时间戳与 Date.now() 相减（两把钟差 8 小时）', () => {
    expect(hits(RE_MIXED_SUBTRACTION)).toEqual([]);
  });

  it('不许 toLocale*（按运行机器时区再平移一次）', () => {
    expect(hits(RE_TO_LOCALE)).toEqual([]);
  });
});

describe('运维 CLI：CJS 语义', () => {
  it('不许顶层 await（scripts/ 下的 .ts 按 CJS 执行，没有顶层 await）', () => {
    expect(
      hits(RE_TOP_LEVEL_AWAIT),
      '把 await 放进 async 函数里 —— 本目录不支持顶层 await'
    ).toEqual([]);
  });
});
