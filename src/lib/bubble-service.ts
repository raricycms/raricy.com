// 气泡持有与装备的唯一写入者。权威在 user_bubbles，users 装备列是副本：
// 授予/续期/撤销与副本刷新同事务；墓碑复活原行；卸下无条件可用。
// 到期只读判定，不引入后台扫库。聊天历史按作者当前装备展示，不存消息快照。
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { nowForDb } from './db-time';
import { ymdhms } from './format';
import { BUBBLES, isBubbleExpired, parseBubbleKey, resolveBubbleKey } from './bubble-refs';
import { publishToAll } from './chat-bus';

type EquippedRow = { equippedBubbleKey: string | null; equippedBubbleExpiresAt: Date | null };
export function bubbleKeyFor(row: EquippedRow) {
  return resolveBubbleKey(row.equippedBubbleKey, row.equippedBubbleExpiresAt, nowForDb());
}
// 事件不携带用户身份或频道信息；接收者仅重新读取自己当前可访问的消息作者。
// 推送尽力而为，60 秒快照刷新兜底。失败不能使已经提交的购买被误报失败。
export function pushBubbleRefresh(): void {
  try { publishToAll({ type: 'appearance' }); }
  catch (e) { console.error('[bubble] 装备刷新推送失败:', e); }
}
export async function grantBubbleTx(tx: Prisma.TransactionClient, input: {
  userId: string; key: string; expiresAt: Date | null; source: string;
}) {
  const key = parseBubbleKey(input.key);
  if (!key || BUBBLES[key].disabled) throw new Error('气泡不存在或已停用');
  if (input.expiresAt && !Number.isFinite(input.expiresAt.getTime())) throw new Error('无效的到期时间');
  const where = { uq_user_bubble: { userId: input.userId, bubbleKey: key } };
  const old = await tx.userBubble.findUnique({ where });
  // 永久压过限时；发放只能延长。已撤销的持有行不参与比较。
  const expiresAt = old && !old.deleted
    ? old.expiresAt === null || input.expiresAt === null ? null
      : old.expiresAt > input.expiresAt ? old.expiresAt : input.expiresAt
    : input.expiresAt;
  await tx.userBubble.upsert({
    where,
    create: { userId: input.userId, bubbleKey: key, expiresAt, source: input.source, createdAt: nowForDb() },
    update: { expiresAt, source: input.source, deleted: false, deletedAt: null },
  });
  await tx.user.updateMany({
    where: { id: input.userId, equippedBubbleKey: key },
    data: { equippedBubbleExpiresAt: expiresAt },
  });
  return { key, expiresAt };
}
export async function grantBubble(input: Parameters<typeof grantBubbleTx>[1]) {
  const result = await prisma.$transaction((tx) => grantBubbleTx(tx, input));
  pushBubbleRefresh();
  return result;
}
export async function revokeBubble(userId: string, key: string) {
  const result = await prisma.$transaction(async (tx) => {
    const revoked = await tx.userBubble.updateMany({
      where: { userId, bubbleKey: key, deleted: false },
      data: { deleted: true, deletedAt: nowForDb() },
    });
    const unequipped = await tx.user.updateMany({
      where: { id: userId, equippedBubbleKey: key },
      data: { equippedBubbleKey: null, equippedBubbleExpiresAt: null },
    });
    return { revoked: revoked.count > 0, unequipped: unequipped.count > 0 };
  });
  pushBubbleRefresh();
  return result;
}
export async function equipBubble(userId: string, rawKey: string | null) {
  const result = await prisma.$transaction(async (tx) => {
    if (rawKey === null) {
      await tx.user.update({ where: { id: userId }, data: { equippedBubbleKey: null, equippedBubbleExpiresAt: null } });
      return { ok: true as const, key: null, expiresAt: null };
    }
    const key = parseBubbleKey(rawKey);
    if (!key || BUBBLES[key].disabled) return { ok: false as const, code: 400, message: '气泡不存在或已停用' };
    const row = await tx.userBubble.findUnique({ where: { uq_user_bubble: { userId, bubbleKey: key } } });
    if (!row || row.deleted) return { ok: false as const, code: 403, message: '你还没有这个聊天气泡' };
    if (!resolveBubbleKey(key, row.expiresAt, nowForDb())) return { ok: false as const, code: 403, message: '这个聊天气泡已过期' };
    await tx.user.update({ where: { id: userId }, data: { equippedBubbleKey: key, equippedBubbleExpiresAt: row.expiresAt } });
    return { ok: true as const, key, expiresAt: row.expiresAt };
  });
  if (result.ok) pushBubbleRefresh();
  return result;
}
export async function listMyBubbles(userId: string) {
  const [rows, user] = await Promise.all([
    prisma.userBubble.findMany({ where: { userId, deleted: false }, orderBy: { id: 'asc' } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { equippedBubbleKey: true, equippedBubbleExpiresAt: true } }),
  ]);
  const now = nowForDb();
  return {
    activeKey: bubbleKeyFor(user),
    equippedKey: user.equippedBubbleKey,
    bubbles: rows.map((row) => {
      const key = parseBubbleKey(row.bubbleKey);
      return {
        key: row.bubbleKey,
        label: key ? BUBBLES[key].label : row.bubbleKey,
        available: resolveBubbleKey(key, row.expiresAt, now) !== null,
        expired: isBubbleExpired(row.expiresAt, now),
        disabled: !key || !!BUBBLES[key].disabled,
        expiresAt: ymdhms(row.expiresAt),
        equipped: user.equippedBubbleKey === row.bubbleKey,
      };
    }),
  };
}
