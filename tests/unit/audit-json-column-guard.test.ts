// ─────────────────────────────────────────────────────────────────────────────
// audit-json-column-guard.test.ts —— 静态检查：`admin_action_logs` 的读写必须绕开 `extra` 的 JSON 列
//
// 【为什么要有】`admin_action_logs.extra` 在**真实库里声明类型是 JSON**（legacy 形态，
// dev.db 与生产 db.db 都是；`0_init` 生成的测试模板库是 TEXT）。而 `schema.prisma` 把它
// 映射成 `String?`，于是 Prisma 驱动层在**回读这一列**时会抛：
//
//     Inconsistent column data: Conversion failed: Value JSON not supported   (P2023)
//
// 两条触发路径，都不会被 tsc / 构建 / 现有单测发现：
//   1. 读：`findMany` / `findFirst` 不带 `select`（或 select 里写了 extra）
//      → audit-service 早就知道，靠 raw `CAST(extra AS TEXT)` 绕开，注释里写明了；
//   2. **写：`create` 不带 `select`** → Prisma 默认回读整行，同样炸。
//      这一条被漏了：每日一言审核的 `reviewQuote` 就是这么写的，于是「管理员审核一言」
//      每次点「通过 / 永久拒绝 / 下架」都 500，事务整体回滚、稿件状态一点没变。
//      2026-10 用户报的正是这个 bug。
//
// 【为什么测试抓不到】vitest 与 Playwright 的库都是 `tests/.tmp/template.db`（由 schema
// 生成，extra 是 TEXT）。在那种库上 `create` 有没有 `select` 都能过 —— 缺陷只在真库上存在。
// 所以这条错误**在 CI 里永远是绿的**，只能靠静态守卫钉住。
//
// 【判据】扫 `src/` 与 `scripts/cli/commands/`，找 `adminActionLog.create(` 调用，
// 断言同一个调用的参数对象里有 `select:`。`createMany` 不回读、不在此列。
//
// 新增写入点是很容易再犯的：`logAdminAction`（admin-user-service）与
// `changeArchive`（user-archive-service）都各自带着 `select: { id: true }` 和
// 「不回读 extra」的注释 —— 别把那些 select 当成多余而删掉。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCAN_ROOTS = [path.join(ROOT, 'src'), path.join(ROOT, 'scripts', 'cli', 'commands')];

/** 调用点可以显式豁免，但要写明理由（当前没有）。 */
const ALLOWLIST = new Map<string, string>([]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 去掉行注释与块注释（块注释换成等长空白，保留换行，行号不漂）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * 从 `(` 开始按括号配对，取出一次调用的实参文本。
 * 字符串字面量里的括号不会出现在这些调用里（都是对象字面量），但 `{}` / `[]` 必须一起配对，
 * 否则 `{ data: {...} }` 的嵌套结构会被提前截断。
 */
function callArguments(code: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return code.slice(openParen + 1, i);
    }
  }
  return code.slice(openParen + 1);
}

interface Violation {
  where: string;
  snippet: string;
}

function findUnselectedCreates(): Violation[] {
  const bad: Violation[] = [];
  const re = /\.\s*adminActionLog\s*\.\s*create\s*\(/g;
  for (const file of SCAN_ROOTS.flatMap((d) => sourceFiles(d))) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWLIST.has(rel)) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of code.matchAll(re)) {
      const openParen = (match.index ?? 0) + match[0].length - 1;
      const args = callArguments(code, openParen);
      // 同一次调用里必须出现 `select:` —— 缺了就是「写完回读整行」，会在真库上抛 P2023。
      if (!/\bselect\s*:/.test(args)) {
        const line = code.slice(0, match.index ?? 0).split('\n').length;
        bad.push({ where: `${rel}:${line}`, snippet: args.trim().slice(0, 120) });
      }
    }
  }
  return bad;
}

describe('审计日志 JSON 列守卫：adminActionLog 读写必须绕开 extra', () => {
  it('自检：扫描范围确实覆盖到了所有写入点（别因目录改名而空过）', () => {
    const files = SCAN_ROOTS.flatMap((d) => sourceFiles(d));
    expect(files.length).toBeGreaterThan(100);
    const creaters = files.filter((f) => stripComments(fs.readFileSync(f, 'utf8')).includes('.adminActionLog'));
    // 现在恰好 3 个写入点在 src/ 下，另有读点在 audit-service
    expect(creaters.length).toBeGreaterThanOrEqual(3);
  });

  it('自检：括号配对与判据能识别「有 select」与「没 select」两种写法', () => {
    // 有 select：不应报
    const good = 'await tx.adminActionLog.create({ data: { action: x } }, select: { id: true } });';
    const goodArgs = callArguments(good, good.indexOf('('));
    expect(/\bselect\s*:/.test(goodArgs)).toBe(true);
    // 嵌套对象 + 没有 select：应报
    const bad = "await tx.adminActionLog.create({ data: { action: 'a', extra: null } });";
    const badArgs = callArguments(bad, bad.indexOf('('));
    expect(/\bselect\s*:/.test(badArgs)).toBe(false);
  });

  it('每个 adminActionLog.create 都带 select（否则真库上回读 JSON 列会抛 P2023）', () => {
    const bad = findUnselectedCreates();
    expect(
      bad,
      '以下位置调用 adminActionLog.create 时没有 `select:` —— Prisma 会回读整行，' +
        '而 `extra` 在真实库里是 JSON 声明列，驱动层转换会抛 ' +
        '"Conversion failed: Value JSON not supported"（P2023），整个事务回滚。' +
        `加一个 select: { id: true }（写 metadata 的地方照 logAdminAction 走 raw UPDATE）：\n${bad
          .map((b) => `${b.where}  ${b.snippet}`)
          .join('\n')}`
    ).toEqual([]);
  });
});
