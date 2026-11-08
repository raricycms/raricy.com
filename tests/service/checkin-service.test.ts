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

/** 该 UTC+8 墙上日期的零点（贴 Z 标签）—— 与被测 db-time 的 dayStart 同口径。 */
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

// ── todayUtc8 / dayStart：UTC+8 跨日边界 ─────────────────────────────────────
//
// UTC+8 的一天在 UTC 时间轴上是 [前一日 16:00Z, 当日 16:00Z)。
// 因此 UTC 15:59:59 = UTC+8 23:59:59（今天），UTC 16:00:00 = UTC+8 次日 00:00（明天）。

describe('todayUtc8（UTC+8 跨日边界）', () => {
  it('UTC 时间在 [前日 16:00Z, 当日 16:00Z) 内 → 同一个 UTC+8 日期（含月/年/闰年翻页）', () => {
    const cases: [string, string][] = [
      ['2026-07-15T15:59:59.999Z', '2026-07-15'], // UTC+8 23:59:59，还没跨日
      ['2026-07-15T16:00:00.000Z', '2026-07-16'], // UTC+8 00:00:00，翻页
      ['2026-07-15T00:00:00.000Z', '2026-07-15'], // UTC+8 08:00，同一 UTC 日期
      ['2026-07-31T16:00:00.000Z', '2026-08-01'], // 跨月
      ['2026-12-31T16:00:00.000Z', '2027-01-01'], // 跨年
      ['2028-02-28T16:00:00.000Z', '2028-02-29'], // 闰年 2-29
    ];
    for (const [utc, expected] of cases) {
      freezeUtc(utc);
      expect(todayUtc8(), `UTC ${utc} → UTC+8 ${expected}`).toBe(expected);
    }
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
  it('UTC 15:59 签一次、16:00 再签一次 —— 两次都成功，落 2 天记录；之后同一 UTC+8 日不能再签', async () => {
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
    // 两次签到 = 两笔鱼 —— 一天一次是按 UTC+8 的「天」算的
    expect(r2.driedFish).toBe(CHECKIN_REWARD_FISH * 2);

    // 同一 UTC+8 日的稍后（UTC 日期已经变了）再签仍必须被拒
    freezeUtc('2026-07-16T15:59:00.000Z'); // UTC+8 07-16 23:59
    const r3 = await checkIn(u.id);
    expect(r3.alreadyChecked, 'UTC 日期变了但 UTC+8 还是同一天 → 必须拒绝').toBe(true);
    expect(await prisma.dailyCheckIn.count({ where: { userId: u.id } })).toBe(2);
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
  it('同日二次签到被拒：返回「今天已签到」+ 当日状态，且不加行、不重复发鱼', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ driedFish: 0 });

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

    // 再签一次：行数/流水/余额都不许变（防「每次点都发一笔」）
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
      canCheckIn: false, // role=user（P01 起资格只看 core+/归档/禁言，与发文无关）
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

  it('totalCount 统计所有历史天数（不只今天），且只数自己的', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser();
    for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) await makeLegacyCheckin(u.id, d);
    const other = await makeUser();
    await makeLegacyCheckin(other.id, '2026-07-01');
    await makeLegacyCheckin(other.id, '2026-07-02');

    const st = await getTodayStatus(u.id);
    expect(st.checkedIn, '今天没签').toBe(false);
    expect(st.totalCount, '累计天数与今日是否签到无关，也不含他人').toBe(3);
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

// ── 签到资格（P01：未归档 core+ 且当前未禁言；与「发过文章」无关） ──────────────
//
// 【为什么在服务层测】资格判据只有一处：`getTodayStatus().canCheckIn`（页面与两个 API
// 方法共用）。checkIn() 仍是纯发鱼内核，路由层的 403 由 e2e 钉。
// 【2026-11-07 起】不再有「名下有未删除博客」这道门：零博客成员可签，发过又全删也仍可签。
describe('getTodayStatus.canCheckIn（签到资格）', () => {
  it('普通账号（role=user）不够格；core 够格', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const plain = await makeUser();
    expect((await getTodayStatus(plain.id)).canCheckIn).toBe(false);
    const core = await makeUser({ role: 'core' });
    expect((await getTodayStatus(core.id)).canCheckIn).toBe(true);
  });

  it('★ 与发文解耦：零博客 core 可签；发过又全删也仍可签', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ role: 'core' });
    expect((await getTodayStatus(u.id)).canCheckIn, '零博客不再受限').toBe(true);
    await makeBlog({ authorId: u.id });
    expect((await getTodayStatus(u.id)).canCheckIn, '发一篇也不改变资格').toBe(true);
    await prisma.blog.updateMany({ where: { authorId: u.id }, data: { ignore: true } });
    expect((await getTodayStatus(u.id)).canCheckIn, '删光最后一篇也不改变资格').toBe(true);
    // 而且真的签得进去（资格与发鱼一致，不只是状态字段对）
    const r = await checkIn(u.id);
    expect(r.alreadyChecked).toBe(false);
  });

  it('禁言中的 core 不能签；解除后恢复', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ role: 'core', isBanned: true, banUntil: null });
    expect((await getTodayStatus(u.id)).canCheckIn, '永久禁言').toBe(false);
    await prisma.user.update({ where: { id: u.id }, data: { isBanned: false } });
    expect((await getTodayStatus(u.id)).canCheckIn).toBe(true);

    // 限时禁言：banUntil 在未来 → 仍不能签
    const temp = await makeUser({ role: 'core', isBanned: true, banUntil: new Date('2026-07-16T00:00:00.000Z') });
    expect((await getTodayStatus(temp.id)).canCheckIn, '禁言到 07-16，07-15 不能签').toBe(false);
    // banUntil 已过 → 恢复（isBanned 列不再拦，见 isCurrentlyBanned 的到期语义）
    await prisma.user.update({ where: { id: temp.id }, data: { banUntil: new Date('2026-07-14T00:00:00.000Z') } });
    expect((await getTodayStatus(temp.id)).canCheckIn).toBe(true);
  });

  it('归档的 core 不能签', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z');
    const u = await makeUser({ role: 'core' });
    await prisma.user.update({ where: { id: u.id }, data: { archivedAt: new Date() } });
    expect((await getTodayStatus(u.id)).canCheckIn).toBe(false);
  });
});

// ── 排行榜 ──────────────────────────────────────────────────────────────────

describe('getCountLeaderboard（签到天数榜）', () => {
  it('按天数降序、rank 连续；limit 取天数最多的前 N 名', async () => {
    for (const [i, username] of ['one', 'two', 'three', 'four'].entries()) {
      const u = await makeUser({ username });
      for (let d = 1; d <= i + 1; d++) await makeLegacyCheckin(u.id, `2026-07-0${d}`);
    }

    const lb = await getCountLeaderboard();
    expect(lb.map((e) => e.username)).toEqual(['four', 'three', 'two', 'one']);
    expect(lb.map((e) => e.value)).toEqual([4, 3, 2, 1]);
    expect(lb.map((e) => e.rank)).toEqual([1, 2, 3, 4]);

    const top2 = await getCountLeaderboard(2);
    expect(top2.map((e) => e.value), 'limit 取天数最多的前 N').toEqual([4, 3]);
  });

  it('无人签到返回空数组', async () => {
    await makeUser();
    expect(await getCountLeaderboard()).toEqual([]);
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

  it('天数并列时按「更早签到」升序（max(created_at) 次级排序键）', async () => {
    // 实现是 ORDER BY count(id) DESC, max(created_at) ASC（见 checkin-service.ts 注释）。
    // 三人各签 1 天、created_at 依次靠后 → 期望早签的人排前面。夹具必须给出**不同**的
    // created_at，否则这条断言在「次级排序键被删掉」时仍会绿（SQLite 恰好按插入序返回）。
    const early = await makeUser({ username: 'tieEarly' });
    const mid = await makeUser({ username: 'tieMid' });
    const late = await makeUser({ username: 'tieLate' });
    for (const [u, hour] of [
      [early, 9],
      [mid, 10],
      [late, 11],
    ] as const) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO daily_checkins (user_id, checkin_date, created_at) VALUES (?, ?, ?)`,
        u.id,
        dayAt('2026-07-01').getTime(),
        new Date(`2026-07-01T${String(hour).padStart(2, '0')}:30:00.000Z`).getTime()
      );
    }
    const lb = await getCountLeaderboard();
    expect(lb, '并列者一个都不能少').toHaveLength(3);
    expect(lb.map((e) => e.username)).toEqual(['tieEarly', 'tieMid', 'tieLate']);
    expect(lb.map((e) => e.rank), 'rank 按位次连续赋值（非竞赛式并列）').toEqual([1, 2, 3]);
  });
});

// ── 回归：DailyCheckIn.created_at ───────────────────────────────────────────
//
// created_at 必须显式写入：排行榜的并列次级排序键是 max(created_at)（见
// getCountLeaderboard 的注释）。Next 侧 schema 是 `createdAt DateTime?` 且**无
// @default(now())** —— 建行时不显式写就会落 NULL，次级排序键随之失效。

describe('DailyCheckIn.createdAt 落库', () => {
  it('checkIn 必须写入 createdAt，且走 nowForDb()（UTC+8 墙上时间），不是 NULL / 真实 UTC', async () => {
    freezeUtc('2026-07-15T04:00:00.000Z'); // UTC 04:00 = UTC+8 12:00
    const u = await makeUser();
    await checkIn(u.id);

    const row = await prisma.dailyCheckIn.findFirstOrThrow({ where: { userId: u.id } });
    // createdAt 落 NULL 会让排行榜的并列排序键 max(created_at) 静默失效；
    // 用 new Date() 则差 8 小时（库内时间戳约定为 UTC+8 墙上时间，见 db-time.ts）
    expect(row.createdAt!.toISOString()).toBe('2026-07-15T12:00:00.000Z');
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
