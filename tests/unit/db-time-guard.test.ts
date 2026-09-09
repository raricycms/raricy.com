// ─────────────────────────────────────────────────────────────────────────────
// db-time-guard.test.ts —— 静态检查：库内时间戳只准用「同一把钟」读写与展示
//
// 【为什么要有】本库时间戳的语义是「UTC+8 墙上时间，贴 Z 标签」（见 src/lib/db-time.ts
// 的完整来龙去脉）：Flask 时代 datetime.now()（服务器 TZ=UTC+8）写 naive 时间，
// normalize 只补 'T'/'Z' 不平移。于是：
//   • nowForDb() = Date.now() + 8h          ← 与全库历史数据同钟，**唯一合法的当前时刻**
//   • new Date() = 真实 UTC 瞬间             ← 与库内语义差 8 小时
// 两把钟混用的后果全是静默的：禁言到期后仍显示「禁言中」8 小时（ban-history 路由修过的
// 真 bug）、当日发文计数跨日错位（countBlogsToday 修过的同类 bug）、签到区间判定失效、
// 流水时间倒序错乱、崩溃后 sync-retry 宽限期变成 8 小时（replayPendingSyncs 修过的 bug）。
//
// 这种错 tsc 管不着、构建不报、多数单测（不冻时钟/不跨 8h 边界）也测不出来 ——
// 只能钉成静态检查，把「口头约定」变成「会报错的契约」。
//
// 【五条规则】
//   1. 无参 new Date()              服务端取「当前时刻」必须走 nowForDb()（带参的是构造，不在此列）
//   2. new Date(Date.now(...))      同上，只是套了层壳 —— 仍然是真实 UTC 瞬间
//   3. 库内时间戳与 Date.now() 相减  两把钟相减恒差 8 小时；「还剩多久」走 hoursUntil()
//   4. toLocale*                    按运行机器时区再平移一次（浏览器/服务器不在 UTC+8 就错）
//   5. 本地 getter（getHours 等）    读墙上时间必须用 getUTC*（getTime 与时区无关，不在此列）
//
// 【范围】1–3 扫会写库 / 比对库内时间的服务端代码：src/lib、src/app/api、src/middleware.ts、
// tests/helpers。**不含** src/app 页面组件 —— 客户端计时器、相对时间显示等用 new Date()
// 与库内时钟无关，属合法用途。4–5 扫整个 src/（展示层），因为凡是渲染库内时间戳的地方，
// 本地时区 API 一定会把墙上时间平移一次。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** 规则 1–3 的服务端扫描范围。 */
const SERVER_DIRS = ['src/lib', 'src/app/api', 'tests/helpers'];
const SERVER_FILES = ['src/middleware.ts'];
/** 唯一的合法「当前时刻」来源 —— 它自己用 Date.now() 构造，不含 new Date()。 */
const WHITELIST = [path.join('src', 'lib', 'db-time.ts')];

/** 规则 4–5 的展示层扫描范围。 */
const SRC_DIR = 'src';
/**
 * toLocale* 的唯一豁免：cattca 的时间戳写进 localStorage 用的是 `new Date().toISOString()`
 * （真实时刻），读回来再 toLocaleString 是自洽的，与库内墙上时间无关。
 */
const LOCALE_WHITELIST = [path.join('src', 'app', 'tool', 'cattca', 'page.tsx')];

// 规则正则（带 g，供 matchAll 使用）
const RE_ARGLESS_NEW_DATE = /new\s+Date\s*\(\s*\)/g;
const RE_NEW_DATE_NOW = /new\s+Date\s*\(\s*Date\.now\s*\(/g;
const RE_MIXED_SUBTRACTION = /\.getTime\(\)\s*-\s*Date\.now\(\)|Date\.now\(\)\s*-\s*[\w.$]+\.getTime\(\)/g;
const RE_TO_LOCALE = /toLocale(String|DateString|TimeString|Format)/g;
const RE_LOCAL_GETTER = /\.get(Hours|Date|Month|Day|FullYear|Minutes|Seconds)\(/g;

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 去掉行注释 / 块注释，避免把「文档里提到 new Date()」误判为代码。
 * 块注释替换成等长空白（保留换行），这样报出来的行号不漂。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

interface ScanSpec {
  roots: string[];
  files?: string[];
  whitelist?: string[];
  re: RegExp;
}

/** 在指定范围内扫描违规写法，返回 `相对路径:行号` 列表。 */
function scan(spec: ScanSpec): string[] {
  const targets = [
    ...spec.roots
      .filter((d) => fs.existsSync(path.join(ROOT, d)))
      .flatMap((d) => collectFiles(path.join(ROOT, d))),
    ...(spec.files ?? []).map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
  ];
  const whitelist = (spec.whitelist ?? []).map((w) => w.replace(/\\/g, '/'));
  const bad: string[] = [];
  for (const file of targets) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (whitelist.includes(rel)) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(spec.re)) {
      const line = code.slice(0, m.index ?? 0).split('\n').length;
      bad.push(`${rel}:${line}`);
    }
  }
  return bad;
}

const serverSpec = (re: RegExp, whitelist: string[] = WHITELIST): ScanSpec => ({
  roots: SERVER_DIRS,
  files: SERVER_FILES,
  whitelist,
  re,
});

const displaySpec = (re: RegExp, whitelist: string[] = []): ScanSpec => ({
  roots: [SRC_DIR],
  whitelist,
  re,
});

describe('db-time 静态守卫：库内时间戳只准用同一把钟', () => {
  it('自检：扫描范围确实覆盖到了服务端与展示层代码（别因目录改名而空过）', () => {
    const serverTargets = [
      ...SERVER_DIRS.flatMap((d) => collectFiles(path.join(ROOT, d))),
      ...SERVER_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
    ];
    expect(serverTargets.length).toBeGreaterThan(30);
    expect(collectFiles(path.join(ROOT, SRC_DIR)).length).toBeGreaterThan(100);
    // db-time.ts 必须存在且在白名单里 —— 守卫的意义全靠这把统一的钟
    expect(fs.existsSync(path.join(ROOT, 'src/lib/db-time.ts'))).toBe(true);
    expect(WHITELIST.map((w) => w.replace(/\\/g, '/'))).toContain('src/lib/db-time.ts');
  });

  it('自检：五条规则的正则都能命中目标写法（正则写废了会静默空过）', () => {
    const samples: [string, RegExp, string][] = [
      ['1', RE_ARGLESS_NEW_DATE, 'const now = new Date();'],
      ['2', RE_NEW_DATE_NOW, 'const cutoff = new Date(Date.now() - 60000);'],
      ['3', RE_MIXED_SUBTRACTION, 'const h = (d.getTime() - Date.now()) / 3600000;'],
      ['3', RE_MIXED_SUBTRACTION, 'const h = (Date.now() - d.getTime()) / 3600000;'],
      ['4', RE_TO_LOCALE, 'const s = d.toLocaleString();'],
      ['5', RE_LOCAL_GETTER, 'const h = d.getHours();'],
    ];
    for (const [no, re, sample] of samples) {
      expect(sample.match(re), `规则 ${no} 未命中样例：${sample}`).not.toBeNull();
    }
  });

  it('规则 1：无参 new Date() 出现次数为 0（取当前时刻一律走 nowForDb()）', () => {
    const bad = scan(serverSpec(RE_ARGLESS_NEW_DATE));
    expect(
      bad,
      '以下位置用无参 new Date() 取当前时刻 —— 与库内「UTC+8 墙上时间」语义差 8 小时，' +
        `请改用 nowForDb()（src/lib/db-time.ts）：\n${bad.join('\n')}`
    ).toEqual([]);
  });

  it('规则 2：new Date(Date.now(...)) 出现次数为 0（同样是与库内时间差 8h 的当前时刻）', () => {
    const bad = scan(serverSpec(RE_NEW_DATE_NOW));
    expect(
      bad,
      '以下位置用 new Date(Date.now(...)) 取当前时刻 —— 与库内语义差 8 小时，' +
        `请改用 nowForDb()：\n${bad.join('\n')}`
    ).toEqual([]);
  });

  it('规则 3：库内时间戳与 Date.now() 相减为 0（两把钟相减恒差 8 小时）', () => {
    const bad = scan(displaySpec(RE_MIXED_SUBTRACTION));
    expect(
      bad,
      '以下位置把库内时间戳与真实 Date.now() 相减 —— 结果是真实剩余时间 + 8 小时，' +
        `请改用 hoursUntil()（src/lib/db-time.ts）：\n${bad.join('\n')}`
    ).toEqual([]);
  });

  it('规则 4：src/ 下无 toLocale*（会被运行机器时区再平移一次）', () => {
    const bad = scan(displaySpec(RE_TO_LOCALE, LOCALE_WHITELIST));
    expect(
      bad,
      '以下位置用 toLocale* 格式化库内时间戳 —— 会按浏览器/服务器时区再平移一次，' +
        `请改用 ymd/ymdhms（src/lib/format.ts）或 getUTC*：\n${bad.join('\n')}`
    ).toEqual([]);
  });

  it('规则 5：src/ 下无本地 getter（读墙上时间必须用 getUTC*）', () => {
    const bad = scan(displaySpec(RE_LOCAL_GETTER));
    expect(
      bad,
      '以下位置用本地 getter 读库内时间戳 —— 会按运行环境时区平移，' +
        `请改用 getUTC*（对齐 src/app/chat/ChatMessageItem.tsx）：\n${bad.join('\n')}`
    ).toEqual([]);
  });
});
