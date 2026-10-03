// frame-shop-service.test.ts —— 鱼干商城：用鱼干租头像框
//
// 【这个文件重点保什么】
//  1. ★ **原子性**：余额不足时**绝不能**留下半张框（钱与框要么一起动、要么都不动）。
//     这是本次新功能里唯一一处「写错了会静默弄坏账目」的地方 —— 用户付了钱没拿到
//     东西，或者拿到了东西没付钱，两边各自的日志都正常。
//  2. ★ **续期从当前到期起算，不是从现在**。写成 `now + N 天` 的话，一个还剩 20 天
//     的人买 3 天会走到 grantFrameTx 的 noop 分支 —— **鱼干照扣、到期一动没动、
//     不报任何错**。这条用例是唯一能抓住它的东西。
//  3. 各种「扣钱不办事」的边界：永久持有、素材缺失、天数越界。
//  4. 记账不变式（余额 == 流水之和），附着在上面这些真实业务用例上。
//
// 【磁盘安全】只碰 tests/.tmp/frames-shop-test/，绝不碰 ./public/static/frames 的真实素材。

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';

// ⚠️ 必须在 import 服务层之前设好 —— framesRoot() 每次读 env，但写在最前面最不容易误解。
const TEST_FRAMES_DIR = path.resolve(import.meta.dirname, '../.tmp/frames-shop-test');
process.env.FRAMES_DIR = TEST_FRAMES_DIR;

import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { unitsToFish } from '@/lib/fish-units';
import { resetDb } from '../helpers/db';
import { makeFishUser, expectLedgerConsistent } from '../helpers/fish-ledger';
import {
  __resetFrameAssetCacheForTests,
  equipFrame,
  frameUrlFor,
  grantFrame,
  revokeFrame,
} from '@/lib/frame-service';
import { rentFrame, listShopItems, FRAME_RENT_TYPE } from '@/lib/frame-shop-service';
import { FRAME_KEYS, FRAMES, RENT_UNITS, frameUrl, rentableFrameKeys } from '@/lib/frame-refs';

/** 按天卖的那款（key 与价格都从源码取，别在这里写死 —— 改价时用例不该跟着改）。 */
const KEY = 'fishblue';
/** 按月卖的那款 —— 「单位」那几条用例用它。 */
const MONTHLY_KEY = 'starmoon';
/** 一款**不零售**的框（站长发放的那种），用来验「不在出售中」。 */
const NOT_FOR_SALE = FRAME_KEYS.find((k) => FRAMES[k].rent === undefined)!;

const PRICE = FRAMES[KEY].rent!.price;
const MONTHLY_PRICE = FRAMES[MONTHLY_KEY].rent!.price;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 硬校验：素材目录必须在 tests/.tmp/ 下，否则直接抛（防误动真实素材）。 */
function assertTempDir() {
  if (!TEST_FRAMES_DIR.includes(`${path.sep}tests${path.sep}.tmp${path.sep}`)) {
    throw new Error(`拒绝在非临时目录上跑商城用例：${TEST_FRAMES_DIR}`);
  }
}

/** 最小合法 PNG 字节。这一层只问「盘上有没有这个文件」，不解码像素。 */
const PNG_HEAD = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);

function writeAsset(key: string) {
  fs.mkdirSync(TEST_FRAMES_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_FRAMES_DIR, `${key}.png`), PNG_HEAD);
}

/** 盘上放好素材 + 清掉扫盘缓存。**每个用例开头都要调** —— 缓存是模块级的。 */
function withAsset(key: string) {
  writeAsset(key);
  __resetFrameAssetCacheForTests();
}

function withoutAsset() {
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
  __resetFrameAssetCacheForTests();
}

beforeAll(() => {
  assertTempDir();
});

afterAll(() => {
  assertTempDir();
  fs.rmSync(TEST_FRAMES_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  assertTempDir();
  withoutAsset();
  await resetDb();
});

/** 读余额（鱼干）。 */
async function balanceOf(userId: string): Promise<number> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { driedFish: true } });
  return unitsToFish(u?.driedFish ?? 0);
}

/** 读持有行（含墓碑）。 */
function holdingOf(userId: string, key = KEY) {
  return prisma.userFrame.findUnique({
    where: { uq_user_frame: { userId, frameKey: key } },
    select: { expiresAt: true, deleted: true, source: true },
  });
}

// ── 商城列表 ────────────────────────────────────────────────────────────────

describe('listShopItems —— 商城只陈列在售的框', () => {
  it('只列有价的框，站长发放的那几款不出现', async () => {
    withAsset(KEY);
    const user = await makeFishUser(0);
    const items = await listShopItems(user.id);

    // 在售清单是 `rentableFrameKeys()` 现算的 —— 别写死条数，加一款在售的框时
    // 这条断言不该跟着改（写了 1 的那一版在星落月畔上架时会当场红）
    expect(items.map((i) => i.key)).toEqual(rentableFrameKeys());
    expect(items.length).toBeGreaterThan(0);
    const [fish] = items;
    expect(fish.key).toBe(KEY);
    expect(fish.rent).toEqual({ unit: 'day', price: PRICE });
    // 没买过 → 没有持有状态
    expect(fish.holding).toBeNull();
    expect(fish.equipped).toBe(false);
    expect(fish.assetMissing).toBe(false);
  });

  it('两款在售的框各自带着自己的计价单位（天 / 月）', async () => {
    const user = await makeFishUser(0);
    const items = await listShopItems(user.id);

    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get(KEY)!.rent).toEqual({ unit: 'day', price: PRICE });
    expect(byKey.get(MONTHLY_KEY)!.rent).toEqual({ unit: 'month', price: MONTHLY_PRICE });
  });

  it('素材缺失时照常陈列，但标着 assetMissing（页面据此禁掉购买）', async () => {
    const user = await makeFishUser(0);
    const items = await listShopItems(user.id);

    // 盘上一张图都没有 → 每一款都标着素材缺失（条数由 rentableFrameKeys 决定）
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.assetMissing)).toBe(true);
  });

  it('持有与装备状态都如实带出来', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    await rentFrame({ userId: user.id, key: KEY, count: 3 });
    await equipFrame(user.id, KEY);

    const [item] = await listShopItems(user.id);
    expect(item.equipped).toBe(true);
    expect(item.holding?.expired).toBe(false);
    expect(item.holding?.expiresAt).not.toBeNull();
  });

  it('过期由**服务端**判好（客户端一次都不做时间比较）', async () => {
    withAsset(KEY);
    const user = await makeFishUser(0);
    // 到期时刻放在过去。注意这里只能走 grantFrame —— equipFrame 会正确地拒绝
    // 一个已过期的框（F3），所以「已过期」与「戴着」在数据上不会同时成立。
    await grantFrame({
      userId: user.id,
      key: KEY,
      expiresAt: new Date(nowForDb().getTime() - DAY_MS),
    });

    const [item] = await listShopItems(user.id);
    expect(item.holding?.expired).toBe(true);
    expect(item.equipped).toBe(false);
  });
});

// ── 正常租用 ────────────────────────────────────────────────────────────────

describe('rentFrame —— 正常租用', () => {
  it('扣对钱、建出持有行、到期 = 现在 + 天数、来源是 purchase', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    const before = nowForDb();

    const res = await rentFrame({ userId: user.id, key: KEY, count: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.count).toBe(3);
    expect(res.cost).toBe(3 * PRICE);
    expect(res.balance).toBeCloseTo(10 - 3 * PRICE, 4);

    const row = await holdingOf(user.id);
    expect(row?.deleted).toBe(false);
    expect(row?.source).toBe('purchase');
    // 允许测试自身耗掉的毫秒：到期落在 [before + 3 天, now + 3 天] 这个极窄区间里
    const expectedLo = before.getTime() + 3 * DAY_MS;
    const expectedHi = nowForDb().getTime() + 3 * DAY_MS;
    expect(row!.expiresAt!.getTime()).toBeGreaterThanOrEqual(expectedLo);
    expect(row!.expiresAt!.getTime()).toBeLessThanOrEqual(expectedHi);

    // 回给界面的到期时刻 = 库里那个（不是另算的一份）
    expect(res.expiresAt.getTime()).toBe(row!.expiresAt!.getTime());
    expect(await balanceOf(user.id)).toBeCloseTo(10 - 3 * PRICE, 4);

    await expectLedgerConsistent();
  });

  it('写一行 frame_rent 流水，带着框的 key 与租期', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    await rentFrame({ userId: user.id, key: KEY, count: 2 });

    const txs = await prisma.fishTransaction.findMany({
      where: { userId: user.id, type: FRAME_RENT_TYPE },
    });
    expect(txs).toHaveLength(1);
    expect(txs[0].referenceType).toBe('frame');
    expect(txs[0].referenceId).toBe(KEY);
    expect(unitsToFish(txs[0].amount)).toBeCloseTo(-2 * PRICE, 4);
    expect(txs[0].description).toContain('2 天');
  });

  it('★ 按月卖的那款：2 个月 = 100 鱼干，到期 = 现在 + 60 天', async () => {
    withAsset(MONTHLY_KEY);
    const user = await makeFishUser(MONTHLY_PRICE * 3);
    const before = nowForDb();

    const res = await rentFrame({ userId: user.id, key: MONTHLY_KEY, count: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.unit).toBe('month');
    expect(res.count).toBe(2);
    expect(res.cost).toBe(2 * MONTHLY_PRICE);

    // 一个月 = 30 天，**不是**自然月：2 个月恒是 60 天，与今天几号无关
    const row = await holdingOf(user.id, MONTHLY_KEY);
    const expectedLo = before.getTime() + 2 * RENT_UNITS.month.days * DAY_MS;
    const expectedHi = nowForDb().getTime() + 2 * RENT_UNITS.month.days * DAY_MS;
    expect(row!.expiresAt!.getTime()).toBeGreaterThanOrEqual(expectedLo);
    expect(row!.expiresAt!.getTime()).toBeLessThanOrEqual(expectedHi);

    // 流水描述用的是量词而不是「天」
    const txs = await prisma.fishTransaction.findMany({
      where: { userId: user.id, type: FRAME_RENT_TYPE },
    });
    expect(txs[0].description).toContain('2 个月');
    await expectLedgerConsistent();
  });

  it('上限数量（按天那款是 30）买得动', async () => {
    withAsset(KEY);
    const user = await makeFishUser(100);
    const res = await rentFrame({ userId: user.id, key: KEY, count: RENT_UNITS.day.max });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cost).toBe(RENT_UNITS.day.max * PRICE);
    await expectLedgerConsistent();
  });

  it('天数接受数字字符串（表单交上来就是字符串）', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    const res = await rentFrame({ userId: user.id, key: KEY, count: '2' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.count).toBe(2);
  });
});

// ── ★ 原子性 ────────────────────────────────────────────────────────────────

describe('★ 原子性：钱与框要么一起动、要么都不动', () => {
  it('余额不足 → 余额没变、框也没建出来、一行流水都没有', async () => {
    withAsset(KEY);
    const user = await makeFishUser(1); // 只够 1 天

    const res = await rentFrame({ userId: user.id, key: KEY, count: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(400);
      expect(res.message).toContain('小鱼干不足');
    }

    expect(await balanceOf(user.id)).toBeCloseTo(1, 4);
    expect(await holdingOf(user.id)).toBeNull();
    expect(await prisma.fishTransaction.count({ where: { userId: user.id, type: FRAME_RENT_TYPE } })).toBe(0);
    await expectLedgerConsistent();
  });

  it('余额刚好够 → 买完是 0，不是负数', async () => {
    withAsset(KEY);
    const user = await makeFishUser(2);
    const res = await rentFrame({ userId: user.id, key: KEY, count: 2 });
    expect(res.ok).toBe(true);
    expect(await balanceOf(user.id)).toBe(0);
    await expectLedgerConsistent();
  });

  it('已经持有且过期的人，钱不够时那条旧持有行也不受影响', async () => {
    withAsset(KEY);
    const user = await makeFishUser(0);
    // 造一条**已过期**的持有行（0 余额，续租必然失败）
    const past = new Date(nowForDb().getTime() - DAY_MS);
    await grantFrame({ userId: user.id, key: KEY, expiresAt: past });

    const res = await rentFrame({ userId: user.id, key: KEY, count: 1 });
    expect(res.ok).toBe(false);

    const row = await holdingOf(user.id);
    expect(row?.expiresAt?.getTime()).toBe(past.getTime());
    expect(row?.deleted).toBe(false);
  });
});

// ── ★ 续期口径 ──────────────────────────────────────────────────────────────

describe('★ 续期从「当前到期」起算，不是从「现在」', () => {
  it('还剩 20 天的人买 1 天 → 到期 = 原到期 + 1 天（不是 now + 1 天）', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);

    const initial = new Date(nowForDb().getTime() + 20 * DAY_MS);
    await grantFrame({ userId: user.id, key: KEY, expiresAt: initial });

    const res = await rentFrame({ userId: user.id, key: KEY, count: 1 });
    expect(res.ok).toBe(true);

    const row = await holdingOf(user.id);
    // 差 1 天与差 20 天在这里分得很开 —— 写成 now + N 的话这条会整整差 20 天
    expect(row!.expiresAt!.getTime()).toBe(initial.getTime() + DAY_MS);
    await expectLedgerConsistent();
  });

  it('连着买两次，天数累加', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    await rentFrame({ userId: user.id, key: KEY, count: 2 });
    const after1 = (await holdingOf(user.id))!.expiresAt!;
    await rentFrame({ userId: user.id, key: KEY, count: 3 });
    const after2 = (await holdingOf(user.id))!.expiresAt!;

    expect(after2.getTime()).toBe(after1.getTime() + 3 * DAY_MS);
    await expectLedgerConsistent();
  });

  it('已过期的人续租 → 从**现在**起算（不是从那个过去的到期时刻）', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    const past = new Date(nowForDb().getTime() - 5 * DAY_MS);
    await grantFrame({ userId: user.id, key: KEY, expiresAt: past });

    const before = nowForDb();
    const res = await rentFrame({ userId: user.id, key: KEY, count: 2 });
    expect(res.ok).toBe(true);

    const row = await holdingOf(user.id);
    // 从过去那个点起算的话会算出「3 天前到期」—— 买了两天等于什么都没买到
    expect(row!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 2 * DAY_MS);
    await expectLedgerConsistent();
  });

  it('正戴着这个框时续租，装备列的到期时刻跟着刷新（F2 走商城这条路的用例）', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    await rentFrame({ userId: user.id, key: KEY, count: 1 });
    await equipFrame(user.id, KEY);

    const res = await rentFrame({ userId: user.id, key: KEY, count: 5 });
    expect(res.ok).toBe(true);

    const u = await prisma.user.findUnique({
      where: { id: user.id },
      select: { equippedFrameKey: true, equippedFrameExpiresAt: true },
    });
    const row = await holdingOf(user.id);
    // 两处必须**逐毫秒**相等：不等的话框会在续期后提前消失（看起来像浏览器缓存）
    expect(u!.equippedFrameExpiresAt!.getTime()).toBe(row!.expiresAt!.getTime());
    // 顺带钉住整条链真的通：唯一的判定出口拿这两列算得出贴图地址
    //（素材在盘上 + 未过期 + 未退役 + 白名单，四道闸全过）
    expect(frameUrlFor(u)).toBe(frameUrl(KEY));
  });
});

// ── 各种「扣钱不办事」的边界 ────────────────────────────────────────────────

describe('拒绝的几种情形（一律不扣钱）', () => {
  it('★ 已经是永久持有 → 400，且一个字都不写', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    await grantFrame({ userId: user.id, key: KEY, expiresAt: null });

    const res = await rentFrame({ userId: user.id, key: KEY, count: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(400);

    expect(await balanceOf(user.id)).toBeCloseTo(10, 4);
    expect(await prisma.fishTransaction.count({ where: { userId: user.id, type: FRAME_RENT_TYPE } })).toBe(0);
    expect((await holdingOf(user.id))!.expiresAt).toBeNull();
    await expectLedgerConsistent();
  });

  it('素材缺失 → 409，不扣钱也不建持有行', async () => {
    // 注意：这里**故意不调 withAsset**
    const user = await makeFishUser(10);
    const res = await rentFrame({ userId: user.id, key: KEY, count: 1 });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(409);
    expect(await balanceOf(user.id)).toBeCloseTo(10, 4);
    expect(await holdingOf(user.id)).toBeNull();
    await expectLedgerConsistent();
  });

  it('不零售的框 → 400（它是站长发放的，不是商品）', async () => {
    withAsset(NOT_FOR_SALE);
    const user = await makeFishUser(10);
    const res = await rentFrame({ userId: user.id, key: NOT_FOR_SALE, count: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(400);
    expect(await balanceOf(user.id)).toBeCloseTo(10, 4);
  });

  it('未登记的 key → 400', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    const res = await rentFrame({ userId: user.id, key: 'not-a-frame', count: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(400);
  });

  it('★ 价配成 0（「免费框」的写法）→ 400，不是 500', async () => {
    // 免费租借这条路根本不存在 —— 记账内核拒收 0 单位（postEntry 抛）。判成
    // 「不可租」之后，这里必须是一条正常的业务拒绝；不判的话用户看到的是
    // 「服务器开小差了」，而页面上还显示「合计 0 鱼干、按钮可点」。
    withAsset(KEY);
    const user = await makeFishUser(10);
    const saved = FRAMES[KEY].rent;
    FRAMES[KEY] = { ...FRAMES[KEY], rent: { unit: 'day', price: 0 } };
    try {
      const res = await rentFrame({ userId: user.id, key: KEY, count: 1 });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(400);
        // 「配成了 0」与「压根没配」刻意报不同的两句：前者是站长的配置错误，
        // 后者是「这款不卖」。并成一句的话，运维在日志里分不出该不该去改配置。
        expect(res.message).toContain('配置有误');
      }
    } finally {
      FRAMES[KEY] = { ...FRAMES[KEY], rent: saved };
    }
    expect(await balanceOf(user.id)).toBeCloseTo(10, 4); // 一分没扣
    await expectLedgerConsistent('价配错时被拒');
  });

  it('数量越界（0 / 31 / 1.5 / 空 / 非数 / 科学计数法）→ 400，且不扣钱', async () => {
    withAsset(KEY);
    const user = await makeFishUser(1000);
    for (const count of [0, -1, RENT_UNITS.day.max + 1, 1.5, '', 'abc', null, undefined, {}, '1e2', []]) {
      const res = await rentFrame({ userId: user.id, key: KEY, count });
      expect(res.ok, `count=${JSON.stringify(count)} 应当被拒`).toBe(false);
      if (!res.ok) expect(res.code).toBe(400);
    }
    expect(await balanceOf(user.id)).toBeCloseTo(1000, 4);
    expect(await holdingOf(user.id)).toBeNull();
  });

  it('★ 越界是按**框自己的单位**判的：13 对按天的合法、对按月的非法', async () => {
    withAsset(KEY);
    withAsset(MONTHLY_KEY);
    const user = await makeFishUser(10000);

    // 同一个 13，两款框给出相反的结果 —— 单位若由调用方传（或两处各判一次），
    // 这里就会出现「按月的框被按天的区间放行」
    const day = await rentFrame({ userId: user.id, key: KEY, count: 13 });
    expect(day.ok).toBe(true);

    const night = await rentFrame({ userId: user.id, key: MONTHLY_KEY, count: 13 });
    expect(night.ok).toBe(false);
    if (!night.ok) expect(night.code).toBe(400);

    await expectLedgerConsistent('月框越界被拒');
  });

  it('墓碑行（被站长收回过）不参与续期 —— 从**现在**起算重新复活', async () => {
    withAsset(KEY);
    const user = await makeFishUser(10);
    // 一条很久以后才到期的持有行 → 收回 → 留下墓碑
    const farFuture = new Date(nowForDb().getTime() + 100 * DAY_MS);
    await grantFrame({ userId: user.id, key: KEY, expiresAt: farFuture });
    await revokeFrame({ userId: user.id, key: KEY });

    const before = nowForDb();
    const res = await rentFrame({ userId: user.id, key: KEY, count: 2 });
    expect(res.ok).toBe(true);

    const row = await holdingOf(user.id);
    expect(row!.deleted).toBe(false);
    // 若把墓碑上那个「100 天后」当成基准，会买到 102 天后 —— 那是上一次已被收回的授权
    expect(row!.expiresAt!.getTime()).toBeLessThanOrEqual(before.getTime() + 2 * DAY_MS + 5_000);
    await expectLedgerConsistent();
  });
});
