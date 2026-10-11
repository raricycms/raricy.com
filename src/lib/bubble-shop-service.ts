// 气泡租赁：与扣款同事务授予，续期基准在事务内读取，防并发少发租期。
// 每次确认是一笔新租赁，沿用头像框的确认弹窗/busy/限频，不登记随机幂等键。
import { prisma } from './db';
import { nowForDb } from './db-time';
import { ymdhms } from './format';
import { postEntry, InsufficientFishError } from './fish-service';
import { fishToUnits, unitsToFish } from './fish-units';
import { grantBubbleTx, pushBubbleRefresh } from './bubble-service';
import { BUBBLES, bubbleSaleOf, bubbleRentCost, isBubbleExpired, parseBubbleKey, rentableBubbleKeys } from './bubble-refs';
import { RENT_UNITS, parseRentCount } from './shop-refs';
import { rateLimit, RULES } from './rate-limit';

export const BUBBLE_RENT_TYPE = 'bubble_rent';
export async function listBubbleShopItems(userId: string) {
  const [rows, user] = await Promise.all([
    prisma.userBubble.findMany({ where: { userId, deleted: false } }),
    prisma.user.findUnique({ where: { id: userId }, select: { equippedBubbleKey: true } }),
  ]);
  const now = nowForDb();
  return rentableBubbleKeys().map((key) => {
    const row = rows.find((r) => r.bubbleKey === key);
    return {
      kind: 'bubble' as const, key, label: BUBBLES[key].label, description: BUBBLES[key].description,
      rent: bubbleSaleOf(key)!, assetMissing: false,
      holding: row ? { expiresAt: ymdhms(row.expiresAt), expired: isBubbleExpired(row.expiresAt, now) } : null,
      equipped: user?.equippedBubbleKey === key,
    };
  });
}
export async function rentBubble(input: { userId: string; key: unknown; count: unknown }) {
  const key = parseBubbleKey(input.key);
  const sale = key ? bubbleSaleOf(key) : null;
  if (!key || !sale) return { ok: false as const, code: 400, message: '这款聊天气泡不在出售中' };
  const count = parseRentCount(sale.unit, input.count);
  if (count === null) return { ok: false as const, code: 400, message: `租期必须是 ${RENT_UNITS[sale.unit].min}~${RENT_UNITS[sale.unit].max} ${RENT_UNITS[sale.unit].noun}之间的整数` };
  const cost = bubbleRentCost(key, count)!;
  let units: number;
  try { units = fishToUnits(cost); }
  catch { return { ok: false as const, code: 400, message: '租金配置有误，请联系站长' }; }
  // 与头像框共用商城租赁额度，换商品类型不能绕过限频。
  const hourly = rateLimit(`framerent:h:${input.userId}`, RULES.frameRentHourly);
  const daily = rateLimit(`framerend:d:${input.userId}`, RULES.frameRentDaily);
  if (!hourly.allowed || !daily.allowed) return { ok: false as const, code: 429, message: '租得太频繁了，请稍后再试' };
  try {
    const result = await prisma.$transaction(async (tx) => {
      const old = await tx.userBubble.findUnique({ where: { uq_user_bubble: { userId: input.userId, bubbleKey: key } } });
      if (old && !old.deleted && old.expiresAt === null) return { ok: false as const, code: 400, message: '你已永久拥有这款聊天气泡，不用再租' };
      const now = nowForDb();
      const start = old && !old.deleted && old.expiresAt && old.expiresAt > now ? old.expiresAt : now;
      const expiresAt = new Date(start.getTime() + count * RENT_UNITS[sale.unit].days * 86400000);
      await postEntry(tx, { userId: input.userId, units: -units, type: BUBBLE_RENT_TYPE,
        description: `租用「${BUBBLES[key].label}」${count} ${RENT_UNITS[sale.unit].noun}`, referenceType: 'bubble', referenceId: key });
      const granted = await grantBubbleTx(tx, { userId: input.userId, key, expiresAt, source: 'purchase' });
      const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { driedFish: true } });
      return { ok: true as const, key, label: BUBBLES[key].label, count, unit: sale.unit, cost,
        balance: unitsToFish(user.driedFish), expiresAt: granted.expiresAt! };
    });
    if (result.ok) pushBubbleRefresh();
    return result;
  } catch (e) {
    if (e instanceof InsufficientFishError) return { ok: false as const, code: 400, message: '小鱼干不足' };
    throw e;
  }
}
