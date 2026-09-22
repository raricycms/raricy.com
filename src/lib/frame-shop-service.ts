// ─────────────────────────────────────────────────────────────────────────────
// frame-shop-service.ts — 鱼干商城：用鱼干**租**头像框
// · server-only
//
// 第一版头像框只有「站长发放」一条路（`npm run cli -- frame grant`）。
// 这里是第二条：用户自己花鱼干租，`1 鱼干 / 天`，自选 1–30 天。
// 价格与「哪些框在售」住 `frame-refs.ts`（**零依赖**，客户端也要读），
// 本文件只管**钱的这一侧**：校验、限频、算到期、扣鱼干、发框。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 三条必须记住的
// ═══════════════════════════════════════════════════════════════════════════════
//
// 【一】扣鱼干与发框**在同一个事务里**。
//   记账内核 `postEntry` 收调用方的 tx（见 fish-service.ts 头部），而授予的
//   事务体在 `frame-service.grantFrameTx` 里 —— 拆出那个函数就是为了这里。
//   分开写的后果是本站最忌讳的一种：**钱扣了、框没到**，而两边各自的日志都正常，
//   只有对账时才发现差额。反过来也一样危险：余额不足时**绝不能**留下半张框。
//   测试里有一条专门钉它（「余额不足 → 持有行也没建出来」）。
//
// 【二】★ 续期从**当前到期**起算，不是从「现在」★
//   `grantFrameTx` 的口径是「只延长不缩短」。若我们传 `now + N 天`：
//   一个还剩 20 天的人买 3 天 → 新的到期比原到期早 → **noop** → 鱼干照扣、
//   持有行一动没动，**且不报任何错**（用户只会觉得「买了没反应」）。
//   所以 base 取 `max(现在, 当前到期)` —— 等价于「在现有到期上加 N 天」。
//   ⚠️ base 的读取与 next 的计算**都在事务内**：读在事务外的话，两个并发购买会
//   同时从旧值起算，用户付两次只拿到一次（同样是静默的）。
//
// 【三】不登记幂等记录。
//   判据在 fish-idempotency.ts 头部：**键是确定的才登记**（同一次操作重跑必须
//   等价于没跑）。购买不是那种操作 —— 每次点击都是一笔**新的**交易，与练手盘
//   开仓同类。防重复提交是客户端的事（二次确认弹窗 + busy 锁），
//   服务端这侧由限频兜住。
//
// ═══════════════════════════════════════════════════════════════════════════════
// 两条业务判据（都容易被当成「多余」而删掉）
// ═══════════════════════════════════════════════════════════════════════════════
//
// 【素材缺失 → 拒卖（409）】与 §6.14 的 F3「素材缺失**不**阻止装备」**不矛盾**：
//   F3 管的是站长「先授权、后传素材」这个合法顺序 —— 那时候用户没花钱。
//   商城是**先收钱**：收完东西看不见，是纯粹的坏体验，而且用户没有任何自救手段
//   （他既不能退钱，也看不出问题在哪）。站长把图补上，按钮会自己出现
//   —— 这道闸只在「现在买」这一刻拦，不影响任何已有持有关系。
//
// 【已经是永久 → 拒卖（400）】永久是最大的到期（`laterExpiry` 里 null 压一切），
//   再买 N 天算出来的 next 一定短于它 → 又是一个 noop。同样的「扣钱不办事」，
//   同样不报错。这一支在事务内判，判到就直接返回、一个字都不写。
//
// ─────────────────────────────────────────────────────────────────────────────
// 权限档位：登录 + 非禁言，**不要求 core+** —— 与 /fish 面板、转账、练手盘同档
//（投喂要求 core+ 是因为它挂在博客页；花自己的鱼干是鱼干的通用能力）。
// 路由侧只认会话，理由写在 route.ts 的文件头。
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
  FRAME_RENT_MAX_DAYS,
  FRAME_RENT_MIN_DAYS,
  frameLabel,
  frameRentCost,
  parseFrameKey,
  parseRentDays,
  rentableFrameKeys,
  resolveFrameKey,
  type FrameKey,
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
  key: string;
  label: string;
  description: string;
  /** 鱼干 / 天。 */
  rentPerDay: number;
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
    return {
      key,
      label: def.label,
      description: def.description,
      // 有价才进得了这个列表（rentableFrameKeys 的判据），所以这里恒有值
      rentPerDay: def.rentPerDay ?? 0,
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
      days: number;
      /** 花了多少鱼干（= 天数 × 单价，整数）。 */
      cost: number;
      /** 租完之后的余额（鱼干）。 */
      balance: number;
      /** 新的到期时刻（绝对时刻）。 */
      expiresAt: Date;
    }
  | { ok: false; code: 400 | 409 | 429; message: string };

/**
 * 租一款框 `days` 天。
 *
 * 顺序：解析 key → 解析天数 → 素材在不在 → 限频 → **一个事务**（算到期 + 扣鱼干 + 发框）。
 * 前四步都不写库，所以任何一条没过都不会动余额（「刷不存在的框不该烧掉自己的额度」
 * 与转账同款）。
 */
export async function rentFrame(input: {
  userId: string;
  key: unknown;
  days: unknown;
}): Promise<RentOutcome> {
  const { userId } = input;

  const key = parseFrameKey(input.key);
  if (!key) {
    return { ok: false, code: 400, message: `未知的头像框：${String(input.key)}` };
  }
  const def = FRAMES[key];
  // 有 key 但没价 / 已退役 —— 这两件事对用户是同一句话：这款不在卖
  if (def.rentPerDay === undefined || def.retired) {
    return { ok: false, code: 400, message: `「${frameLabel(key) ?? key}」不在出售中` };
  }

  const days = parseRentDays(input.days);
  if (days === null) {
    // 文案里的区间直接从常量来 —— 写死数字的话，改上限时这句话会漂
    return {
      ok: false,
      code: 400,
      message: `天数必须是 ${FRAME_RENT_MIN_DAYS}~${FRAME_RENT_MAX_DAYS} 之间的整数`,
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

  // 单价 × 天数。frameRentCost 与商城面板读的是**同一个函数**，所以不存在
  // 「页面显示 1 鱼干、服务端扣 2 条」这种两边各算一次才会有的偏差。
  const cost = frameRentCost(key, days);
  if (cost === null) {
    // 上面两条已经判过 key 与 days，走到这里只可能是数据脏（价格非法）
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
      const next = new Date(start.getTime() + days * DAY_MS);

      // ── 2. 扣鱼干（余额不足在这里抛，整个事务回滚）────────────────────────
      await postEntry(tx, {
        userId,
        units: -units,
        type: FRAME_RENT_TYPE,
        description: `租用「${label}」${days} 天`,
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
        days,
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
