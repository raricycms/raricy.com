import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, makeUser } from '../helpers/db';
import { makeFishUser, expectLedgerConsistent } from '../helpers/fish-ledger';
import { prisma } from '@/lib/db';
import { nowForDb } from '@/lib/db-time';
import { rentBubble, listBubbleShopItems } from '@/lib/bubble-shop-service';
import { grantBubble, revokeBubble, equipBubble, listMyBubbles, bubbleKeyFor } from '@/lib/bubble-service';
import * as bubbleService from '@/lib/bubble-service';
import { listMessages, sendMessage, searchChannelMessages, listMessagesSince } from '@/lib/chat-service';
import { getTransactions } from '@/lib/fish-service';
import { fishToUnits } from '@/lib/fish-units';
import { BUBBLES } from '@/lib/bubble-refs';
import { subscribe } from '@/lib/chat-bus';
import { bubbleCommands } from '../../scripts/cli/commands/bubbles';
import type { Ctx } from '../../scripts/cli/types';
import { runAsBackendOps } from '@/lib/audit-context';

const KEY = 'blue-square';
const MONTH_MS = 30 * 86400000;
const buy = (userId: string, count = 1) => rentBubble({ userId, key: KEY, count });
const holding = (userId: string) => prisma.userBubble.findUniqueOrThrow({ where: { uq_user_bubble: { userId, bubbleKey: KEY } } });
beforeEach(async () => { await resetDb(); });

describe('气泡租赁与权益', () => {
  it('demo 售价 10/月，购买只发权益，装备后才生效；流水进入商城筛选', async () => {
    const user = await makeFishUser(25);
    expect((await listBubbleShopItems(user.id))[0].rent).toEqual({ unit: 'month', price: 10 });
    const before = nowForDb();
    const result = await buy(user.id);
    expect(result).toMatchObject({ ok: true, cost: 10, balance: 15 });
    const row = await holding(user.id);
    expect(row.expiresAt!.getTime() - before.getTime()).toBeGreaterThanOrEqual(MONTH_MS);
    expect(row.expiresAt!.getTime() - before.getTime()).toBeLessThan(MONTH_MS + 5000);
    expect((await listMyBubbles(user.id)).activeKey).toBeNull();
    expect(await equipBubble(user.id, KEY)).toMatchObject({ ok: true, key: KEY });
    expect((await listMyBubbles(user.id)).activeKey).toBe(KEY);
    const tx = await prisma.fishTransaction.findFirstOrThrow({ where: { userId: user.id, type: 'bubble_rent' } });
    expect(tx).toMatchObject({ amount: -fishToUnits(10), referenceType: 'bubble', referenceId: KEY });
    const transactions = await getTransactions(user.id, 1, 20, 'shop_all');
    expect(transactions.transactions).toHaveLength(1);
    await expectLedgerConsistent();
  });
  it('余额不足时不留下持有行；并发购买扣两次、叠加两个月且同步装备副本', async () => {
    const poor = await makeFishUser(9);
    expect(await buy(poor.id)).toMatchObject({ ok: false, code: 400 });
    expect(await prisma.userBubble.count({ where: { userId: poor.id } })).toBe(0);
    const user = await makeFishUser(100);
    await buy(user.id);
    await equipBubble(user.id, KEY);
    const first = (await holding(user.id)).expiresAt!;
    const results = await Promise.all([buy(user.id), buy(user.id)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const next = (await holding(user.id)).expiresAt!;
    expect(next.getTime() - first.getTime()).toBe(2 * MONTH_MS);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ driedFish: fishToUnits(70), equippedBubbleExpiresAt: next });
    await expectLedgerConsistent();
  });
  it('原款改名保留已有权益；描边款独立购买、装备与续期', async () => {
    const user = await makeFishUser(40);
    await buy(user.id);
    await equipBubble(user.id, KEY);
    const original = await holding(user.id);
    expect((await listMyBubbles(user.id)).activeKey).toBe(KEY);
    expect(BUBBLES[KEY].label).toBe('蓝底直角');
    const outlineKey = 'blue-outline-square';
    expect(await equipBubble(user.id, outlineKey)).toMatchObject({ ok: false, code: 403 });
    expect(await rentBubble({ userId: user.id, key: outlineKey, count: 1 })).toMatchObject({ ok: true, cost: 10, balance: 20 });
    expect((await listMyBubbles(user.id)).activeKey).toBe(KEY);
    expect(await equipBubble(user.id, outlineKey)).toMatchObject({ ok: true, key: outlineKey });
    await rentBubble({ userId: user.id, key: outlineKey, count: 1 });
    expect(await holding(user.id)).toEqual(original);
    const items = await listBubbleShopItems(user.id);
    expect(items.map((item) => [item.key, item.label, item.equipped])).toEqual([
      [KEY, '蓝底直角', false], [outlineKey, '蓝色直角', true],
    ]);
    expect(await equipBubble(user.id, KEY)).toMatchObject({ ok: true, key: KEY });
    expect(await prisma.userBubble.count({ where: { userId: user.id } })).toBe(2);
    await expectLedgerConsistent();
  });
  it('非法输入、停售、停用与永久持有拒扣款；停售仍允许已持有者装备', async () => {
    const user = await makeFishUser(100);
    for (const count of [0, 13, 1.5, '1e1', [], null]) expect(await rentBubble({ userId: user.id, key: KEY, count })).toMatchObject({ ok: false });
    expect(await rentBubble({ userId: user.id, key: '../bad', count: 1 })).toMatchObject({ ok: false });
    await grantBubble({ userId: user.id, key: KEY, expiresAt: null, source: 'cli' });
    expect(await buy(user.id)).toMatchObject({ ok: false });
    const rent = BUBBLES[KEY].rent;
    try {
      delete BUBBLES[KEY].rent;
      expect(await buy(user.id)).toMatchObject({ ok: false });
      expect(await equipBubble(user.id, KEY)).toMatchObject({ ok: true });
      BUBBLES[KEY].disabled = true;
      expect(await buy(user.id)).toMatchObject({ ok: false });
      expect((await listMyBubbles(user.id)).activeKey).toBeNull();
    } finally { BUBBLES[KEY].rent = rent; delete BUBBLES[KEY].disabled; }
    expect(await prisma.fishTransaction.count({ where: { type: 'bubble_rent' } })).toBe(0);
    await expectLedgerConsistent();
  });
  it('未持有/已过期不可装备；到期回退默认，续租从现在起算；撤销后复活原行', async () => {
    const user = await makeFishUser(100);
    expect(await equipBubble(user.id, KEY)).toMatchObject({ ok: false, code: 403 });
    await grantBubble({ userId: user.id, key: KEY, expiresAt: new Date(nowForDb().getTime() - 1), source: 'cli' });
    expect(await equipBubble(user.id, KEY)).toMatchObject({ ok: false });
    const past = new Date(nowForDb().getTime() - 86400000);
    expect(bubbleKeyFor({ equippedBubbleKey: KEY, equippedBubbleExpiresAt: past })).toBeNull();
    const now = nowForDb();
    await buy(user.id);
    expect((await holding(user.id)).expiresAt!.getTime()).toBeGreaterThanOrEqual(now.getTime() + MONTH_MS);
    await equipBubble(user.id, KEY);
    const id = (await holding(user.id)).id;
    await revokeBubble(user.id, KEY);
    expect((await holding(user.id)).deleted).toBe(true);
    expect((await listMyBubbles(user.id)).equippedKey).toBeNull();
    await buy(user.id);
    expect(await holding(user.id)).toMatchObject({ id, deleted: false });
    expect(await equipBubble(user.id, null)).toMatchObject({ ok: true });
    await expectLedgerConsistent();
  });
  it('授予失败会回滚扣款与权益', async () => {
    const user = await makeFishUser(30);
    const spy = vi.spyOn(bubbleService, 'grantBubbleTx').mockRejectedValueOnce(new Error('模拟发放失败'));
    try { await expect(buy(user.id)).rejects.toThrow('模拟发放失败'); }
    finally { spy.mockRestore(); }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).driedFish).toBe(fishToUnits(30));
    expect(await prisma.userBubble.count()).toBe(0);
    await expectLedgerConsistent();
  });
});

it('历史、搜索、断线补齐与发送响应都读作者当前气泡，装备变化推刷新而不增加消息', async () => {
  const user = await makeUser({ role: 'core' });
  const sent = await sendMessage({ channelId: 'lobby', authorId: user.id, content: 'bubble-marker' });
  expect(sent.ok).toBe(true);
  const frames: string[] = [];
  const unsubscribe = subscribe({ userId: user.id, lobbyBlocked: false, write: (s) => { frames.push(s); return true; }, close: () => {} });
  try {
    await grantBubble({ userId: user.id, key: KEY, expiresAt: null, source: 'cli' });
    await equipBubble(user.id, KEY);
    expect(frames.some((s) => s.includes('"type":"appearance"'))).toBe(true);
    const page = await listMessages('lobby', user.id);
    expect(page.ok && page.messages[0].author.bubble_key).toBe(KEY);
    const search = await searchChannelMessages('lobby', user.id, 'bubble-marker');
    expect(search.ok && search.messages[0].author.bubble_key).toBe(KEY);
    const backfill = await listMessagesSince(user.id, 0);
    expect(backfill.messages[0].author.bubble_key).toBe(KEY);
    const after = await sendMessage({ channelId: 'lobby', authorId: user.id, content: 'bubble-after' });
    expect(after.ok && after.message.author.bubble_key).toBe(KEY);
    await equipBubble(user.id, null);
    const plain = await listMessages('lobby', user.id);
    expect(plain.ok && plain.messages.every((m) => m.author.bubble_key === null)).toBe(true);
    expect(await prisma.chatMessage.count()).toBe(2);
  } finally { unsubscribe(); }
});

it('CLI 发放与撤销走真实服务，记录内部中文动作，撤销只留墓碑并卸下', async () => {
  const actor = await makeUser({ role: 'owner' });
  const user = await makeUser();
  const io: Ctx['io'] = { line: () => {}, error: () => {}, red: (s) => s, green: (s) => s,
    yellow: (s) => s, dim: (s) => s, width: () => 80 };
  const ctx: Ctx = { args: { username: user.username, key: KEY, days: 7, reason: '测试发放' }, actor, prisma, io };
  const grant = bubbleCommands.find((c) => c.name === 'bubble grant')!;
  const revoke = bubbleCommands.find((c) => c.name === 'bubble revoke')!;
  await runAsBackendOps(() => grant.run(ctx));
  const row = await holding(user.id);
  expect(row).toMatchObject({ source: 'cli', deleted: false });
  expect(row.expiresAt!.getTime() - nowForDb().getTime()).toBeGreaterThan(6 * 86400000);
  await equipBubble(user.id, KEY);
  await runAsBackendOps(() => revoke.run({ ...ctx, args: { username: user.username, key: KEY } }));
  expect(await holding(user.id)).toMatchObject({ id: row.id, deleted: true });
  expect((await listMyBubbles(user.id)).equippedKey).toBeNull();
  expect(await prisma.adminActionLog.findMany({ select: { action: true, visibility: true, objectType: true, targetUserId: true }, orderBy: { id: 'asc' } })).toEqual([
    { action: 'bubble_grant', visibility: 'internal', objectType: 'user_bubble', targetUserId: user.id },
    { action: 'bubble_revoke', visibility: 'internal', objectType: 'user_bubble', targetUserId: user.id },
  ]);
});
