// ─────────────────────────────────────────────────────────────────────────────
// db-time-guard.test.ts —— 静态检查：库内时间戳只准用「同一把钟」读写与展示
//
// 【为什么要有】本库时间戳的语义是「UTC+8 墙上时间，贴 Z 标签」（见 src/lib/db-time.ts
// 的完整来龙去脉）：历史实现用 datetime.now()（服务器 TZ=UTC+8）写 naive 时间，
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
// 【范围】分两档，**不是**按「服务端 / 展示层」一刀切：
//
//   · 规则 1–2 只扫会写库 / 取库内「当前时刻」的服务端代码：src/lib、src/app/api、
//     src/middleware.ts、tests/helpers。**不含** src/app 页面组件 —— 纯客户端计时器
//     用 new Date() 取「现在」与库内时钟无关，属合法用途。
//   · 规则 3–5 扫整个 src/。因为它们的错法与在哪一端无关：**凡是碰库内时间戳的地方**
//     （客户端也一样），与真实 Date.now() 相减就差 8 小时，本地时区 API 就会再平移一次。
//     注意规则 3 匹配的是 Date.now()，而 hoursUntil() 用的是 nowForDb().getTime() ——
//     正确写法天然不命中，所以它不需要白名单。
//   · 唯一的白名单是 WHITELIST（db-time.ts，规则 1–2 用）与 LOCALE_WHITELIST
//     （cattca 页，规则 4 用）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { nowForDb, todayStr, dayStart, hoursUntil, isoWithOffset, SITE_TZ_OFFSET_MS } from '@/lib/db-time';
import { ymd } from '@/lib/format';

const ROOT = path.resolve(import.meta.dirname, '../..');

/**
 * 规则 1–3 的服务端扫描范围。
 *
 * `scripts` 是 2026-09 补进来的：运维 CLI **会写库**（`fish grant`、`frame grant`、
 * 群发补偿……），按本文件开头那条判据（「会不会写库 / 取库内当前时刻」）它本来就该在
 * 范围内 —— 之前的遗漏不是决定，只是没人想起来。CLI 里展示库内时间戳要过 `ymdhms`，
 * 取「现在」要过 `nowForDb()`，与 src 侧同一条纪律。
 *
 * ⚠️ 只收 `.ts`（见 collectFiles）—— `scripts/*.mjs` 那几个（migrate / diagnose /
 *    normalize-datetimes / 各种 copy-* 构建脚本）**不在范围内**：它们要么处理迁移台账
 *    这类元数据时间戳，要么同时要理解两把钟（规整脚本），在这条规则下会有大量
 *    正当的 `new Date()`。它们的正确性靠各自的用例与人工复核，别把这条静默守卫
 *    当成已经管到它们了。
 */
const SERVER_DIRS = ['src/lib', 'src/app/api', 'tests/helpers', 'scripts'];
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

/** 在给定文件列表上扫描，返回 `相对你给的 roots 的路径:行号`。 */
function scanFiles(files: string[], whitelist: string[], re: RegExp): string[] {
  const normalizedWhitelist = whitelist.map((w) => w.replace(/\\/g, '/'));
  const bad: string[] = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (normalizedWhitelist.includes(rel)) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index ?? 0).split('\n').length;
      bad.push(`${rel}:${line}`);
    }
  }
  return bad;
}

/** 在指定范围内扫描违规写法，返回 `相对路径:行号` 列表。 */
function scan(spec: ScanSpec): string[] {
  const targets = [
    ...spec.roots
      .filter((d) => fs.existsSync(path.join(ROOT, d)))
      .flatMap((d) => collectFiles(path.join(ROOT, d))),
    ...(spec.files ?? []).map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
  ];
  return scanFiles(targets, spec.whitelist ?? [], spec.re);
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

  it('★ 黄金样本：把违规写法写进真实文件 → scan 逐条报红、注释不误报（C14 教训）', () => {
    // 上一节只证明「正则能 match 样例字符串」；这里证明**守卫的整条管线**（读文件 →
    // 去注释 → 行号 → 白名单 → 报红）真的会红。守卫自己空转是 C14 那类事故的根因。
    const dir = path.join(ROOT, 'tests', '.tmp', 'db-time-guard-sample');
    fs.mkdirSync(dir, { recursive: true });
    const badFile = path.join(dir, 'bad.ts');
    const cleanFile = path.join(dir, 'clean.ts');
    fs.writeFileSync(
      badFile,
      [
        'const a = new Date();',
        'const b = new Date(Date.now() - 1000);',
        'const c = (ts.getTime() - Date.now()) / 1000;',
        'const d = ts.toLocaleString();',
        'const e = ts.getHours();',
        '// 注释里的 new Date() 不算：',
        '// const f = new Date();',
      ].join('\n')
    );
    fs.writeFileSync(
      cleanFile,
      [
        'const a = new Date(0);', // 带参构造，合法
        'const t = ts.getTime();', // getTime 与时区无关，合法
        'const h = ts.getUTCHours();', // 展示层要用 getUTC*
        '// 注释里的 new Date() 不算',
        // ⚠️ 扫描是词法的：字符串字面量里写 `new Date()` 会真的报红（真实守卫同样如此），
        // 所以干净样本里不要出现这串字符。
        'const text = "文档里用文字描述取当前时刻的禁令";',
      ].join('\n')
    );

    const rel = (file: string) => path.relative(ROOT, file).replace(/\\/g, '/');
    try {
      expect(scanFiles([badFile], [], RE_ARGLESS_NEW_DATE)).toEqual([`${rel(badFile)}:1`]);
      expect(scanFiles([badFile], [], RE_NEW_DATE_NOW)).toEqual([`${rel(badFile)}:2`]);
      expect(scanFiles([badFile], [], RE_MIXED_SUBTRACTION)).toEqual([`${rel(badFile)}:3`]);
      expect(scanFiles([badFile], [], RE_TO_LOCALE)).toEqual([`${rel(badFile)}:4`]);
      expect(scanFiles([badFile], [], RE_LOCAL_GETTER)).toEqual([`${rel(badFile)}:5`]);

      // 干净样本对五条规则都必须是 0 命中（否则守卫会假红，最终被人关掉）
      for (const re of [
        RE_ARGLESS_NEW_DATE,
        RE_NEW_DATE_NOW,
        RE_MIXED_SUBTRACTION,
        RE_TO_LOCALE,
        RE_LOCAL_GETTER,
      ]) {
        expect(scanFiles([cleanFile], [], re)).toEqual([]);
      }
      // 白名单生效（唯一豁免机制也在这条管线上）
      expect(scanFiles([badFile], [rel(badFile)], RE_ARGLESS_NEW_DATE)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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

// ── 库内时间戳的语义与展示自洽（原 db-time.test.ts，Round4 合并）──
afterEach(() => {
  vi.useRealTimers();
});

describe('nowForDb：写库用的当前时间', () => {
  it('比真实 UTC 快 8 小时（即 UTC+8 的墙上时间）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T23:30:00.000Z')); // 真实 UTC 23:30 = UTC+8 次日 07:30
    expect(nowForDb().toISOString()).toBe('2026-07-16T07:30:00.000Z');
  });

  it('偏移量常量就是 8 小时', () => {
    expect(SITE_TZ_OFFSET_MS).toBe(8 * 3600 * 1000);
  });
});

describe('与展示层自洽：写入 → 显示的日期必须与历史数据语义一致', () => {
  it('UTC+8 早上 07:30 发的内容，列表页显示当天而不是前一天', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T23:30:00.000Z')); // UTC+8 = 2026-07-16 07:30

    const written = nowForDb(); // 应写入的值
    expect(
      ymd(written),
      '若写入用 new Date()（真实 UTC），这里会变成 2026-07-15 —— 比历史数据早一天'
    ).toBe('2026-07-16');
  });

  it('UTC+8 深夜 23:30 发的内容，显示当天', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T15:30:00.000Z')); // UTC+8 = 2026-07-16 23:30
    expect(ymd(nowForDb())).toBe('2026-07-16');
  });

  it('跨日边界：UTC 15:59:59 → UTC+8 仍是当天；UTC 16:00:00 → UTC+8 已是次日', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T15:59:59.999Z'));
    expect(todayStr()).toBe('2026-07-16');
    vi.setSystemTime(new Date('2026-07-16T16:00:00.000Z'));
    expect(todayStr(), 'UTC+8 已跨到次日 00:00').toBe('2026-07-17');
  });
});

describe('dayStart：按天取区间的起点', () => {
  it('返回该墙上日期的零点（贴 Z 标签）', () => {
    expect(dayStart('2026-07-16').toISOString()).toBe('2026-07-16T00:00:00.000Z');
  });

  it('[dayStart(d), +24h) 恰好覆盖该墙上日期的全部时刻', () => {
    const start = dayStart('2026-07-16');
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    // 当天 00:00 与 23:59:59.999 都应落在区间内
    expect(new Date('2026-07-16T00:00:00.000Z') >= start).toBe(true);
    expect(new Date('2026-07-16T23:59:59.999Z') < end).toBe(true);
    // 次日零点不在区间内
    expect(new Date('2026-07-17T00:00:00.000Z') < end).toBe(false);
  });
});

describe('hoursUntil：与库内时间戳的差（唯一合法的「还剩多久」算法）', () => {
  it('banUntil = nowForDb() + 1h → 恰好 1.0 小时', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T04:00:00.000Z')); // UTC+8 12:00
    const banUntil = new Date(nowForDb().getTime() + 3600_000);
    expect(hoursUntil(banUntil)).toBeCloseTo(1, 6);
  });

  it('已过期 → 负值', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T04:00:00.000Z'));
    const past = new Date(nowForDb().getTime() - 2 * 3600_000);
    expect(hoursUntil(past)).toBeCloseTo(-2, 6);
  });

  it('null / undefined → null', () => {
    expect(hoursUntil(null)).toBeNull();
    expect(hoursUntil(undefined)).toBeNull();
  });

  it('【回归】用真实 Date.now() 相减会把 1 小时算成 9 小时（所以必须走 hoursUntil）', () => {
    // 库内时间戳是「UTC+8 墙上时间贴 Z」，比真实 UTC 快 8 小时 —— 这条钉住两把钟的差。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T04:00:00.000Z'));
    const banUntil = new Date(nowForDb().getTime() + 3600_000);
    expect((banUntil.getTime() - Date.now()) / 3600000, '错误算法').toBeCloseTo(9, 6);
    expect(hoursUntil(banUntil), '正确算法').toBeCloseTo(1, 6);
  });
});

describe('isoWithOffset：库内时间戳给机器读的唯一出口', () => {
  it('把假的 Z 标签换成真实的 +08:00，数字原样不动', () => {
    // 库里存的是「UTC+8 墙上时间贴 Z」：作者当时看到的是 18:00
    expect(isoWithOffset(new Date('2026-07-16T18:00:00.000Z'))).toBe('2026-07-16T18:00:00.000+08:00');
  });

  it('表达的瞬间比裸 toISOString() 早 8 小时 —— 即真实时刻', () => {
    const stored = new Date('2026-07-16T18:00:00.000Z'); // 墙上 18:00 = 真实 UTC 10:00
    const correct = new Date(isoWithOffset(stored)!).getTime();
    expect(correct).toBe(stored.getTime() - SITE_TZ_OFFSET_MS);
    expect(new Date(correct).toISOString()).toBe('2026-07-16T10:00:00.000Z');
  });

  it('【回归】裸 toISOString() 会让机器以为它晚了 8 小时发布（所以必须走 isoWithOffset）', () => {
    // 方向别记反：墙上时间被当成 UTC 读，得到的是一个**更晚**的瞬间（未来）。
    // datePublished 落在未来可能让搜索引擎暂缓收录，而页面上一切正常、看不出任何症状。
    const stored = new Date('2026-07-16T18:00:00.000Z');
    const naive = new Date(stored.toISOString()).getTime();
    expect(naive, '错误算法：晚了 8 小时').toBe(new Date(isoWithOffset(stored)!).getTime() + SITE_TZ_OFFSET_MS);
    expect(naive > stored.getTime() - SITE_TZ_OFFSET_MS).toBe(true);
  });

  it('输出始终带 +08:00，绝不是裸 Z', () => {
    const out = isoWithOffset(new Date('2026-01-01T00:00:00.000Z'))!;
    expect(out.endsWith('Z')).toBe(false);
    expect(out.endsWith('+08:00')).toBe(true);
  });

  it('刻度不丢：毫秒与秒原样保留', () => {
    expect(isoWithOffset(new Date('2026-07-16T18:00:00.776Z'))).toBe('2026-07-16T18:00:00.776+08:00');
  });

  it('null / undefined / 非法日期 → null（不抛）', () => {
    expect(isoWithOffset(null)).toBeNull();
    expect(isoWithOffset(undefined)).toBeNull();
    expect(isoWithOffset(new Date('不是日期'))).toBeNull();
  });
});

// 静态护栏统一住在 tests/unit/db-time-guard.test.ts：它的规则 1 递归扫
// src/lib + src/app/api + tests/helpers + scripts 下的全部 new Date()，
// 覆盖了这里原先手写的 src/lib 顶层窄正则（那只是它的真子集）。
// 本文件只保留行为断言，不再重复一份源码扫描。
