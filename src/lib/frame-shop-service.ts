// ─────────────────────────────────────────────────────────────────────────────
// frame-shop-service.ts — 鱼干商城：用鱼干**租**头像框（server-only）
// 两款两种计价单位：鱼干蓝 1 鱼干/天（1–30 天）、星落月畔 50 鱼干/月（1–12 个月）；单位与上下限
// 住 frame-refs.ts 的 RENT_UNITS（一个月固定 30 天），价格与在售也住那边（零依赖，客户端也读）。
// 本文件只管钱的这一侧：校验、限频、算到期、扣鱼干、发框。
// 【一】扣鱼干与发框同一个事务：postEntry 收调用方 tx，授予事务体在 frame-service.grantFrameTx。
//   分开写 = 钱扣了、框没到，两边日志都正常，只有对账发现差额；余额不足绝不能留半张框
//   （「余额不足 → 持有行也没建出来」有用例钉住）。
// 【二】续期从**当前到期**起算，不是从「现在」：grantFrameTx 只延长不缩短；传 now+N 天会让
//   还剩 20 天的人买 3 天后到期反而更早 → noop → 鱼干照扣、持有行不动且不报错。base 取
//   max(现在, 当前到期)；base 读取与 next 计算都在事务内，否则并发购买付两次只拿到一次。
// 【三】不登记幂等记录：判据在 fish-idempotency.ts 头部（键确定才登记）；购买每次点击都是
//   新的交易（同练手盘开仓），防重复提交是客户端的事（二次确认 + busy 锁），服务端由限频兜住。
// 【素材缺失 → 拒卖 409】与 F3「素材缺失不阻止装备」不矛盾：F3 是站长先授权后传素材
//   （那时用户没花钱）；商城先收钱，收完看不见且用户无自救手段，补图后按钮自己出现。
// 【已经是永久 → 拒卖 400】永久是最大到期（laterExpiry 里 null 压一切），再买 N 天算出的 next
//   一定更短 → 又是 noop；在事务内判，判到直接返回、一个字都不写。
// 权限档位由页面和 API 各自检查：core+ 且非禁言；历史无资格账号保留转出，不可新租商品。
// 路由侧只认会话，理由写在 route.ts 的文件头。
// 设计背景与取舍：docs/source-design-notes.md §3
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { nowForDb } from './db-time';
import { ymdhms } from './format';
import { postEntry, InsufficientFishError } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import { rateLimit, RULES } from './rate-limit';
import { frameAssetAvailable, grantFrameTx } from './frame-service';
import {
  FRAMES,
  RENT_UNITS,
  frameLabel,
  frameRentCost,
  frameSaleOf,
  parseFrameKey,
  parseRentCount,
  rentableFrameKeys,
  resolveFrameKey,
  type FrameKey,
  type RentUnit,
} from './frame-refs';

/**
 * 租框流水的 type。
 *
 * ⚠️ **别用 `purchase`** —— 那个词在鱼干语境里已经是「收银台 / 收款码付款」
 *（见 `docs/bot/fish-bot.md` 的流水类型表），撞名会让对账方把两种钱认成一笔。
 */
export const FRAME_RENT_TYPE = 'frame_rent';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 商城列表里的一件商品（**判定后的结果**，客户端不做任何判断）。 */
export interface ShopItem {
  /**
   * 恒是一个**白名单内的** FrameKey —— 列表来自 `rentableFrameKeys()`，
   * 所以不像 `MyFrameRow.key`（那里要容忍库里存着已退役 / 未知的 key）。
   * 钉成 `FrameKey` 是为了让客户端能直接 `frameUrl(key)` 拼预览地址。
   */
  key: FrameKey;
  label: string;
  description: string;
  /**
   * 计价单位 + 单价（`价格 鱼干 / unit`）。
   *
   * ⚠️ 上下限与量词**不在这里** —— 面板拿 `RENT_UNITS[unit]` 现读（那是零依赖的
   * 同一份表，服务端校验读的也是它）。DTO 里再抄一份，改上限时两边就会分叉。
   */
  rent: { unit: RentUnit; price: number };
  /**
   * 盘上没有素材 —— 商城照常陈列，但**买不了**（见文件头「素材缺失 → 拒卖」）。
   * 站长补上图之后这个值自己变 false，什么都不用重启。
   */
  assetMissing: boolean;
  /**
   * 我当前的持有状态；null = 从没持有过、或已被收回。
   *
   * ⚠️ `expiresAt` 是**展示串**（`YYYY-MM-DD HH:MM:SS`，UTC+8 口径），
   * `expired` 是**服务端算好的**布尔 —— 客户端一次都不做时间比较
   *（见 frame-refs.ts 头部的到期判定，以及 db-time-guard 规则 3–5）。
   */
  holding: { expiresAt: string | null; expired: boolean } | null;
  /** 我现在正戴着它。 */
  equipped: boolean;
}

/**
 * 商城里在售的东西 + 我自己的持有状态 —— /fish/market 页面的数据源。
 *
 * 只列 `rentableFrameKeys()`（有价且未退役）—— **站长发的那五款不在这里出现**，
 * 它们本来就不是商品。用户手上有没有它们与商城无关，所以这里也不列。
 */
export async function listShopItems(userId: string): Promise<ShopItem[]> {
  const keys = rentableFrameKeys();
  if (keys.length === 0) return [];

  const now = nowForDb();

  const [rows, user] = await Promise.all([
    prisma.userFrame.findMany({
      where: { userId, frameKey: { in: keys } },
      select: { frameKey: true, expiresAt: true, deleted: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { equippedFrameKey: true },
    }),
  ]);

  const byKey = new Map(rows.filter((r) => !r.deleted).map((r) => [r.frameKey, r]));
  const equippedKey = user?.equippedFrameKey ?? null;

  return keys.map((key) => {
    const def = FRAMES[key];
    const row = byKey.get(key);
    // `frameSaleOf` 是「能不能卖」的唯一出口，而列表本来就来自 `rentableFrameKeys()`
    // —— 所以这里恒有值。走同一个出口而不是直接读 `def.rent`：将来在售判据多加一条
    // （比如限时上架）时，这里跟着变，不会出现「列出来了却算不出价」。
    const sale = frameSaleOf(key)!;
    return {
      key,
      label: def.label,
      description: def.description,
      rent: sale,
      assetMissing: !frameAssetAvailable(key),
      holding: row
        ? {
            expiresAt: ymdhms(row.expiresAt),
            // 复用唯一的比较：白名单与退役上面已判过，走到这里失败只可能是过期
            expired: resolveFrameKey(key, row.expiresAt, now) === null,
          }
        : null,
      equipped: equippedKey === key,
    };
  });
}

/**
 * 租用的**业务结果**（不是故障）。
 *
 * 真故障走异常往上抛（事务炸了、DB 锁了），由路由转 500 —— 见 rentFrame 末尾。
 * 这个联合里只有「用户做了什么 / 系统拦了什么」这一类可以解释给人听的结果。
 */
export type RentOutcome =
  | {
      ok: true;
      key: FrameKey;
      label: string;
      /** 租了几个单位（天 / 月）—— 与下面的 `unit` 合起来才是「租了多久」。 */
      count: number;
      unit: RentUnit;
      /** 花了多少鱼干（= 单位数 × 单价，整数）。 */
      cost: number;
      /** 租完之后的余额（鱼干）。 */
      balance: number;
      /** 新的到期时刻（绝对时刻）。 */
      expiresAt: Date;
    }
  | { ok: false; code: 400 | 409 | 429; message: string };

/**
 * 租一款框 `count` 个「该款的计价单位」（天 / 月）。
 *
 * 顺序：解析 key → 解析数量 → 素材在不在 → 限频 → **一个事务**（算到期 + 扣鱼干 + 发框）。
 * 前四步都不写库，所以任何一条没过都不会动余额（「刷不存在的框不该烧掉自己的额度」
 * 与转账同款）。
 *
 * ⚠️ **单位由框自己决定，不由调用方传** —— `count` 一律按 `FRAMES[key].rent.unit`
 *    去判区间。让调用方传单位的话，「传了月、框是按天的」会静默按月的区间放行。
 */
export async function rentFrame(input: {
  userId: string;
  key: unknown;
  count: unknown;
}): Promise<RentOutcome> {
  const { userId } = input;

  const key = parseFrameKey(input.key);
  if (!key) {
    return { ok: false, code: 400, message: `未知的头像框：${String(input.key)}` };
  }
  const def = FRAMES[key];
  // 没配价 / 已退役 —— 对用户是同一句话：这款不在卖。
  // ⚠️ 这里**刻意不平移到 `frameSaleOf`**：那个出口（商城在架清单用的）把「非正数」
  //    也并进「不卖」，而接口对「站长把价配成 0」要说得更具体 —— 走到下面的
  //    `cost === null` 那条，回「租金配置有误」。两种写法在页面上看不出差别，
  //    但运维排查时「不在卖」与「配错了」是两句不同的话。
  if (def.rent === undefined || def.retired) {
    return { ok: false, code: 400, message: `「${frameLabel(key) ?? key}」不在出售中` };
  }
  const { unit } = def.rent;

  const count = parseRentCount(unit, input.count);
  if (count === null) {
    // 文案里的区间与量词都从单位表现取 —— 写死数字的话，改上限时这句话会漂
    const { min, max, noun } = RENT_UNITS[unit];
    return {
      ok: false,
      code: 400,
      message: `租期必须是 ${min}~${max} ${noun}之间的整数`,
    };
  }

  if (!frameAssetAvailable(key)) {
    return { ok: false, code: 409, message: '这款头像框的素材还没传上来，暂时买不了' };
  }

  const hourly = rateLimit(`framerent:h:${userId}`, RULES.frameRentHourly);
  const daily = rateLimit(`framerend:d:${userId}`, RULES.frameRentDaily);
  if (!hourly.allowed || !daily.allowed) {
    return { ok: false, code: 429, message: '租得太频繁了，请稍后再试' };
  }

  // 单价 × 单位数。frameRentCost 与商城面板读的是**同一个函数**，所以不存在
  // 「页面显示 1 鱼干、服务端扣 2 条」这种两边各算一次才会有的偏差。
  const cost = frameRentCost(key, count);
  if (cost === null) {
    // 上面两条已经判过 key 与 count，走到这里只可能是数据脏（价格非法）
    return { ok: false, code: 400, message: '这款头像框的租金配置有误，请联系站长' };
  }

  let units: number;
  try {
    units = fishToUnits(cost);
  } catch {
    // fishToUnits 对超精度 fail-loud（抛普通 Error）。不接住的话它会冒泡成 500，
    // 而那其实是「站长把单价配成了 0.00005」这种配置问题 —— 照转账的接法转成 400。
    return { ok: false, code: 400, message: '租金精度超出支持范围，请联系站长' };
  }

  const label = frameLabel(key) ?? key;

  try {
    const applied = await prisma.$transaction(async (tx) => {
      // ── 1. 读当前持有行，算出**新的到期时刻**（口径见文件头【二】）──────────
      const row = await tx.userFrame.findUnique({
        where: { uq_user_frame: { userId, frameKey: key } },
        select: { expiresAt: true, deleted: true },
      });
      const alive = row !== null && !row.deleted;

      if (alive && row.expiresAt === null) {
        // 永久 —— 再买是纯粹的浪费（见文件头【二】的第二条判据）。一个字都不写。
        return { ok: false as const, code: 400 as const, message: '你已经是永久拥有这款框了，不用再租' };
      }

      const now = nowForDb();
      // 墓碑行不参与取 base（F4 同款理由：那是上一次已被收回的授权）。
      // 已经过期的人：base 落在过去 → 下面 max 一下，与「没持有过」同解，从**现在**起算
      //（否则买来的天数全花在已经过去的日子上，等于白买）。
      const base = alive && row ? row.expiresAt : null;
      const start = base && base.getTime() > now.getTime() ? base : now;
      // 一个单位几天由单位表给（月 = 30 天）—— **别在这里写死 30**：那样改口径时
      // 页面上的「2 个月」与实际的 60 天会分叉，而两边各自的代码看着都对。
      const next = new Date(start.getTime() + count * RENT_UNITS[unit].days * DAY_MS);

      // ── 2. 扣鱼干（余额不足在这里抛，整个事务回滚）────────────────────────
      await postEntry(tx, {
        userId,
        units: -units,
        type: FRAME_RENT_TYPE,
        description: `租用「${label}」${count} ${RENT_UNITS[unit].noun}`,
        referenceType: 'frame',
        referenceId: key,
      });

      // ── 3. 发框（同一事务；F1 的唯一写入者、F2 的装备列同步都在里面）──────
      const granted = await grantFrameTx(tx, {
        userId,
        key,
        expiresAt: next,
        source: 'purchase',
      });
      if (!granted.ok) {
        // 上面每一项都判过了，走到这里说明是事务内才暴露的问题。
        // **必须抛** —— 返回错误对象只代表「grantFrameTx 没写库」，而我们
        // 前面已经扣过鱼干了，不抛就是「钱扣了、框没到」。
        throw new Error(`rentFrame: grantFrameTx 失败（${granted.code}）${granted.message}`);
      }

      // 读回最新余额（仍在事务中，故为本事务可见的最新状态）
      const after = await tx.user.findUnique({
        where: { id: userId },
        select: { driedFish: true },
      });

      return {
        ok: true as const,
        key,
        label,
        count,
        unit,
        cost,
        balance: unitsToFish(after?.driedFish ?? 0),
        // 用 grantFrameTx **回读的**到期时刻，而不是我们算的那个局部变量 ——
        // 外发的是库里真正生效的值，两者将来若因某条规则分叉，用户看到的也是真的。
        expiresAt: granted.expiresAt ?? next,
      };
    });

    return applied;
  } catch (e) {
    if (e instanceof InsufficientFishError) {
      // 业务结果，不是故障：余额不足时整个事务回滚，**框也没有发出去**
      return { ok: false, code: 400, message: '小鱼干不足' };
    }
    // 其余一律**往上抛**，由路由统一转 500。不在这里编一个「请稍后再试」的
    // 400 —— 那会让真故障在日志之外完全看不出来（与 transferFish 同款分工：
    // 服务层只回业务结果，故障是路由的事）。
    throw e;
  }
}
