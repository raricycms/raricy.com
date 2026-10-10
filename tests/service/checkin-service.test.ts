// checkin-service.ts —— 每日签到（UTC+8 跨日 + 唯一约束 + 固定发鱼干）。
//
// 【为什么这些用例值得存在】
// 1. **时区**：签到日是「UTC+8 墙上日期」，而服务器/CI 的 TZ 不确定。跨日边界算错，
//    用户在 UTC+8 23:59 签一次、00:01 又能签一次（或反过来白丢一天）。这类 bug 在
//    非边界时刻跑测试永远绿。故本文件用 vi.setSystemTime 把时钟钉死在边界上。
// 2. **唯一约束**：一天一次是靠 DB 的 uq(user_id, checkin_date) 兜底，不是靠先查后插
//    （那是 TOCTOU）。并发/重复提交必须只发一次鱼干。
// 3. **发鱼干**：这是钱。签到成功 → 余额与流水必须同进同退，金额恒为 CHECKIN_REWARD_FISH。
//
// 【一步式语义（本文件钉住）】checkIn() 在**一个事务**里建当日记录 + 发鱼干 + 写流水。
// 没有「已签到、待领奖」的中间态 —— 那是两步式留下的（跨 UTC+8 午夜就作废，要靠补偿
// 脚本兜底），已随固定奖励一起下线。
//
// 【存储形态】规整后库里时间戳是 INTEGER（Unix 毫秒），不是 TEXT。造历史夹具时用
// new Date(iso).getTime() 插入；也不要在 $queryRaw 里对时间列用 date()/strftime()
// （对 INTEGER 恒返回 NULL）。语义见 src/lib/db-time.ts：数字 = UTC+8 墙上时间贴 Z 标签。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  todayUtc8,
  checkIn,
  getTodayStatus,
  getCountLeaderboard,
  hasPublishedBlog,
  CHECKIN_REWARD_FISH,
} from '@/lib/checkin-service';
import { getTodayCheckinFish } from '@/lib/fish-service';
import { fishToUnits, unitsToFish } from '@/lib/fish-units';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { expectLedgerConsistent } from '../helpers/fish-ledger';

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
async function makeLegacyCheckin(userId: string, ymd: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO daily_checkins (user_id, checkin_date, created_at)
     VALUES (?, ?, ?)`,
    userId,
    dayAt(ymd).getTime(),
    new Date(`${ymd}T09:30:00.000Z`).getTime()
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
    await makeLegacyCheckin(u.id, '2026-07-15');

    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '老数据的今日签到必须被识别，否则用户能重复签').toBe(true);
    expect(st.totalCount).toBe(1);
    expect(st.todayFish, '历史行没有对应流水时今日到手为 0（不按常量推算）').toBe(0);
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
    // 两次签到 = 两笔鱼 —— 一天一次是按 UTC+8 的「天」算的，跨过零点就是新的一天
    expect(r2.driedFish).toBe(CHECKIN_REWARD_FISH * 2);
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
    expect(st.todayFish, '新的一天今日到手归零').toBe(0);
    expect(st.driedFish, '余额不因跨日而变化').toBe(CHECKIN_REWARD_FISH);
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
    expect(r2.status.totalCount).toBe(1);
    expect(r2.status.todayFish, '第一次已经到账，状态里能读回那 3 条').toBe(CHECKIN_REWARD_FISH);
    expect(r2.status.driedFish).toBe(CHECKIN_REWARD_FISH);
  });

  it('★ 被拒的二次签到不加行、不重复发鱼', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });

    const first = await checkIn(u.id);
    expect(first.alreadyChecked).toBe(false);
    if (first.alreadyChecked) return;
    expect(first.driedFish).toBe(CHECKIN_REWARD_FISH);

    await checkIn(u.id);
    await checkIn(u.id);

    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: u.id } }),
      '重复签到刷鱼干 = 直接的资产漏洞'
    ).toMatchObject({ driedFish: fishToUnits(CHECKIN_REWARD_FISH) });
    expect(
      await prisma.fishTransaction.count({ where: { userId: u.id, type: 'checkin' } }),
      '一天只能有一条签到流水'
    ).toBe(1);
    expect(await prisma.dailyCheckIn.count({ where: { userId: u.id } })).toBe(1);
  });

  it('★ 30 次并发签到只成功一次，其余正常回已签到，没有事务超时', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        checkIn(u.id).catch((e) => ({ thrown: String(e) }) as const)
      )
    );

    const succeeded = results.filter((r) => 'alreadyChecked' in r && r.alreadyChecked === false);
    const thrown = results.filter((r) => 'thrown' in r);

    // DB 是唯一事实来源：并发下落到库里的签到行必须只有一条，且只发了一笔钱。
    const records = await prisma.dailyCheckIn.findMany({ where: { userId: u.id } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });

    expect(records, `并发下签到记录必须恰好 1 条（实测 ${records.length}）`).toHaveLength(1);
    expect(unitsToFish(user.driedFish), '并发不能变成发 2 笔、3 笔').toBe(CHECKIN_REWARD_FISH);
    expect(
      await prisma.fishTransaction.count({ where: { userId: u.id, type: 'checkin' } }),
      '并发签到只能有一条流水'
    ).toBe(1);
    expect(
      succeeded.length,
      `最多只能有一个请求自认为「签到成功」（实测 ${succeeded.length}；抛错 ${thrown.length} 个）`
    ).toBe(1);
    expect(thrown).toEqual([]);
    expect(results.filter((r) => 'alreadyChecked' in r && r.alreadyChecked)).toHaveLength(29);
    await expectLedgerConsistent('30 次并发签到后');
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
    await makeLegacyCheckin(u.id, '2026-07-15');

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

// ── 发鱼干（签到即到账）─────────────────────────────────────────────────────

describe('签到发鱼干', () => {
  it('奖励常量恒为 3（改它就要同步页面文案与对外文档）', () => {
    expect(CHECKIN_REWARD_FISH, '这是站长定的数，不是可调参数').toBe(3);
  });

  it('余额增加固定 3 条，且落一条 type=checkin 的流水', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 10 });

    const r = await checkIn(u.id);
    expect(r.alreadyChecked).toBe(false);
    if (r.alreadyChecked) return;

    expect(r.rewardFish).toBe(CHECKIN_REWARD_FISH);
    expect(r.todayFish).toBe(CHECKIN_REWARD_FISH);
    expect(r.driedFish, `10 + ${CHECKIN_REWARD_FISH}`).toBe(10 + CHECKIN_REWARD_FISH);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      // driedFish 存储单位 = 0.0001 鱼干（fish-units.ts）
      driedFish: fishToUnits(10 + CHECKIN_REWARD_FISH),
    });

    const txs = await prisma.fishTransaction.findMany({ where: { userId: u.id } });
    expect(txs, '一次签到只能有一条流水').toHaveLength(1);
    expect(txs[0]).toMatchObject({
      amount: fishToUnits(CHECKIN_REWARD_FISH),
      type: 'checkin',
      description: '每日签到',
    });
  });

  it('★ 流水 createdAt 非 NULL（NULL 会让流水倒序与今日签到判定全失效）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    await checkIn(u.id);

    const tx = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: u.id } });
    expect(tx.createdAt, 'FishTransaction.createdAt 无 @default(now())，漏写就是 NULL').not.toBeNull();
  });

  it('★ 签到写的流水能被 getTodayCheckinFish 读回（两侧 UTC+8 口径必须一致）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z'); // UTC+8 07-15 12:00
    const u = await makeUser();
    await checkIn(u.id);

    expect(
      await getTodayCheckinFish(u.id),
      'checkin-service 与 fish-service 若「今天」口径不一致，页面会显示今日 0 鱼'
    ).toBe(CHECKIN_REWARD_FISH);
  });

  it('★ UTC+8 深夜（UTC 16:05 = UTC+8 次日 00:05）签到，今日鱼数仍能读回', async () => {
    // 这是最容易翻车的时刻：库里时间戳语义是「UTC+8 墙上时间贴 Z」，
    // 若某一侧误按真实 UTC 取区间，这里会差 8 小时 → 恒为 0。
    freezeUtc('2026-07-15T16:05:00.000Z');
    const u = await makeUser();
    await checkIn(u.id);

    expect(todayUtc8()).toBe('2026-07-16');
    expect(await getTodayCheckinFish(u.id), '跨日零点后立即签到，今日鱼数不能是 0').toBe(
      CHECKIN_REWARD_FISH
    );
  });

  it('★ 用户不存在时整笔回滚：不留签到行、不留流水、不留下孤儿钱', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    await expect(checkIn('ghost'), '外键会拒绝幽灵用户').rejects.toThrow();
    expect(await prisma.dailyCheckIn.count(), '不能留下孤儿签到记录').toBe(0);
    expect(await prisma.fishTransaction.count(), '不能留下孤儿流水').toBe(0);
  });

  it('多天签到线性累积余额与流水', async () => {
    const u = await makeUser({ driedFish: 0 });
    for (const d of ['2026-07-13', '2026-07-14', '2026-07-15']) {
      freezeUtc(`${d}T04:00:00.000Z`);
      const r = await checkIn(u.id);
      expect(r.alreadyChecked).toBe(false);
    }
    expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      driedFish: fishToUnits(CHECKIN_REWARD_FISH * 3),
    });
    expect(await prisma.fishTransaction.count({ where: { userId: u.id } })).toBe(3);
  });

  it('★ 账目自洽：余额 == 该用户流水之和（新写路径的纪律）', async () => {
    // 签到是「一次事务里既改余额又写流水」的写路径之一 —— 任何一侧漏写都会在这里露馅。
    // 用 driedFish: 0 造号：余额必须**有来源**，直接塞 driedFish 的夹具本来就撕裂。
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    await checkIn(u.id);
    await checkIn(u.id); // 第二笔被拒 —— 也不该在账上留下任何痕迹

    await expectLedgerConsistent('签到之后');
  });
});

// ── 今日状态查询 ────────────────────────────────────────────────────────────

describe('getTodayStatus', () => {
  it('未签到：checkedIn=false，todayFish=0，today 为 UTC+8 今天', async () => {
    freezeUtc('2026-07-15T16:00:00.000Z'); // UTC+8 07-16
    const u = await makeUser({ driedFish: 3 });

    expect(await getTodayStatus(u.id)).toEqual({
      checkedIn: false,
      canCheckIn: false, // 这个号没发过文章（见下方 hasPublishedBlog 一组）
      totalCount: 0,
      today: '2026-07-16',
      rewardFish: CHECKIN_REWARD_FISH,
      todayFish: 0,
      driedFish: 3,
    });
  });

  it('已签到：返回今日到手、累计天数与余额', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });
    await makeLegacyCheckin(u.id, '2026-07-13'); // 历史天数计入 totalCount
    await checkIn(u.id);

    expect(await getTodayStatus(u.id)).toMatchObject({
      checkedIn: true,
      today: '2026-07-15',
      todayFish: CHECKIN_REWARD_FISH,
      driedFish: CHECKIN_REWARD_FISH,
      totalCount: 2, // 历史 1 天 + 今天 1 天
    });
  });

  it('totalCount 统计所有历史天数，不只是今天', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) {
      await makeLegacyCheckin(u.id, d);
    }
    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '今天没签').toBe(false);
    expect(st.totalCount, '累计天数与今日是否签到无关').toBe(3);
  });

  it('totalCount 只数自己的（不能把别人的签到算进来）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const a = await makeUser();
    const b = await makeUser();
    await makeLegacyCheckin(b.id, '2026-07-01');
    await makeLegacyCheckin(b.id, '2026-07-02');
    expect((await getTodayStatus(a.id)).totalCount).toBe(0);
  });

  it('用户不存在时安全降级（driedFish/todayFish 为 0，不抛错）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const st = await getTodayStatus('ghost');
    expect(st, '未知 userId 不应把签到页打成 500').toMatchObject({
      checkedIn: false,
      totalCount: 0,
      rewardFish: CHECKIN_REWARD_FISH,
      todayFish: 0,
      driedFish: 0,
    });
  });

  it('checkIn 返回的 totalCount/driedFish 与随后的 getTodayStatus 一致', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 4 });
    const r = await checkIn(u.id);
    expect(r.alreadyChecked).toBe(false);
    if (r.alreadyChecked) return;

    const st = await getTodayStatus(u.id);
    expect({ d: r.driedFish, c: r.totalCount, t: r.todayFish }).toEqual({
      d: st.driedFish,
      c: st.totalCount,
      t: st.todayFish,
    });

    // 再签到被拒时返回的 status 与状态接口一致（都是 1 天）
    const r2 = await checkIn(u.id);
    expect(r2.alreadyChecked).toBe(true);
    if (!r2.alreadyChecked) return;
    expect(r2.status.totalCount).toBe(st.totalCount);
    expect(st.totalCount).toBe(1);
  });
});

// ── 签到的内容前置条件（发布过文章） ─────────────────────────────────────────
//
// 【为什么在服务层测】这道门**不在 checkIn() 里**（与档位同款：页面与两个方法各自判，
// checkIn 是纯发鱼内核）。服务层能测的是判据 hasPublishedBlog 与 getTodayStatus 回传的
// canCheckIn —— 路由那一层的 403 由 e2e 钉（tests/e2e/checkin.spec.ts）。
describe('hasPublishedBlog（签到的内容前置条件）', () => {
  it('没发过 → false；发了一篇未软删的 → true', async () => {
    const u = await makeUser();
    expect(await hasPublishedBlog(u.id)).toBe(false);
    await makeBlog({ authorId: u.id });
    expect(await hasPublishedBlog(u.id)).toBe(true);
  });

  it('★ 软删（ignore=true）不算 —— 全删光等于没发过', async () => {
    const u = await makeUser();
    await makeBlog({ authorId: u.id });
    await prisma.blog.updateMany({ where: { authorId: u.id }, data: { ignore: true } });
    expect(await hasPublishedBlog(u.id), '发过又全删 = 没发过').toBe(false);
  });

  it('只数自己的：别人的文章不算我的产出', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await makeBlog({ authorId: b.id });
    expect(await hasPublishedBlog(a.id)).toBe(false);
  });

  it('getTodayStatus.canCheckIn 跟着文章走（发 / 删都反映出来）', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    expect((await getTodayStatus(u.id)).canCheckIn).toBe(false);
    await makeBlog({ authorId: u.id });
    expect((await getTodayStatus(u.id)).canCheckIn).toBe(true);
    await prisma.blog.updateMany({ where: { authorId: u.id }, data: { ignore: true } });
    expect((await getTodayStatus(u.id)).canCheckIn, '删光后又不能签了').toBe(false);
  });
});

// ── 排行榜 ──────────────────────────────────────────────────────────────────

describe('getCountLeaderboard（签到天数榜）', () => {
  it('按天数降序，rank 从 1 连续递增', async () => {
    const a = await makeUser({ username: 'three' });
    const b = await makeUser({ username: 'one' });
    const c = await makeUser({ username: 'two' });
    for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) await makeLegacyCheckin(a.id, d);
    await makeLegacyCheckin(b.id, '2026-07-01');
    for (const d of ['2026-07-01', '2026-07-02']) await makeLegacyCheckin(c.id, d);

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
        await makeLegacyCheckin(u.id, `2026-07-0${d}`);
      }
    }
    const lb = await getCountLeaderboard(2);
    expect(lb).toHaveLength(2);
    expect(lb.map((e) => e.value)).toEqual([4, 3]);
  });

  it('返回字段收敛（rank/userId/username/frameUrl/value），不泄漏 email', async () => {
    const u = await makeUser({ username: 'solo' });
    await makeLegacyCheckin(u.id, '2026-07-01');
    const lb = await getCountLeaderboard();
    expect(lb[0]).toEqual({
      rank: 1,
      userId: u.id,
      username: 'solo',
      frameUrl: null, // 没戴框
      value: 1,
    });
  });

  it('⚠️ 天数并列时无第二排序键 —— 取舍由 SQLite 决定，结果不稳定', async () => {
    // 正确的 order_by 是 (count desc, max(created_at) asc)：
    // 并列时「更早签到的人」排前面。当前实现丢了这个次级排序键。
    // 【修复后删掉本块，改为回归用例】
    for (const n of ['tieA', 'tieB', 'tieC']) {
      const u = await makeUser({ username: n });
      await makeLegacyCheckin(u.id, '2026-07-01');
    }
    const lb = await getCountLeaderboard();
    expect(lb, '并列者一个都不能少').toHaveLength(3);
    expect(new Set(lb.map((e) => e.username))).toEqual(new Set(['tieA', 'tieB', 'tieC']));
    expect(lb.map((e) => e.rank), 'rank 按位次连续赋值（非竞赛式并列）').toEqual([1, 2, 3]);
  });
});

// ── 回归：DailyCheckIn.created_at ───────────────────────────────────────────
//
// created_at 在历史库里恒有值（建行时由默认值写入），
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
