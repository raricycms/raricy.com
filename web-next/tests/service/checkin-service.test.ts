// checkin-service.ts —— 每日签到（UTC+8 跨日 + 唯一约束 + 发鱼干 + 运势）。
//
// 【为什么这些用例值得存在】
// 1. **时区**：签到日是「UTC+8 墙上日期」，而服务器/CI 的 TZ 不确定。跨日边界算错，
//    用户在 UTC+8 23:59 签一次、00:01 又能签一次（或反过来白丢一天）。这类 bug 在
//    非边界时刻跑测试永远绿。故本文件用 vi.setSystemTime 把时钟钉死在边界上。
// 2. **唯一约束**：一天一次是靠 DB 的 uq(user_id, checkin_date) 兜底，不是靠先查后插
//    （那是 TOCTOU）。并发/重复提交必须只发一次鱼干。
// 3. **发鱼干**：这是钱。签到成功 → 余额、流水、totalFortune 三者必须同进同退。
//
// 【存储形态】规整后库里时间戳是 INTEGER（Unix 毫秒），不是 TEXT。造历史夹具时用
// new Date(iso).getTime() 插入；也不要在 $queryRaw 里对时间列用 date()/strftime()
// （对 INTEGER 恒返回 NULL）。语义见 src/lib/db-time.ts：数字 = UTC+8 墙上时间贴 Z 标签。
//
// 【与 Flask 的已知差异】Flask 是两步（check_in 建记录 fortune_value=NULL →
// claim_fortune 翻牌赋值），Next 本切片合并为一步，故不存在 fortune_pending 中间态。
// 下面「运势」一节显式钉住这个语义差异。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  todayUtc8,
  fortuneLabel,
  doCheckin,
  getTodayStatus,
  getCountLeaderboard,
  getFortuneLeaderboard,
} from '@/lib/checkin-service';
import { getTodayCheckinFish } from '@/lib/fish-service';
import { resetDb, makeUser, prisma } from '../helpers/db';

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 把时钟钉死在某个 **UTC 瞬间**。
 * 只 fake Date —— 不能 fake setTimeout/Promise 等，否则 Prisma 的异步 I/O 会挂死。
 */
function freezeUtc(iso: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

/** 该 UTC+8 墙上日期的零点（贴 Z 标签）—— 与被测 dateAtDay 同口径。 */
const dayAt = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

/**
 * 插一条「迁移来的历史签到」。
 * 存储形态必须与 scripts/normalize-datetimes.mjs 的产物一致：**INTEGER（Unix 毫秒）**。
 * 若写 ISO 字符串，Prisma 的日期比较会按 SQLite 类型序（TEXT > INTEGER）而非数值走。
 */
async function makeLegacyCheckin(userId: string, ymd: string, fortune: number, pool: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO daily_checkins (user_id, checkin_date, created_at, fortune_value, fortune_pool)
     VALUES (?, ?, ?, ?, ?)`,
    userId,
    dayAt(ymd).getTime(),
    new Date(`${ymd}T09:30:00.000Z`).getTime(),
    fortune,
    pool
  );
}

// ── todayUtc8 / dateAtDay：UTC+8 跨日边界 ────────────────────────────────────
//
// UTC+8 的一天在 UTC 时间轴上是 [前一日 16:00Z, 当日 16:00Z)。
// 因此 UTC 15:59:59 = UTC+8 23:59:59（今天），UTC 16:00:00 = UTC+8 次日 00:00（明天）。

describe('todayUtc8（UTC+8 跨日边界）', () => {
  it('UTC 15:59:59（= UTC+8 当日 23:59:59）仍算当天', () => {
    freezeUtc('2026-07-15T15:59:59.999Z');
    expect(todayUtc8(), 'UTC+8 还没到零点，签到日不能翻页').toBe('2026-07-15');
  });

  it('UTC 16:00:00（= UTC+8 次日 00:00:00）翻到次日', () => {
    freezeUtc('2026-07-15T16:00:00.000Z');
    expect(todayUtc8(), 'UTC+8 已跨零点，签到日必须 +1').toBe('2026-07-16');
  });

  it('UTC 00:00（= UTC+8 当日 08:00）仍是同一 UTC 日期', () => {
    freezeUtc('2026-07-15T00:00:00.000Z');
    expect(todayUtc8()).toBe('2026-07-15');
  });

  it('跨月边界：UTC 07-31 16:00 → 08-01', () => {
    freezeUtc('2026-07-31T16:00:00.000Z');
    expect(todayUtc8(), '月末不能算错').toBe('2026-08-01');
  });

  it('跨年边界：UTC 12-31 16:00 → 次年 01-01', () => {
    freezeUtc('2026-12-31T16:00:00.000Z');
    expect(todayUtc8(), '跨年不能算错').toBe('2027-01-01');
  });

  it('闰年 2-29 存在：UTC 2028-02-28 16:00 → 2028-02-29', () => {
    freezeUtc('2028-02-28T16:00:00.000Z');
    expect(todayUtc8()).toBe('2028-02-29');
  });

  it('todayUtc8 只依赖 Date.now()，不受本机 TZ 影响（同一瞬间恒定）', () => {
    freezeUtc('2026-07-15T16:00:00.000Z');
    const a = todayUtc8();
    const b = todayUtc8();
    expect(a, '同一冻结瞬间两次调用必须一致').toBe(b);
    expect(a).toBe('2026-07-16');
  });
});

describe('checkinDate 的落库形态', () => {
  it('存的是「UTC+8 墙上日期的零点 Z」，且 SQLite 侧类型为 INTEGER', async () => {
    freezeUtc('2026-07-15T16:30:00.000Z'); // UTC+8 = 07-16 00:30
    const u = await makeUser();
    await doCheckin(u.id);

    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(
      row.checkinDate.toISOString(),
      'UTC+8 已是 07-16，签到日必须落 07-16 而非 07-15'
    ).toBe('2026-07-16T00:00:00.000Z');

    const [probe] = await prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT typeof(checkin_date) t FROM daily_checkins LIMIT 1`
    );
    expect(probe.t, 'Prisma 写 DateTime → INTEGER 毫秒；混入 TEXT 会让日期比较按类型序走').toBe(
      'integer'
    );
  });

  it('能读到「迁移来的历史行」（同为 INTEGER 存储）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z'); // UTC+8 = 07-15 12:00
    const u = await makeUser();
    await makeLegacyCheckin(u.id, '2026-07-15', 4, '4,1,5,2,3');

    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '老数据的今日签到必须被识别，否则用户能重复签').toBe(true);
    expect(st.fortuneValue).toBe(4);
    expect(st.fortunePool).toEqual([4, 1, 5, 2, 3]);
  });
});

describe('跨日签到（边界两侧属于不同签到日）', () => {
  it('UTC 15:59 签一次、16:00 再签一次 —— 两次都成功，落 2 天记录', async () => {
    const u = await makeUser();

    freezeUtc('2026-07-15T15:59:59.000Z'); // UTC+8 07-15 23:59:59
    const r1 = await doCheckin(u.id);
    expect(r1.alreadyChecked, '当天首签必须成功').toBe(false);

    freezeUtc('2026-07-15T16:00:00.000Z'); // UTC+8 07-16 00:00:00
    const r2 = await doCheckin(u.id);
    expect(r2.alreadyChecked, '跨过 UTC+8 零点即为新的一天，必须允许再签').toBe(false);

    const dates = (
      await prisma.dailyCheckIn.findMany({ where: { userId: u.id }, orderBy: { checkinDate: 'asc' } })
    ).map((r) => r.checkinDate.toISOString().slice(0, 10));
    expect(dates, '1 秒之隔却分属两天').toEqual(['2026-07-15', '2026-07-16']);
    expect((r2 as { totalCount: number }).totalCount).toBe(2);
  });

  it('UTC 16:00 与同一 UTC+8 日的 15:59（次日 UTC）之间不能再签', async () => {
    const u = await makeUser();

    freezeUtc('2026-07-15T16:00:00.000Z'); // UTC+8 07-16 00:00
    const r1 = await doCheckin(u.id);
    expect(r1.alreadyChecked).toBe(false);

    freezeUtc('2026-07-16T15:59:00.000Z'); // UTC+8 07-16 23:59 —— 仍是同一签到日
    const r2 = await doCheckin(u.id);
    expect(r2.alreadyChecked, 'UTC 日期变了但 UTC+8 还是同一天 → 必须拒绝').toBe(true);

    expect(await prisma.dailyCheckIn.count({ where: { userId: u.id } })).toBe(1);
  });

  it('UTC 15:59 与 UTC 16:00 的 getTodayStatus 分属不同签到日', async () => {
    const u = await makeUser();

    freezeUtc('2026-07-15T15:59:00.000Z');
    await doCheckin(u.id);
    expect((await getTodayStatus(u.id)).checkedIn).toBe(true);

    freezeUtc('2026-07-15T16:00:00.000Z');
    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '新的一天必须回到「未签到」').toBe(false);
    expect(st.today).toBe('2026-07-16');
    expect(st.totalCount, '累计天数不清零').toBe(1);
    expect(st.fortuneValue, '新的一天没有运势值').toBeNull();
    expect(st.fortunePool).toBeNull();
  });
});

// ── 唯一约束：一天只能签一次 ─────────────────────────────────────────────────

describe('唯一约束防重复签到', () => {
  it('同日二次签到被拒，返回「今天已签到」+ 当日状态', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();

    const r1 = await doCheckin(u.id, 0);
    expect(r1.alreadyChecked).toBe(false);

    const r2 = await doCheckin(u.id, 1);
    expect(r2.alreadyChecked, '同一 UTC+8 日的第二次必须被唯一约束拦下').toBe(true);
    expect((r2 as { message: string }).message).toBe('今天已签到');
    const st = (r2 as { status: Awaited<ReturnType<typeof getTodayStatus>> }).status;
    expect(st.checkedIn).toBe(true);
    expect(st.fortuneValue, '返回的是首签已定的运势，不是第二次想翻的牌').toBe(
      (r1 as { fortuneValue: number }).fortuneValue
    );
  });

  it('★ 被拒的二次签到不发鱼干、不写流水、不累加 totalFortune（整体回滚）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });

    const r1 = (await doCheckin(u.id)) as { fortuneValue: number };
    const balAfter1 = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { driedFish: true, totalFortune: true },
    });

    await doCheckin(u.id);
    await doCheckin(u.id);

    const balAfter3 = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { driedFish: true, totalFortune: true },
    });
    expect(balAfter3.driedFish, '重复签到刷鱼干 = 直接的资产漏洞').toBe(balAfter1.driedFish);
    expect(balAfter3.totalFortune, 'totalFortune 也不能被重复累加').toBe(balAfter1.totalFortune);
    expect(balAfter3.driedFish).toBe(r1.fortuneValue);
    expect(
      await prisma.fishTransaction.count({ where: { userId: u.id, type: 'checkin' } }),
      '一天只能有一条签到流水'
    ).toBe(1);
    expect(await prisma.dailyCheckIn.count({ where: { userId: u.id } })).toBe(1);
  });

  it('★ 并发签到（Promise.all × 5）只成功一次、只发一次鱼', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        doCheckin(u.id).catch((e) => ({ thrown: String(e) }) as const)
      )
    );

    const succeeded = results.filter((r) => 'alreadyChecked' in r && r.alreadyChecked === false);
    const thrown = results.filter((r) => 'thrown' in r);

    // DB 是唯一事实来源：无论并发下各请求返回什么，落库必须只有一条。
    const records = await prisma.dailyCheckIn.findMany({ where: { userId: u.id } });
    const txs = await prisma.fishTransaction.findMany({ where: { userId: u.id, type: 'checkin' } });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { driedFish: true, totalFortune: true },
    });

    expect(records, `并发下签到记录必须恰好 1 条（实测 ${records.length}）`).toHaveLength(1);
    expect(txs, `并发下签到流水必须恰好 1 条（实测 ${txs.length}）`).toHaveLength(1);
    expect(user.driedFish, '余额 = 那一次的运势值，多发即为资产损失').toBe(records[0].fortuneValue);
    expect(user.totalFortune, 'totalFortune 不能被并发多加').toBe(records[0].fortuneValue);
    expect(
      succeeded.length,
      `最多只能有一个请求自认为「签到成功」（实测 ${succeeded.length}；抛错 ${thrown.length} 个）`
    ).toBeLessThanOrEqual(1);
  });

  it('不同用户同一天互不影响（唯一约束是 (userId, checkinDate) 复合键）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const a = await makeUser();
    const b = await makeUser();

    expect((await doCheckin(a.id)).alreadyChecked).toBe(false);
    expect((await doCheckin(b.id)).alreadyChecked, '别人签过不影响我').toBe(false);
    expect(await prisma.dailyCheckIn.count()).toBe(2);
  });

  it('已有「迁移来的历史今日签到」时，Next 侧再签会被同一约束拦下', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    await makeLegacyCheckin(u.id, '2026-07-15', 3, '3,1,5,2,4');

    const r = await doCheckin(u.id);
    expect(r.alreadyChecked, '老数据与新写入必须共用同一个签到日键，否则切换当天人人可双签').toBe(
      true
    );
    expect(await prisma.dailyCheckIn.count({ where: { userId: u.id } })).toBe(1);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      driedFish: 0,
    });
  });
});

// ── 发鱼干 ──────────────────────────────────────────────────────────────────

describe('签到发鱼干', () => {
  it('余额增加 fortuneValue，且落一条 type=checkin 的流水', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 10 });

    const r = (await doCheckin(u.id)) as { fortuneValue: number; driedFish: number };

    expect(r.driedFish, `10 + ${r.fortuneValue}`).toBe(10 + r.fortuneValue);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      driedFish: 10 + r.fortuneValue,
    });

    const txs = await prisma.fishTransaction.findMany({ where: { userId: u.id } });
    expect(txs, '一次签到只能有一条流水').toHaveLength(1);
    expect(txs[0]).toMatchObject({
      amount: r.fortuneValue,
      type: 'checkin',
      description: `每日签到（运势值 ${r.fortuneValue}）`,
    });
  });

  it('★ 流水 createdAt 非 NULL（NULL 会让流水倒序与今日签到判定全失效）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await doCheckin(u.id);

    const tx = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: u.id } });
    expect(tx.createdAt, 'FishTransaction.createdAt 无 @default(now())，漏写就是 NULL').not.toBeNull();
  });

  it('★ 签到写的流水能被 getTodayCheckinFish 读回（两侧 UTC+8 口径必须一致）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z'); // UTC+8 07-15 12:00
    const u = await makeUser();
    const r = (await doCheckin(u.id)) as { fortuneValue: number };

    expect(
      await getTodayCheckinFish(u.id),
      'checkin-service 与 fish-service 若「今天」口径不一致，页面会显示今日 0 鱼'
    ).toBe(r.fortuneValue);
  });

  it('★ UTC+8 深夜（UTC 16:05 = UTC+8 次日 00:05）签到，今日鱼数仍能读回', async () => {
    // 这是最容易翻车的时刻：库里时间戳语义是「UTC+8 墙上时间贴 Z」，
    // 若某一侧误按真实 UTC 取区间，这里会差 8 小时 → 恒为 0。
    freezeUtc('2026-07-15T16:05:00.000Z');
    const u = await makeUser();
    const r = (await doCheckin(u.id)) as { fortuneValue: number };

    expect(todayUtc8()).toBe('2026-07-16');
    expect(await getTodayCheckinFish(u.id), '跨日零点后立即签到，今日鱼数不能是 0').toBe(
      r.fortuneValue
    );
  });

  it('用户不存在时不留下任何签到记录/流水（整个事务失败）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    await expect(doCheckin('ghost'), '外键 + addFish 都该拒绝').rejects.toThrow();
    expect(await prisma.dailyCheckIn.count(), '不能留下孤儿签到记录').toBe(0);
    expect(await prisma.fishTransaction.count(), '不能留下孤儿流水').toBe(0);
  });

  it('多天签到线性累积余额与流水', async () => {
    const u = await makeUser({ driedFish: 0 });
    let sum = 0;
    for (const d of ['2026-07-13', '2026-07-14', '2026-07-15']) {
      freezeUtc(`${d}T04:00:00.000Z`);
      const r = (await doCheckin(u.id)) as { fortuneValue: number };
      sum += r.fortuneValue;
    }
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      driedFish: sum,
      totalFortune: sum,
    });
    expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(3);
  });
});

// ── 运势 ────────────────────────────────────────────────────────────────────

describe('运势：抽取范围与牌池', () => {
  it('fortuneValue 恒在 1-5，pool 恒是 1-5 的一个排列', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    // 单次随机说明不了问题 —— 跑 30 个用户看分布与不变量。
    for (let i = 0; i < 30; i++) {
      await resetDb();
      const u = await makeUser();
      const r = (await doCheckin(u.id)) as { fortuneValue: number; pool: number[] };
      expect([...r.pool].sort(), `pool 必须是 1-5 各一张（实测 ${r.pool}）`).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(r.fortuneValue).toBeGreaterThanOrEqual(1);
      expect(r.fortuneValue).toBeLessThanOrEqual(5);
      expect(r.pool, '翻出的值必须来自牌池').toContain(r.fortuneValue);
    }
  });

  it('fortunePool 以 "a,b,c,d,e" 字符串落库，getTodayStatus 解析回数组', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    const r = (await doCheckin(u.id)) as { pool: number[] };

    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.fortunePool, '落库形态必须与 Flask 一致（逗号分隔字符串）').toBe(r.pool.join(','));
    expect((await getTodayStatus(u.id)).fortunePool).toEqual(r.pool);
  });

  it('chosenIndex 0-4 精确决定翻出哪张牌', async () => {
    for (let idx = 0; idx < 5; idx++) {
      await resetDb();
      freezeUtc('2026-07-15T04:00:00.000Z');
      const u = await makeUser();
      const r = (await doCheckin(u.id, idx)) as {
        fortuneValue: number;
        pool: number[];
        chosenIndex: number;
      };
      expect(r.chosenIndex, '用户选了第几张就得是第几张').toBe(idx);
      expect(r.fortuneValue, `pool[${idx}] = ${r.pool[idx]}`).toBe(r.pool[idx]);
    }
  });

  it('落库的 fortuneValue 与返回值一致（不能返回一张、存另一张）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    const r = (await doCheckin(u.id, 2)) as { fortuneValue: number };
    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.fortuneValue).toBe(r.fortuneValue);
  });

  it('⚠️ 越界 chosenIndex（-1 / 5 / 99 / NaN）不报错，静默降级为随机翻牌', async () => {
    // 现状记录，非「正确性」断言：Flask claim_fortune 对越界 index 返回
    // {'success': False, 'message': '无效的选择'}，Next 这里静默随机。见交付说明。
    for (const bad of [-1, 5, 99, NaN]) {
      await resetDb();
      freezeUtc('2026-07-15T04:00:00.000Z');
      const u = await makeUser();
      const r = (await doCheckin(u.id, bad)) as { fortuneValue: number; chosenIndex: number };
      expect(r.chosenIndex, `chosenIndex=${bad} 被换成了合法随机 index`).toBeGreaterThanOrEqual(0);
      expect(r.chosenIndex).toBeLessThan(5);
      expect(r.fortuneValue).toBeGreaterThanOrEqual(1);
      expect(r.fortuneValue).toBeLessThanOrEqual(5);
    }
  });

  it('chosenIndex 缺省时随机翻牌，结果仍合法', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    const r = (await doCheckin(u.id)) as { fortuneValue: number; pool: number[] };
    expect(r.pool).toContain(r.fortuneValue);
  });
});

describe('运势：totalFortune 累计', () => {
  it('每天累加当日 fortuneValue，与流水/余额三者一致', async () => {
    const u = await makeUser({ driedFish: 0 });
    let expected = 0;
    for (const d of ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']) {
      freezeUtc(`${d}T04:00:00.000Z`);
      const r = (await doCheckin(u.id, 0)) as { fortuneValue: number; totalFortune: number };
      expected += r.fortuneValue;
      expect(r.totalFortune, `第 ${d} 天累计应为 ${expected}`).toBe(expected);
    }
    const st = await getTodayStatus(u.id);
    expect(st.totalFortune).toBe(expected);
    expect(st.driedFish, '签到场景下 totalFortune 与鱼干同步增长').toBe(expected);
    expect(st.totalCount).toBe(4);
  });

  it('新用户 totalFortune 初始为 0', async () => {
    const u = await makeUser();
    expect((await getTodayStatus(u.id)).totalFortune).toBe(0);
  });

  it('不串用户：A 签到不影响 B 的 totalFortune', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const a = await makeUser();
    const b = await makeUser();
    await doCheckin(a.id);
    expect((await getTodayStatus(b.id)).totalFortune).toBe(0);
    expect((await getTodayStatus(b.id)).driedFish).toBe(0);
  });
});

describe('运势：翻牌语义（与 Flask 两步流程的差异）', () => {
  it('Next 合并为一步 —— 签到后 fortuneValue 立即非 NULL，无 fortune_pending 中间态', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await doCheckin(u.id);

    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(
      row.fortuneValue,
      'Flask check_in() 建记录时 fortune_value=NULL 等待 claim_fortune()；' +
        'Next 直接赋值。若此处为 NULL，说明实现悄悄回退成了两步流程。'
    ).not.toBeNull();
    expect((await getTodayStatus(u.id)).fortuneValue).not.toBeNull();
  });

  it('迁移来的「已签到但未翻牌」老行（fortune_value=NULL）不会让状态查询崩', async () => {
    // Flask 时代真实存在这种行：签了到、没点牌。切换后必须能安全展示。
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await prisma.$executeRawUnsafe(
      `INSERT INTO daily_checkins (user_id, checkin_date, created_at, fortune_value, fortune_pool)
       VALUES (?, ?, ?, NULL, '3,1,5,2,4')`,
      u.id,
      dayAt('2026-07-15').getTime(),
      new Date('2026-07-15T09:00:00.000Z').getTime()
    );

    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '记录存在即已签到').toBe(true);
    expect(st.fortuneValue, '未翻牌 → NULL；Next 无 claim 入口，该值将永远为 NULL').toBeNull();
    expect(st.fortunePool, '牌池仍应可读').toEqual([3, 1, 5, 2, 4]);
  });

  it('fortune_pool 数据异常（格式不对/为空）时 parsePool 返回 null 而非抛错', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    for (const bad of ["'1,2,3'", "'a,b,c,d,e'", "''", 'NULL']) {
      await resetDb();
      const u = await makeUser();
      await prisma.$executeRawUnsafe(
        `INSERT INTO daily_checkins (user_id, checkin_date, created_at, fortune_value, fortune_pool)
         VALUES (?, ?, ?, 3, ${bad})`,
        u.id,
        dayAt('2026-07-15').getTime(),
        new Date('2026-07-15T09:00:00.000Z').getTime()
      );
      const st = await getTodayStatus(u.id);
      expect(st.checkedIn).toBe(true);
      expect(st.fortunePool, `pool=${bad} 应安全降级为 null（否则签到页 500）`).toBeNull();
    }
  });
});

describe('fortuneLabel', () => {
  it('1-5 各有文案', () => {
    expect([1, 2, 3, 4, 5].map(fortuneLabel)).toEqual([
      '平平淡淡也是真',
      '小有运气',
      '运势不错',
      '好运连连',
      '运势爆棚',
    ]);
  });

  it('null / undefined / 越界值返回空串，不抛错（模板里会直接渲染）', () => {
    expect(fortuneLabel(null)).toBe('');
    expect(fortuneLabel(undefined)).toBe('');
    expect(fortuneLabel(0)).toBe('');
    expect(fortuneLabel(6)).toBe('');
    expect(fortuneLabel(-1)).toBe('');
  });
});

// ── 今日状态查询 ────────────────────────────────────────────────────────────

describe('getTodayStatus', () => {
  it('未签到：checkedIn=false，运势字段全 null，today 为 UTC+8 今天', async () => {
    freezeUtc('2026-07-15T16:00:00.000Z'); // UTC+8 07-16
    const u = await makeUser({ driedFish: 3 });

    expect(await getTodayStatus(u.id)).toEqual({
      checkedIn: false,
      totalCount: 0,
      today: '2026-07-16',
      fortuneValue: null,
      fortunePool: null,
      totalFortune: 0,
      driedFish: 3,
    });
  });

  it('已签到：返回当日运势、牌池、累计天数与余额', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    await makeLegacyCheckin(u.id, '2026-07-13', 2, '2,1,3,4,5'); // 历史天数计入 totalCount
    const r = (await doCheckin(u.id, 0)) as { fortuneValue: number; pool: number[] };

    const st = await getTodayStatus(u.id);
    expect(st).toMatchObject({
      checkedIn: true,
      today: '2026-07-15',
      fortuneValue: r.fortuneValue,
      driedFish: r.fortuneValue,
    });
    expect(st.fortunePool).toEqual(r.pool);
    expect(st.totalCount, '历史 1 天 + 今天 1 天').toBe(2);
  });

  it('totalCount 统计所有历史天数，不只是今天', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) {
      await makeLegacyCheckin(u.id, d, 3, '3,1,5,2,4');
    }
    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '今天没签').toBe(false);
    expect(st.totalCount, '累计天数与今日是否签到无关').toBe(3);
  });

  it('totalCount 只数自己的（不能把别人的签到算进来）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const a = await makeUser();
    const b = await makeUser();
    await makeLegacyCheckin(b.id, '2026-07-01', 3, '3,1,5,2,4');
    await makeLegacyCheckin(b.id, '2026-07-02', 3, '3,1,5,2,4');
    expect((await getTodayStatus(a.id)).totalCount).toBe(0);
  });

  it('用户不存在时安全降级（totalFortune/driedFish 为 0，不抛错）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const st = await getTodayStatus('ghost');
    expect(st, '未知 userId 不应把签到页打成 500').toMatchObject({
      checkedIn: false,
      totalCount: 0,
      totalFortune: 0,
      driedFish: 0,
    });
  });

  it('doCheckin 返回的 totalCount/driedFish/totalFortune 与随后的 getTodayStatus 一致', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 4 });
    const r = (await doCheckin(u.id)) as {
      totalCount: number;
      driedFish: number;
      totalFortune: number;
    };
    const st = await getTodayStatus(u.id);
    expect({ c: r.totalCount, d: r.driedFish, f: r.totalFortune }).toEqual({
      c: st.totalCount,
      d: st.driedFish,
      f: st.totalFortune,
    });
  });
});

// ── 排行榜 ──────────────────────────────────────────────────────────────────

describe('getCountLeaderboard（签到天数榜）', () => {
  it('按天数降序，rank 从 1 连续递增', async () => {
    const a = await makeUser({ username: 'three' });
    const b = await makeUser({ username: 'one' });
    const c = await makeUser({ username: 'two' });
    for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) await makeLegacyCheckin(a.id, d, 3, '3,1,5,2,4');
    await makeLegacyCheckin(b.id, '2026-07-01', 3, '3,1,5,2,4');
    for (const d of ['2026-07-01', '2026-07-02']) await makeLegacyCheckin(c.id, d, 3, '3,1,5,2,4');

    const lb = await getCountLeaderboard();
    expect(lb.map((e) => e.username)).toEqual(['three', 'two', 'one']);
    expect(lb.map((e) => e.value)).toEqual([3, 2, 1]);
    expect(lb.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it('无人签到返回空数组', async () => {
    await makeUser();
    expect(await getCountLeaderboard()).toEqual([]);
  });

  it('limit 生效，取的是天数最多的前 N 名', async () => {
    for (let n = 1; n <= 4; n++) {
      const u = await makeUser({ username: `u${n}` });
      for (let d = 1; d <= n; d++) {
        await makeLegacyCheckin(u.id, `2026-07-0${d}`, 3, '3,1,5,2,4');
      }
    }
    const lb = await getCountLeaderboard(2);
    expect(lb).toHaveLength(2);
    expect(lb.map((e) => e.value)).toEqual([4, 3]);
  });

  it('返回字段收敛（rank/userId/username/avatarPath/value），不泄漏 email', async () => {
    const u = await makeUser({ username: 'solo' });
    await makeLegacyCheckin(u.id, '2026-07-01', 3, '3,1,5,2,4');
    const lb = await getCountLeaderboard();
    expect(lb[0]).toEqual({
      rank: 1,
      userId: u.id,
      username: 'solo',
      avatarPath: null,
      value: 1,
    });
  });

  it('⚠️ 天数并列时无第二排序键 —— 取舍由 SQLite 决定，结果不稳定', async () => {
    // Flask get_leaderboard 的 order_by 是 (count desc, max(created_at) asc)：
    // 并列时「更早签到的人」排前面。Next 侧丢了这个次级排序键。见交付说明。
    for (const n of ['tieA', 'tieB', 'tieC']) {
      const u = await makeUser({ username: n });
      await makeLegacyCheckin(u.id, '2026-07-01', 3, '3,1,5,2,4');
    }
    const lb = await getCountLeaderboard();
    expect(lb, '并列者一个都不能少').toHaveLength(3);
    expect(new Set(lb.map((e) => e.username))).toEqual(new Set(['tieA', 'tieB', 'tieC']));
    expect(lb.map((e) => e.rank), 'rank 按位次连续赋值（非竞赛式并列）').toEqual([1, 2, 3]);
  });
});

describe('getFortuneLeaderboard（运势榜）', () => {
  it('按 totalFortune 降序，rank 从 1 连续递增', async () => {
    await prisma.user.update({
      where: { id: (await makeUser({ username: 'low' })).id },
      data: { totalFortune: 5 },
    });
    await prisma.user.update({
      where: { id: (await makeUser({ username: 'high' })).id },
      data: { totalFortune: 50 },
    });
    await prisma.user.update({
      where: { id: (await makeUser({ username: 'mid' })).id },
      data: { totalFortune: 20 },
    });

    const lb = await getFortuneLeaderboard();
    expect(lb.map((e) => e.username)).toEqual(['high', 'mid', 'low']);
    expect(lb.map((e) => e.value)).toEqual([50, 20, 5]);
    expect(lb.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it('只收 totalFortune > 0 的用户（0 与负数都不上榜）', async () => {
    await makeUser({ username: 'zero' }); // 默认 0
    const neg = await makeUser({ username: 'neg' });
    await prisma.user.update({ where: { id: neg.id }, data: { totalFortune: -3 } });
    const pos = await makeUser({ username: 'pos' });
    await prisma.user.update({ where: { id: pos.id }, data: { totalFortune: 1 } });

    expect((await getFortuneLeaderboard()).map((e) => e.username)).toEqual(['pos']);
  });

  it('limit 生效，取运势最高的前 N 名', async () => {
    for (let i = 1; i <= 5; i++) {
      const u = await makeUser({ username: `f${i}` });
      await prisma.user.update({ where: { id: u.id }, data: { totalFortune: i * 10 } });
    }
    const lb = await getFortuneLeaderboard(2);
    expect(lb.map((e) => e.value)).toEqual([50, 40]);
  });

  it('无人有运势时返回空数组', async () => {
    await makeUser();
    expect(await getFortuneLeaderboard()).toEqual([]);
  });

  it('签到写入的 totalFortune 立即反映到运势榜（读写口径一致）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ username: 'fresh' });
    const r = (await doCheckin(u.id)) as { fortuneValue: number };
    const lb = await getFortuneLeaderboard();
    expect(lb).toHaveLength(1);
    expect(lb[0]).toMatchObject({ rank: 1, userId: u.id, value: r.fortuneValue });
  });

  it('返回字段收敛，不泄漏 email', async () => {
    const u = await makeUser({ username: 'solo' });
    await prisma.user.update({ where: { id: u.id }, data: { totalFortune: 7 } });
    expect((await getFortuneLeaderboard())[0]).toEqual({
      rank: 1,
      userId: u.id,
      username: 'solo',
      avatarPath: null,
      value: 7,
    });
  });
});

// ── 回归：DailyCheckIn.created_at ───────────────────────────────────────────
//
// Flask 侧 DailyCheckIn.created_at 有 `default=datetime.now`，字段恒有值，
// 且 get_leaderboard 用 max(created_at) 做并列次级排序键。
// Next 侧 schema 是 `createdAt DateTime?` 且**无 @default(now())**，
// doCheckin 也没显式写 —— 与 fish-service 当年的 BUG-1 完全同型。
// 下面这条如实记录现状（当前为 NULL → 用例断言的是「已发现的 bug」）。见交付说明。

describe('⚠️ DailyCheckIn.createdAt 落库情况', () => {
  it('记录现状：doCheckin 未写 createdAt（Flask 侧该字段恒有值）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await doCheckin(u.id);

    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    // 此断言故意钉住「当前是 NULL」这一事实：一旦源码补上 createdAt，本条会红，
    // 届时应把它改成 .not.toBeNull() 并删掉本注释。
    expect(
      row.createdAt,
      'DailyCheckIn.createdAt 当前落 NULL —— Flask 侧有 default=datetime.now，' +
        '且 get_leaderboard 依赖 max(created_at) 做并列排序。见交付说明。'
    ).toBeNull();
  });
});
