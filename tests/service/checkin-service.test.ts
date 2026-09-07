// checkin-service.ts —— 每日签到（UTC+8 跨日 + 唯一约束 + 发鱼干 + 运势）。
//
// 【为什么这些用例值得存在】
// 1. **时区**：签到日是「UTC+8 墙上日期」，而服务器/CI 的 TZ 不确定。跨日边界算错，
//    用户在 UTC+8 23:59 签一次、00:01 又能签一次（或反过来白丢一天）。这类 bug 在
//    非边界时刻跑测试永远绿。故本文件用 vi.setSystemTime 把时钟钉死在边界上。
// 2. **唯一约束**：一天一次是靠 DB 的 uq(user_id, checkin_date) 兜底，不是靠先查后插
//    （那是 TOCTOU）。并发/重复提交必须只发一次鱼干。
// 3. **发鱼干**：这是钱。翻牌成功 → 余额、流水、totalFortune 三者必须同进同退。
//
// 【两步式语义（Flask 原始设计，本文件钉住）】checkIn() 只建记录
// （fortune_value=NULL、fortune_pool 已定）→ 用户在落库的牌池里选位置，
// claimFortune() 取 pool[chosenIndex] 赋值并发鱼。翻哪张、拿哪个值由翻牌
// 这一瞬间的选择决定 —— 而不是签到瞬间抽定后由前端演出。
//
// 【存储形态】规整后库里时间戳是 INTEGER（Unix 毫秒），不是 TEXT。造历史夹具时用
// new Date(iso).getTime() 插入；也不要在 $queryRaw 里对时间列用 date()/strftime()
// （对 INTEGER 恒返回 NULL）。语义见 src/lib/db-time.ts：数字 = UTC+8 墙上时间贴 Z 标签。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  todayUtc8,
  fortuneLabel,
  checkIn,
  claimFortune,
  getTodayStatus,
  getCountLeaderboard,
  getFortuneLeaderboard,
  type ClaimResult,
} from '@/lib/checkin-service';
import { getTodayCheckinFish } from '@/lib/fish-service';
import { fishToUnits, unitsToFish } from '@/lib/fish-units';
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

/** 插一条「已签到但未翻牌」的历史行（fortune_value NULL —— Flask 时代真实存在）。 */
async function makePendingCheckin(userId: string, ymd: string, pool: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO daily_checkins (user_id, checkin_date, created_at, fortune_value, fortune_pool)
     VALUES (?, ?, ?, NULL, ?)`,
    userId,
    dayAt(ymd).getTime(),
    new Date(`${ymd}T09:00:00.000Z`).getTime(),
    pool
  );
}

/** 两步式快捷路径：签到成功 + 翻第 chosenIndex 张。返回 claim 结果；失败即抛。 */
async function fullCheckin(userId: string, chosenIndex = 0) {
  const ci = await checkIn(userId);
  if (ci.alreadyChecked) throw new Error('test: checkIn 意外返回已签到');
  const cl = await claimFortune(userId, chosenIndex);
  if (!cl.ok) throw new Error(`test: claimFortune 失败：${cl.message}`);
  if (cl.alreadyClaimed) throw new Error('test: claimFortune 意外返回已翻过');
  return cl;
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
    await checkIn(u.id);

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
    expect(st.fortunePending, '已翻过牌 → 不是 pending').toBe(false);
    expect(st.fortunePool).toEqual([4, 1, 5, 2, 3]);
  });
});

describe('跨日签到（边界两侧属于不同签到日）', () => {
  it('UTC 15:59 签一次、16:00 再签一次 —— 两次都成功，落 2 天记录', async () => {
    const u = await makeUser();

    freezeUtc('2026-07-15T15:59:59.000Z'); // UTC+8 07-15 23:59:59
    const r1 = await checkIn(u.id);
    expect(r1.alreadyChecked, '当天首签必须成功').toBe(false);

    freezeUtc('2026-07-15T16:00:00.000Z'); // UTC+8 07-16 00:00:00
    const r2 = await checkIn(u.id);
    expect(r2.alreadyChecked, '跨过 UTC+8 零点即为新的一天，必须允许再签').toBe(false);
    if (r2.alreadyChecked) return;

    const dates = (
      await prisma.dailyCheckIn.findMany({ where: { userId: u.id }, orderBy: { checkinDate: 'asc' } })
    ).map((r) => r.checkinDate.toISOString().slice(0, 10));
    expect(dates, '1 秒之隔却分属两天').toEqual(['2026-07-15', '2026-07-16']);
    expect(r2.totalCount).toBe(2);
  });

  it('UTC 16:00 与同一 UTC+8 日的 15:59（次日 UTC）之间不能再签', async () => {
    const u = await makeUser();

    freezeUtc('2026-07-15T16:00:00.000Z'); // UTC+8 07-16 00:00
    const r1 = await checkIn(u.id);
    expect(r1.alreadyChecked).toBe(false);

    freezeUtc('2026-07-16T15:59:00.000Z'); // UTC+8 07-16 23:59 —— 仍是同一签到日
    const r2 = await checkIn(u.id);
    expect(r2.alreadyChecked, 'UTC 日期变了但 UTC+8 还是同一天 → 必须拒绝').toBe(true);

    expect(await prisma.dailyCheckIn.count({ where: { userId: u.id } })).toBe(1);
  });

  it('UTC 15:59 与 UTC 16:00 的 getTodayStatus 分属不同签到日', async () => {
    const u = await makeUser();

    freezeUtc('2026-07-15T15:59:00.000Z');
    await checkIn(u.id);
    expect((await getTodayStatus(u.id)).checkedIn).toBe(true);

    freezeUtc('2026-07-15T16:00:00.000Z');
    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '新的一天必须回到「未签到」').toBe(false);
    expect(st.today).toBe('2026-07-16');
    expect(st.totalCount, '累计天数不清零').toBe(1);
    expect(st.fortuneValue, '新的一天没有运势值').toBeNull();
    expect(st.fortunePending, '没签到 → 无 pending').toBe(false);
    expect(st.fortunePool).toBeNull();
  });
});

// ── 唯一约束：一天只能签一次 ─────────────────────────────────────────────────

describe('唯一约束防重复签到', () => {
  it('同日二次签到被拒，返回「今天已签到」+ 当日状态', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();

    const r1 = await checkIn(u.id);
    expect(r1.alreadyChecked).toBe(false);

    const r2 = await checkIn(u.id);
    expect(r2.alreadyChecked, '同一 UTC+8 日的第二次必须被唯一约束拦下').toBe(true);
    if (!r2.alreadyChecked) return;
    expect(r2.message).toBe('今天已签到');
    expect(r2.status.checkedIn).toBe(true);
    expect(
      r2.status.fortuneValue,
      '首签还没翻牌 → 运势仍为 NULL（两步式下签到与翻牌分离）'
    ).toBeNull();
    expect(r2.status.fortunePending, '首签未翻牌 → 处于待翻牌态').toBe(true);
  });

  it('★ 被拒的二次签到不加行、不发鱼、不累加 totalFortune', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });

    const cl = await fullCheckin(u.id);
    const balAfter1 = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { driedFish: true, totalFortune: true },
    });

    await checkIn(u.id);
    await checkIn(u.id);

    const balAfter3 = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { driedFish: true, totalFortune: true },
    });
    expect(balAfter3.driedFish, '重复签到刷鱼干 = 直接的资产漏洞').toBe(balAfter1.driedFish);
    expect(balAfter3.totalFortune, 'totalFortune 也不能被重复累加').toBe(balAfter1.totalFortune);
    expect(unitsToFish(balAfter3.driedFish)).toBe(cl.fortuneValue);
    expect(
      await prisma.fishTransaction.count({ where: { userId: u.id, type: 'checkin' } }),
      '一天只能有一条签到流水（翻牌时才发）'
    ).toBe(1);
    expect(await prisma.dailyCheckIn.count({ where: { userId: u.id } })).toBe(1);
  });

  it('★ 并发签到（Promise.all × 5）只成功一次、只落一行', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        checkIn(u.id).catch((e) => ({ thrown: String(e) }) as const)
      )
    );

    const succeeded = results.filter((r) => 'alreadyChecked' in r && r.alreadyChecked === false);
    const thrown = results.filter((r) => 'thrown' in r);

    // DB 是唯一事实来源：并发下落到库里的签到行必须只有一条。
    const records = await prisma.dailyCheckIn.findMany({ where: { userId: u.id } });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { driedFish: true, totalFortune: true },
    });

    expect(records, `并发下签到记录必须恰好 1 条（实测 ${records.length}）`).toHaveLength(1);
    expect(records[0].fortuneValue, '签到只建记录，值要等翻牌').toBeNull();
    expect(user.driedFish, '签到本身不发鱼（翻牌才发）').toBe(0);
    expect(
      succeeded.length,
      `最多只能有一个请求自认为「签到成功」（实测 ${succeeded.length}；抛错 ${thrown.length} 个）`
    ).toBeLessThanOrEqual(1);
  });

  it('不同用户同一天互不影响（唯一约束是 (userId, checkinDate) 复合键）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const a = await makeUser();
    const b = await makeUser();

    expect((await checkIn(a.id)).alreadyChecked).toBe(false);
    expect((await checkIn(b.id)).alreadyChecked, '别人签过不影响我').toBe(false);
    expect(await prisma.dailyCheckIn.count()).toBe(2);
  });

  it('已有「迁移来的历史今日签到」时，Next 侧再签会被同一约束拦下', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    await makeLegacyCheckin(u.id, '2026-07-15', 3, '3,1,5,2,4');

    const r = await checkIn(u.id);
    expect(r.alreadyChecked, '老数据与新写入必须共用同一个签到日键，否则切换当天人人可双签').toBe(
      true
    );
    expect(await prisma.dailyCheckIn.count({ where: { userId: u.id } })).toBe(1);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      driedFish: 0,
    });
  });
});

// ── 发鱼干（翻牌时才发）─────────────────────────────────────────────────────

describe('翻牌发鱼干', () => {
  it('余额增加 fortuneValue，且落一条 type=checkin 的流水', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 10 });

    const cl = await fullCheckin(u.id);

    expect(cl.driedFish, `10 + ${cl.fortuneValue}`).toBe(10 + cl.fortuneValue);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      // driedFish 存储单位 = 0.1 鱼干（fish-units.ts）
      driedFish: fishToUnits(10 + cl.fortuneValue),
    });

    const txs = await prisma.fishTransaction.findMany({ where: { userId: u.id } });
    expect(txs, '一次翻牌只能有一条流水').toHaveLength(1);
    expect(txs[0]).toMatchObject({
      amount: fishToUnits(cl.fortuneValue),
      type: 'checkin',
      description: `每日签到（运势值 ${cl.fortuneValue}）`,
    });
  });

  it('★ 签到后未翻牌时今日鱼数为 0（鱼在翻牌那刻才发）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await checkIn(u.id);
    expect(await getTodayCheckinFish(u.id), '只签到不翻牌 → 今日签到鱼必须是 0').toBe(0);
  });

  it('★ 流水 createdAt 非 NULL（NULL 会让流水倒序与今日签到判定全失效）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await fullCheckin(u.id);

    const tx = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: u.id } });
    expect(tx.createdAt, 'FishTransaction.createdAt 无 @default(now())，漏写就是 NULL').not.toBeNull();
  });

  it('★ 翻牌写的流水能被 getTodayCheckinFish 读回（两侧 UTC+8 口径必须一致）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z'); // UTC+8 07-15 12:00
    const u = await makeUser();
    const cl = await fullCheckin(u.id);

    expect(
      await getTodayCheckinFish(u.id),
      'checkin-service 与 fish-service 若「今天」口径不一致，页面会显示今日 0 鱼'
    ).toBe(cl.fortuneValue);
  });

  it('★ UTC+8 深夜（UTC 16:05 = UTC+8 次日 00:05）签到翻牌，今日鱼数仍能读回', async () => {
    // 这是最容易翻车的时刻：库里时间戳语义是「UTC+8 墙上时间贴 Z」，
    // 若某一侧误按真实 UTC 取区间，这里会差 8 小时 → 恒为 0。
    freezeUtc('2026-07-15T16:05:00.000Z');
    const u = await makeUser();
    const cl = await fullCheckin(u.id);

    expect(todayUtc8()).toBe('2026-07-16');
    expect(await getTodayCheckinFish(u.id), '跨日零点后立即签到翻牌，今日鱼数不能是 0').toBe(
      cl.fortuneValue
    );
  });

  it('用户不存在时签到不留下任何记录（整个事务失败）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    await expect(checkIn('ghost'), '外键会拒绝幽灵用户').rejects.toThrow();
    expect(await prisma.dailyCheckIn.count(), '不能留下孤儿签到记录').toBe(0);
    expect(await prisma.fishTransaction.count(), '不能留下孤儿流水').toBe(0);
  });

  it('多天签到翻牌线性累积余额与流水', async () => {
    const u = await makeUser({ driedFish: 0 });
    let sum = 0;
    for (const d of ['2026-07-13', '2026-07-14', '2026-07-15']) {
      freezeUtc(`${d}T04:00:00.000Z`);
      const cl = await fullCheckin(u.id);
      sum += cl.fortuneValue;
    }
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      driedFish: fishToUnits(sum), // 存储单位 = 0.1 鱼干
      totalFortune: sum,
    });
    expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(3);
  });
});

// ── 运势：牌池与翻牌取值 ─────────────────────────────────────────────────────

describe('运势：牌池与翻牌取值', () => {
  it('fortuneValue 恒在 1-5，pool 恒是 1-5 的一个排列', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    // 单次随机说明不了问题 —— 跑 30 个用户看分布与不变量。
    for (let i = 0; i < 30; i++) {
      await resetDb();
      const u = await makeUser();
      const cl = await fullCheckin(u.id);
      expect([...cl.pool].sort(), `pool 必须是 1-5 各一张（实测 ${cl.pool}）`).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(cl.fortuneValue).toBeGreaterThanOrEqual(1);
      expect(cl.fortuneValue).toBeLessThanOrEqual(5);
      expect(cl.pool, '翻出的值必须来自牌池').toContain(cl.fortuneValue);
    }
  });

  it('fortune_pool 在签到时以 "a,b,c,d,e" 字符串落库，翻牌取自该池', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    const ci = await checkIn(u.id);
    if (ci.alreadyChecked) return;

    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.fortunePool, '签到那刻牌池就落库（Flask 同款），不是翻牌时才编').not.toBeNull();

    const cl = await claimFortune(u.id, 3);
    expect(cl.ok).toBe(true);
    if (!cl.ok) return;
    // 翻出来的值 = 落库池的第 4 位 —— 用户的选择决定了结果
    const stored = row.fortunePool!.split(',').map(Number);
    expect(cl.fortuneValue).toBe(stored[3]);
    expect(cl.pool, 'claim 返回的池必须与落库池一致').toEqual(stored);
  });

  it('chosenIndex 0-4 精确决定翻出哪张牌', async () => {
    for (let idx = 0; idx < 5; idx++) {
      await resetDb();
      freezeUtc('2026-07-15T04:00:00.000Z');
      const u = await makeUser();
      const ci = await checkIn(u.id);
      if (ci.alreadyChecked) continue;
      const cl = await claimFortune(u.id, idx);
      expect(cl.ok).toBe(true);
      if (!cl.ok) continue;
      expect(cl.fortuneValue, `选了第 ${idx} 张就必须拿到 pool[${idx}]`).toBe(cl.pool[idx]);
    }
  });

  it('落库的 fortuneValue 与返回值一致（不能返回一张、存另一张）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    const cl = await fullCheckin(u.id, 2);
    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.fortuneValue).toBe(cl.fortuneValue);
  });

  it('翻牌前 fortune_value 恒为 NULL；翻牌后立即非 NULL', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    const ci = await checkIn(u.id);
    expect(ci.alreadyChecked).toBe(false);

    const row1 = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(row1.fortuneValue, '两步式：签到只建记录，值等翻牌').toBeNull();
    expect((await getTodayStatus(u.id)).fortunePending).toBe(true);

    await claimFortune(u.id, 0);
    const row2 = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(row2.fortuneValue).not.toBeNull();
    expect((await getTodayStatus(u.id)).fortunePending).toBe(false);
  });

  it('翻牌前 claim 会失败：「今天还没有签到」且零痕迹', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();

    const r = await claimFortune(u.id, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe('今天还没有签到');
    expect(await prisma.fishTransaction.count()).toBe(0);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: u.id } }),
      '幽灵/未签到用户不能被扣或加任何资产'
    ).toMatchObject({ driedFish: 0, totalFortune: 0 });
  });

  it('翻牌二次幂等：同值、alreadyClaimed、流水只一条、余额不再加', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    const first = await fullCheckin(u.id, 2);

    // 再 claim（哪怕换个位置）→ 幂等返回已翻的值，不重复发鱼
    const again = await claimFortune(u.id, 4);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyClaimed, '第二次 claim 必须标记 already_claimed').toBe(true);
    expect(again.fortuneValue, '幂等返回的必须是第一次翻的值').toBe(first.fortuneValue);
    expect(again.pool).toEqual(first.pool);
    expect(again.driedFish, '不能重复发鱼').toBe(first.driedFish);
    expect(again.totalFortune, '不能重复累加').toBe(first.totalFortune);
    expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(1);
  });

  it('★ 并发翻牌（Promise.all × 5）只发一次鱼，只有一个赢家', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    const ci = await checkIn(u.id);
    if (ci.alreadyChecked) return;

    // 同一天同一副池、翻同一张 —— 理论值一致，谁赢都一样
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimFortune(u.id, 1))
    );
    const winner = results.find(
      (r): r is Extract<ClaimResult, { ok: true }> => r.ok && !r.alreadyClaimed
    );
    const losers = results.filter(
      (r): r is Extract<ClaimResult, { ok: true }> => r.ok && r.alreadyClaimed
    );

    expect(winner, '并发下必须恰好一个请求翻到牌').toBeDefined();
    if (!winner) return;
    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { driedFish: true, totalFortune: true },
    });

    expect(row.fortuneValue, '落库值必须与赢家一致').toBe(winner.fortuneValue);
    expect(unitsToFish(user.driedFish), '余额 = 赢家那次的值，多发即资产损失').toBe(
      winner.fortuneValue
    );
    expect(user.totalFortune, 'totalFortune 不能被并发多加').toBe(winner.fortuneValue);
    expect(
      await prisma.fishTransaction.count({ where: { userId: u.id, type: 'checkin' } }),
      '并发翻牌只能有一条签到流水'
    ).toBe(1);
    expect(losers.length, '其余请求幂等返回现值').toBe(4);
    for (const l of losers) {
      expect(l.fortuneValue, '输家看到的也必须是同一个值（同池同位）').toBe(winner.fortuneValue);
    }
  });

  // 【回归】越界 chosenIndex 必须报错，不能静默开盲盒。
  // 曾经的行为：-1/5/99/NaN 都被静默换成随机 index —— 用户想选某张牌却拿到随机牌，
  // 且翻牌只能一次、无法重来。NaN 尤其隐蔽（NaN >= 0 为 false → 落进随机分支）。
  // Flask claim_fortune 对越界返回「无效的选择」。
  it('越界/非法 chosenIndex（-1 / 5 / 99 / NaN / 小数）→ 「无效的选择」且不落值', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    // 每轮换个新用户即可隔离（唯一约束是 (userId, checkinDate)）——
    // 不在循环里 resetDb()：那会反复 DELETE 22 张表，制造 SQLite 锁竞争导致偶发失败。
    for (const bad of [-1, 5, 99, NaN, 1.5]) {
      const u = await makeUser();
      const ci = await checkIn(u.id);
      if (ci.alreadyChecked) continue;

      const r = await claimFortune(u.id, bad);
      expect(r.ok, `chosenIndex=${bad} 应被拒绝，而不是静默随机翻牌`).toBe(false);
      if (!r.ok) expect(r.message).toBe('无效的选择');

      // 被拒后：行保留（已签到）、值仍 NULL、无鱼无流水 —— 用户还能换张牌重试
      const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
      expect(row.fortuneValue, '被拒后值必须仍是 NULL（当天不能被锁死）').toBeNull();
      expect(await prisma.fishTransaction.count({ where: { userId: u.id } }), '不该发鱼').toBe(0);
      const uu = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(uu.totalFortune, '不该累加运势').toBe(0);
      expect(uu.driedFish, '不该发鱼干').toBe(0);
    }
  });

  it('合法 chosenIndex（0-4）精确决定翻到哪张牌', async () => {
    for (const idx of [0, 1, 2, 3, 4]) {
      await resetDb();
      freezeUtc('2026-07-15T04:00:00.000Z');
      const u = await makeUser();
      const ci = await checkIn(u.id);
      if (ci.alreadyChecked) continue;
      const r = await claimFortune(u.id, idx);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.fortuneValue, '运势值必须取自牌池对应位置').toBe(r.pool[idx]);
    }
  });

  it('★ 选的位置真正决定命运：同副固定牌池，翻第 1 张拿 5、翻第 5 张拿 1（确定性）', async () => {
    // 两步式的核心语义回归：claim 从**签到落库的牌池**按位置取值。
    // 两个用户同一副池（5,4,3,2,1）：A 选第 0 张必得 5、B 选第 4 张必得 1 ——
    // 确定性断言。若实现悄悄「签到即抽定、翻牌是演出」（返回随机值再编池），
    // 这两个断言必然挂。
    freezeUtc('2026-07-15T04:00:00.000Z');
    const a = await makeUser({ username: 'pickA' });
    const b = await makeUser({ username: 'pickB' });
    await makePendingCheckin(a.id, '2026-07-15', '5,4,3,2,1');
    await makePendingCheckin(b.id, '2026-07-15', '5,4,3,2,1');

    const ra = await claimFortune(a.id, 0);
    expect(ra.ok).toBe(true);
    if (ra.ok) expect(ra.fortuneValue, '第 1 张 = pool[0] = 5').toBe(5);

    const rb = await claimFortune(b.id, 4);
    expect(rb.ok).toBe(true);
    if (rb.ok) expect(rb.fortuneValue, '第 5 张 = pool[4] = 1 —— 选不同位置得到不同值').toBe(1);

    // 翻牌一旦发生就锁死：同样两张牌各自只能翻一次（上面的结果不可重选）
    const again = await claimFortune(a.id, 4);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.alreadyClaimed, 'A 已翻过 → 幂等返回，不能再翻第 5 张').toBe(true);
      expect(again.fortuneValue).toBe(5);
    }
  });
});

describe('运势：totalFortune 累计', () => {
  it('每天翻牌累加当日 fortuneValue，与流水/余额三者一致', async () => {
    const u = await makeUser({ driedFish: 0 });
    let expected = 0;
    for (const d of ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']) {
      freezeUtc(`${d}T04:00:00.000Z`);
      const cl = await fullCheckin(u.id, 0);
      expected += cl.fortuneValue;
      expect(cl.totalFortune, `第 ${d} 天累计应为 ${expected}`).toBe(expected);
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

  it('不串用户：A 签到翻牌不影响 B 的 totalFortune', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const a = await makeUser();
    const b = await makeUser();
    await fullCheckin(a.id);
    expect((await getTodayStatus(b.id)).totalFortune).toBe(0);
    expect((await getTodayStatus(b.id)).driedFish).toBe(0);
  });
});

describe('运势：翻牌语义（两步式）', () => {
  it('★ 两步分离：checkIn 后 fortuneValue=NULL + pending；claim 后才定值发鱼', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });

    const ci = await checkIn(u.id);
    expect(ci.alreadyChecked).toBe(false);

    const row1 = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(
      row1.fortuneValue,
      '两步式：checkIn() 建记录时 fortune_value 必须留 NULL（Flask 语义），等待 claim'
    ).toBeNull();
    expect(row1.fortunePool, '但牌池在签到时就洗好落库').not.toBeNull();
    expect((await getTodayStatus(u.id)).fortunePending).toBe(true);

    const cl = await claimFortune(u.id, 2);
    expect(cl.ok).toBe(true);
    if (!cl.ok) return;
    const row2 = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(row2.fortuneValue, 'claim 后值必须落库').toBe(cl.fortuneValue);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: u.id } }),
      '鱼干/运势只在 claim 时发放'
    ).toMatchObject({ driedFish: fishToUnits(cl.fortuneValue), totalFortune: cl.fortuneValue });
  });

  it('迁移来的「已签到未翻牌」老行：识别为 pending，且能在 UI 里补翻（claim 复活）', async () => {
    // Flask 时代真实存在这种行：签了到、没点牌。两步式恢复后，用户能重新翻这张牌。
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    await makePendingCheckin(u.id, '2026-07-15', '3,1,5,2,4');

    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '记录存在即已签到').toBe(true);
    expect(st.fortuneValue, '未翻牌 → NULL').toBeNull();
    expect(st.fortunePending, '必须识别为待翻牌态（前端据此自动弹卡）').toBe(true);
    expect(st.fortunePool, '牌池仍可读').toEqual([3, 1, 5, 2, 4]);

    // 两步式下 claim 入口存在 → 老行可正常补翻：池 '3,1,5,2,4'，选第 3 张 → 5
    const cl = await claimFortune(u.id, 2);
    expect(cl.ok).toBe(true);
    if (!cl.ok) return;
    expect(cl.fortuneValue).toBe(5);
    expect(cl.driedFish, '补翻也要发等额鱼干').toBe(5);
    const uu = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(uu).toMatchObject({ totalFortune: 5, driedFish: fishToUnits(5) });
    expect(await prisma.fishTransaction.count({ where: { userId: u.id, type: 'checkin' } })).toBe(1);
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

  it('★ 腐坏 fortune_pool 上的 claim → 「运势池数据异常」且不落值不发鱼', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 5 });
    await prisma.$executeRawUnsafe(
      `INSERT INTO daily_checkins (user_id, checkin_date, created_at, fortune_value, fortune_pool)
       VALUES (?, ?, ?, NULL, '1,2,3')`, // 长度不对 → 解析失败
      u.id,
      dayAt('2026-07-15').getTime(),
      new Date('2026-07-15T09:00:00.000Z').getTime()
    );

    const r = await claimFortune(u.id, 0);
    expect(r.ok, '腐坏池必须显式报错，不能静默开盲盒').toBe(false);
    if (r.ok) return;
    expect(r.message).toBe('运势池数据异常');
    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.fortuneValue, '不能落值').toBeNull();
    expect(await prisma.fishTransaction.count(), '不能发鱼').toBe(0);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: u.id } }),
      '余额不能动'
    ).toMatchObject({ driedFish: fishToUnits(5), totalFortune: 0 });
  });

  it('★ 跨 UTC+8 午夜：前一天签到、新一天翻牌 → 「今天还没有签到」（Flask 同款副作用）', async () => {
    // 两步式的固有窗口：23:59 签到、00:00 后点牌 —— claim 按「今天」找不到行。
    // 这不是 bug，是与 Flask 一致的语义（一步式没有此窗口）；钉住防回归。
    const u = await makeUser();

    freezeUtc('2026-07-15T15:59:00.000Z'); // UTC+8 07-15 23:59
    const ci = await checkIn(u.id);
    expect(ci.alreadyChecked).toBe(false);

    freezeUtc('2026-07-15T16:00:01.000Z'); // UTC+8 07-16 00:00:01
    const r = await claimFortune(u.id, 0);
    expect(r.ok, '新一天查不到昨天的行 → claim 必须拒绝').toBe(false);
    if (r.ok) return;
    expect(r.message).toBe('今天还没有签到');
    // 昨天那张牌永久作废；但昨天那行本身还在（不污染历史）
    const rows = await prisma.dailyCheckIn.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].fortuneValue).toBeNull();
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
      fortunePending: false,
      totalCount: 0,
      today: '2026-07-16',
      fortuneValue: null,
      fortunePool: null,
      totalFortune: 0,
      driedFish: 3,
    });
  });

  it('已签到未翻牌：fortuneValue NULL + fortunePending true', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    await checkIn(u.id);

    const st = await getTodayStatus(u.id);
    expect(st).toMatchObject({
      checkedIn: true,
      today: '2026-07-15',
      fortuneValue: null,
      fortunePending: true,
      driedFish: 0,
    });
  });

  it('已签到并翻牌：返回当日运势、牌池、累计天数与余额', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    await makeLegacyCheckin(u.id, '2026-07-13', 2, '2,1,3,4,5'); // 历史天数计入 totalCount
    const cl = await fullCheckin(u.id, 0);

    const st = await getTodayStatus(u.id);
    expect(st).toMatchObject({
      checkedIn: true,
      today: '2026-07-15',
      fortuneValue: cl.fortuneValue,
      fortunePending: false,
      driedFish: cl.fortuneValue,
    });
    expect(st.fortunePool).toEqual(cl.pool);
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

  it('checkIn/claimFortune 返回的 totalCount/driedFish/totalFortune 与随后的 getTodayStatus 一致', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 4 });
    const cl = await fullCheckin(u.id); // 内部已完成 checkIn + claim
    const st = await getTodayStatus(u.id);
    expect({ d: cl.driedFish, f: cl.totalFortune }).toEqual({
      d: st.driedFish,
      f: st.totalFortune,
    });

    // 再签到被拒时返回的 status.totalCount 与状态接口一致（都是 1 天）
    const ci2 = await checkIn(u.id);
    expect(ci2.alreadyChecked).toBe(true);
    if (!ci2.alreadyChecked) return;
    expect(ci2.status.totalCount).toBe(st.totalCount);
    expect(st.totalCount).toBe(1);
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

  it('翻牌写入的 totalFortune 立即反映到运势榜（读写口径一致）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ username: 'fresh' });
    const cl = await fullCheckin(u.id);
    const lb = await getFortuneLeaderboard();
    expect(lb).toHaveLength(1);
    expect(lb[0]).toMatchObject({ rank: 1, userId: u.id, value: cl.fortuneValue });
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
// Next 侧 schema 是 `createdAt DateTime?` 且**无 @default(now())** —— 签到建行时
// 不显式写就会落 NULL，让排行榜的次级排序键 max(created_at) asc 失效。

describe('DailyCheckIn.createdAt 落库', () => {
  it('checkIn 必须写入 createdAt', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await checkIn(u.id);

    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(
      row.createdAt,
      'createdAt 落 NULL —— 排行榜的并列排序键 max(created_at) 会失效'
    ).not.toBeNull();
  });

  it('createdAt 走 nowForDb()（UTC+8 墙上时间），而非真实 UTC', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z'); // UTC 04:00 = UTC+8 12:00
    const u = await makeUser();
    await checkIn(u.id);

    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    expect(
      row.createdAt!.toISOString(),
      '库内时间戳约定为 UTC+8 墙上时间（见 db-time.ts）；用 new Date() 会差 8 小时'
    ).toBe('2026-07-15T12:00:00.000Z');
  });

  it('存储类型是 INTEGER（与规整脚本产出一致，保证日期比较按数值）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await checkIn(u.id);
    const [r] = await prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT typeof(created_at) t FROM daily_checkins LIMIT 1`
    );
    expect(r.t).toBe('integer');
  });
});
