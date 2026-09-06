// ─────────────────────────────────────────────────────────────────────────────
// db-time-guard.test.ts —— 静态检查：服务端代码禁止用无参 new Date() 取「当前时刻」
//
// 【为什么要有】本库时间戳的语义是「UTC+8 墙上时间，贴 Z 标签」（见 src/lib/db-time.ts
// 的完整来龙去脉）：Flask 时代 datetime.now()（服务器 TZ=UTC+8）写 naive 时间，
// normalize 只补 'T'/'Z' 不平移。于是：
//   • nowForDb() = Date.now() + 8h          ← 与全库历史数据同钟，**唯一合法的当前时刻**
//   • new Date() = 真实 UTC 瞬间             ← 与库内语义差 8 小时
// 两把钟混用的后果全是静默的：禁言到期后仍显示「禁言中」8 小时（ban-history 路由
// 修过的真 bug）、当日发文计数跨日错位（countBlogsToday 修过的同类 bug）、
// 签到区间判定失效、流水时间倒序错乱。
//
// 这种错 tsc 管不着、构建不报、多数单测（不冻时钟/不跨 8h 边界）也测不出来 ——
// 只能钉成静态检查，把「口头约定」变成「会报错的契约」。
//
// 【规则】仅禁**无参** new Date()：它是「当前真实时刻」的唯一入口，必须改走
// nowForDb()。带参的 new Date(x) 是构造/解析（如 dayStart 的 `${ymd}T00:00:00.000Z`、
// banUntil = new Date(now.getTime() + …)），不在禁止之列。
//
// 【范围】会写库 / 比对库内时间的服务端代码：src/lib、src/app/api、src/middleware.ts、
// tests/helpers。**不含** src/app 页面组件 —— 客户端/展示层（游戏计时器、相对时间
// 显示等）用 new Date() 与库内时钟无关，属合法用途。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

const SCAN_DIRS = ['src/lib', 'src/app/api', 'tests/helpers'];
const SCAN_FILES = ['src/middleware.ts'];
/** 唯一的合法「当前时刻」来源 —— 它自己用 Date.now() 构造，不含 new Date()。 */
const WHITELIST = [path.join('src', 'lib', 'db-time.ts')];

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 去掉行注释 / 块注释，避免把「文档里提到 new Date()」误判为代码。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function violations(): string[] {
  const targets = [
    ...SCAN_DIRS.flatMap((d) => collectFiles(path.join(ROOT, d))),
    ...SCAN_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
  ];
  const bad: string[] = [];
  for (const file of targets) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (WHITELIST.some((w) => rel === w.replace(/\\/g, '/'))) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/new\s+Date\s*\(\s*\)/g)) {
      const line = code.slice(0, m.index ?? 0).split('\n').length;
      bad.push(`${rel}:${line}`);
    }
  }
  return bad;
}

describe('db-time 静态守卫：无参 new Date() 禁入服务端写库/比对代码', () => {
  it('自检：扫描范围确实覆盖到了服务端代码（别因目录改名而空过）', () => {
    const targets = SCAN_DIRS.flatMap((d) => collectFiles(path.join(ROOT, d)));
    expect(targets.length).toBeGreaterThan(30);
    // db-time.ts 必须存在且在白名单里 —— 守卫的意义全靠这把统一的钟
    expect(fs.existsSync(path.join(ROOT, 'src/lib/db-time.ts'))).toBe(true);
    expect(WHITELIST.map((w) => w.replace(/\\/g, '/'))).toContain('src/lib/db-time.ts');
  });

  it('无参 new Date() 出现次数为 0（取当前时刻一律走 nowForDb()）', () => {
    const bad = violations();
    expect(
      bad,
      '以下位置用无参 new Date() 取当前时刻 —— 与库内「UTC+8 墙上时间」语义差 8 小时，' +
        `请改用 nowForDb()（src/lib/db-time.ts）：\n${bad.join('\n')}`
    ).toEqual([]);
  });
});
