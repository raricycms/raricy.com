// db-time.ts —— 库内时间戳的时区约定。
//
// 【为什么需要这个约定】
// Flask 用 datetime.now() 写 naive datetime，生产服务器 TZ=UTC+8 → 库里是「UTC+8 墙上时间」。
// （服务器时区由真实数据反推证实：daily_checkins 中显式按 UTC+8 算的 checkin_date 与
//   date(created_at) 2170/2170 全等；若服务器为 UTC，UTC 16:00–23:59 的 548 条签到必然跨日不等。）
// normalize-datetimes 转换时不做时区平移，故墙上时间被原样保留。
//
// 若 Next 用 new Date()（真实 UTC 瞬间）写库，新数据就比老数据「早 8 小时」，
// 表现为：UTC+8 凌晨 00:00–07:59 发的内容在列表页显示成**前一天**。
//
// 本文件的用例守住这个约定；`grep new Date()` 那条更是防止有人无意间写回去。

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { nowForDb, todayStr, dayStart, SITE_TZ_OFFSET_MS } from '@/lib/db-time';
import { ymd } from '@/lib/format';

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

describe('与展示层自洽：写入 → 显示的日期必须和 Flask 一致', () => {
  it('UTC+8 早上 07:30 发的内容，列表页显示当天而不是前一天', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T23:30:00.000Z')); // UTC+8 = 2026-07-16 07:30

    const written = nowForDb(); // 应写入的值
    expect(
      ymd(written),
      '若写入用 new Date()（真实 UTC），这里会变成 2026-07-15 —— 比 Flask 早一天'
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

describe('约定的护栏：service 层不得用 new Date() 直接写库', () => {
  it('src/lib 下没有「写入 DateTime 列时用 new Date()」的写法', () => {
    const libDir = path.resolve(import.meta.dirname, '../../src/lib');
    const offenders: string[] = [];
    // 形如 createdAt: new Date() / updatedAt: new Date() / const now = new Date()
    const bad =
      /(?:createdAt|updatedAt|deletedAt|lastCommentAt|liftedAt|decidedAt|timestamp|lastLogin)\s*:\s*new Date\(\)|const now = new Date\(\)/;

    for (const f of fs.readdirSync(libDir)) {
      if (!f.endsWith('.ts') || f === 'db-time.ts') continue;
      const src = fs.readFileSync(path.join(libDir, f), 'utf-8');
      src.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        if (bad.test(line)) offenders.push(`${f}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      '这些地方用 new Date()（真实 UTC）写库，会与「UTC+8 墙上时间」的既有数据差 8 小时。\n' +
        '请改用 db-time.ts 的 nowForDb()。命中行：\n' +
        offenders.join('\n')
    ).toEqual([]);
  });
});
