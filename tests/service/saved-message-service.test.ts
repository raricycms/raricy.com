// saved-message-service.ts —— 私聊消息保存箱
//
// 【为什么这么测】它要同时守住三件互相拉扯的事：
//   1. **只收私聊、只收自己参与的会话**：消息存在 / 未删 / kind='direct' / 我是成员，
//      四条缺一不可；且失败一律同形（不能变成「某条消息是否存在于别人私聊」的探针）。
//   2. **只存指针**：消息被删 / 作者注销后，保存箱必须立刻变成占位，绝不回退到原正文。
//   3. **读路径重新判权限**：保存过不是永久通行证（被移出频道后不能再读）。
// 另外钉住「取消再保存复活旧行」这条与收藏夹条目同款的墓碑语义。
//
// 跑真实 SQLite（tests/.tmp/test-*；helpers/db.ts 有硬校验）。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { __resetRateLimitStore, rateLimit, RULES } from '@/lib/rate-limit';
import { CHAT_LOBBY_ID, CHAT_DELETED_TEXT } from '@/lib/chat-shared';
import { startDirectChannel, sendMessage, softDeleteMessage } from '@/lib/chat-service';
import {
  SAVED_MESSAGE_MAX,
  countSavedMessages,
  listSavedMessageIds,
  listSavedMessages,
  parseMessageId,
  saveMessage,
  unsaveMessage,
} from '@/lib/saved-message-service';

beforeEach(async () => {
  await resetDb();
  __resetRateLimitStore();
});

/** 造一对 core 用户 + 他们的私聊频道。 */
async function makeDirectPair() {
  const a = await makeUser({ role: 'core' });
  const b = await makeUser({ role: 'core' });
  const res = await startDirectChannel(a.id, b.id);
  if (!res.ok) throw new Error(`建私聊失败：${res.error}`);
  return { a, b, channelId: res.channel.id };
}

/** 发一条消息并断言成功。 */
async function send(authorId: string, channelId: string, content: string) {
  const res = await sendMessage({ channelId, authorId, content });
  if (!res.ok) throw new Error(`发消息失败：${res.error}`);
  return res.message;
}

// ── parseMessageId ───────────────────────────────────────────────────────────

describe('parseMessageId', () => {
  it('接受正整数与十进制数字串', () => {
    expect(parseMessageId(1)).toBe(1);
    expect(parseMessageId('42')).toBe(42);
    expect(parseMessageId('  7  ')).toBe(7);
  });

  it('拒绝 0 / 负数 / 小数 / 前导零 / 非数字', () => {
    for (const bad of [0, -1, 1.5, '0', '-1', '01', '1.0', '1e3', 'abc', '', null, undefined, {}]) {
      expect(parseMessageId(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

// ── 保存 ─────────────────────────────────────────────────────────────────────

describe('saveMessage', () => {
  it('保存一条私聊消息；幂等：再保存不重复计数', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msg = await send(b.id, channelId, '这句话值得存下来');

    const first = await saveMessage(a.id, msg.id);
    expect(first.ok).toBe(true);
    expect(first.ok && first.count).toBe(1);
    const savedId = first.ok ? first.savedId : 0;

    const again = await saveMessage(a.id, msg.id);
    expect(again.ok).toBe(true);
    expect(again.ok && again.count).toBe(1);
    expect(again.ok && again.savedId).toBe(savedId);

    expect(await countSavedMessages(a.id)).toBe(1);
  });

  it('拒绝大区消息（保存箱只收私聊）', async () => {
    const a = await makeUser({ role: 'core' });
    const msg = await send(a.id, CHAT_LOBBY_ID, '大区里的话');
    const res = await saveMessage(a.id, msg.id);
    expect(!res.ok && res.reason).toBe('badinput');
  });

  it('拒绝不属于自己的会话（非成员）', async () => {
    const { a: owner, b, channelId } = await makeDirectPair();
    const outsider = await makeUser({ role: 'core' });
    const msg = await send(b.id, channelId, '只有我们俩能看');
    const res = await saveMessage(outsider.id, msg.id);
    expect(!res.ok && res.reason).toBe('badinput');
    // 不留下任何行
    expect(await countSavedMessages(outsider.id)).toBe(0);
    // 频道成员本人仍可保存（同一份数据、两个独立视角）
    expect((await saveMessage(owner.id, msg.id)).ok).toBe(true);
  });

  it('拒绝已软删的消息', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msg = await send(b.id, channelId, '马上删掉');
    await softDeleteMessage(msg.id, { id: b.id, role: 'core' });
    const res = await saveMessage(a.id, msg.id);
    expect(!res.ok && res.reason).toBe('badinput');
  });

  it('拒绝作者已注销的消息（讨论区已按删除渲染）', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msg = await send(b.id, channelId, '来自一个马上注销的人');
    await prisma.user.update({ where: { id: b.id }, data: { archivedAt: nowForDb() } });
    const res = await saveMessage(a.id, msg.id);
    expect(!res.ok && res.reason).toBe('badinput');
  });

  it('无效 id / 不存在的 id 都是 badinput（不确认存在性）', async () => {
    const { a } = await makeDirectPair();
    for (const bad of ['0', 'abc', 999_999_999]) {
      const res = await saveMessage(a.id, bad);
      expect(!res.ok && res.reason).toBe('badinput');
    }
  });

  it('限频在参数校验之前（随机探测也要消耗额度）', async () => {
    const { a } = await makeDirectPair();
    for (let i = 0; i < RULES.likeHourly.limit; i++) {
      rateLimit(`chat:saved:h:${a.id}`, RULES.likeHourly);
    }
    const res = await saveMessage(a.id, 1);
    expect(!res.ok && res.reason).toBe('rateLimited');
  });

  it(`第 ${SAVED_MESSAGE_MAX + 1} 条被拒；但已保存的那条仍幂等成功`, async () => {
    const { a, b, channelId } = await makeDirectPair();
    const now = nowForDb();
    // 直接造满：1000 条消息 + 1000 行保存（比逐条走接口快得多）
    await prisma.chatMessage.createMany({
      data: Array.from({ length: SAVED_MESSAGE_MAX }, (_, i) => ({
        channelId,
        authorId: b.id,
        content: `m${i}`,
        createdAt: now,
      })),
    });
    const msgs = await prisma.chatMessage.findMany({
      where: { channelId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    await prisma.savedChatMessage.createMany({
      data: msgs.map((m) => ({ userId: a.id, messageId: m.id, createdAt: now })),
    });

    // 已保存过的那条：幂等提前返回，不撞配额
    const already = await saveMessage(a.id, msgs[0].id);
    expect(already.ok).toBe(true);

    const extra = await send(b.id, channelId, '第 1001 条');
    const res = await saveMessage(a.id, extra.id);
    expect(!res.ok && res.reason).toBe('limit');
  });
});

// ── 取消保存 / 复活 ──────────────────────────────────────────────────────────

describe('unsaveMessage', () => {
  it('取消是软删：行还在，列表不再出现；再保存复活同一行', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msg = await send(b.id, channelId, '存了又取消');
    const first = await saveMessage(a.id, msg.id);
    expect(first.ok).toBe(true);
    const savedId = first.ok ? first.savedId : 0;

    const removed = await unsaveMessage(a.id, msg.id);
    expect(removed.ok).toBe(true);
    expect(removed.ok && removed.count).toBe(0);

    const row = await prisma.savedChatMessage.findUnique({
      where: { userId_messageId: { userId: a.id, messageId: msg.id } },
      select: { id: true, deleted: true },
    });
    expect(row?.id).toBe(savedId);
    expect(row?.deleted).toBe(true);

    const revived = await saveMessage(a.id, msg.id);
    expect(revived.ok).toBe(true);
    expect(revived.ok && revived.savedId).toBe(savedId);
    expect(await prisma.savedChatMessage.count()).toBe(1);
  });

  it('幂等：没保存过 / 重复取消也返回成功', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msg = await send(b.id, channelId, 'x');
    expect((await unsaveMessage(a.id, msg.id)).ok).toBe(true);
    expect((await unsaveMessage(a.id, msg.id)).ok).toBe(true);
  });

  it('无效 id → badinput', async () => {
    const { a } = await makeDirectPair();
    const res = await unsaveMessage(a.id, 'nope');
    expect(!res.ok && res.reason).toBe('badinput');
  });
});

// ── 列表 / 解析 ──────────────────────────────────────────────────────────────

describe('listSavedMessages', () => {
  it('只列自己的；按保存先后倒序；带频道对端与作者', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const m1 = await send(b.id, channelId, '第一条');
    const m2 = await send(a.id, channelId, '第二条');
    await saveMessage(a.id, m1.id);
    await saveMessage(a.id, m2.id);

    const page = await listSavedMessages(a.id);
    expect(page.total).toBe(2);
    expect(page.items.map((i) => i.messageId)).toEqual([m2.id, m1.id]);
    expect(page.items[0].state).toBe('ok');
    expect(page.items[0].authorName).toBe(a.username);
    expect(page.items[0].channelTitle).toBe(b.username);
    expect(page.items[0].channelId).toBe(channelId);
    expect(page.items[0].preview).toBe('第二条');

    // 对方（b）看不到 a 的保存
    expect((await listSavedMessages(b.id)).total).toBe(0);
  });

  it('消息被删 → 占位，绝不回退到原正文', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msg = await send(b.id, channelId, '这句会被删掉');
    await saveMessage(a.id, msg.id);
    await softDeleteMessage(msg.id, { id: b.id, role: 'core' });

    const page = await listSavedMessages(a.id);
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item.state).toBe('deleted');
    expect(item.preview).toBe(CHAT_DELETED_TEXT);
    expect(item.authorName).toBeNull();
    expect(item.messageCreatedAt).toBeNull();
    // 仍保留定位（用户能点回会话）；正文一个字都不能带出来
    expect(item.channelId).toBe(channelId);
    expect(JSON.stringify(item)).not.toContain('这句会被删掉');
  });

  it('作者注销 → 同样是占位', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msg = await send(b.id, channelId, '来自一个马上注销的人');
    await saveMessage(a.id, msg.id);
    await prisma.user.update({
      where: { id: b.id },
      data: { archivedAt: nowForDb() },
    });

    const page = await listSavedMessages(a.id);
    expect(page.items[0].state).toBe('deleted');
    expect(page.items[0].preview).toBe(CHAT_DELETED_TEXT);
  });

  it('被移出频道 → forbidden：不泄露正文 / 作者 / 频道', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msg = await send(b.id, channelId, '离开之后不该还能读');
    await saveMessage(a.id, msg.id);
    await prisma.chatMember.deleteMany({ where: { channelId, userId: a.id } });

    const page = await listSavedMessages(a.id);
    expect(page.items[0].state).toBe('forbidden');
    expect(page.items[0].preview).toBe('');
    expect(page.items[0].channelId).toBeNull();
    expect(page.items[0].channelTitle).toBeNull();
    expect(page.items[0].authorName).toBeNull();
    expect(JSON.stringify(page.items[0])).not.toContain('离开之后');
  });

  it('分页：limit / hasMore / nextBefore 串得起来', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const msgs = [];
    for (let i = 0; i < 3; i++) msgs.push(await send(b.id, channelId, `第 ${i} 条`));
    for (const m of msgs) await saveMessage(a.id, m.id);

    const first = await listSavedMessages(a.id, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBe(first.items[1].savedId);

    const second = await listSavedMessages(a.id, { limit: 2, before: first.nextBefore! });
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextBefore).toBeNull();
    expect(second.items[0].messageId).toBe(msgs[0].id);
  });

  it('图片 / 博客引用消息没有正文时给可读占位', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const now = nowForDb();
    await prisma.imageHosting.create({
      data: {
        id: 'saved-test-img',
        filename: 'x.png',
        fileSize: 10,
        mimeType: 'image/png',
        authorId: b.id,
        createdAt: now,
        isPublic: true,
        ignore: false,
      },
    });
    const imgMsg = await prisma.chatMessage.create({
      data: {
        channelId,
        authorId: b.id,
        content: '',
        imageId: 'saved-test-img',
        createdAt: now,
      },
      select: { id: true },
    });
    await saveMessage(a.id, imgMsg.id);

    const page = await listSavedMessages(a.id);
    expect(page.items[0].state).toBe('ok');
    expect(page.items[0].preview).toBe('[图片]');
  });
});

// ── 频道内「已保存」id ───────────────────────────────────────────────────────

describe('listSavedMessageIds', () => {
  it('只返回该频道里我保存过的 id', async () => {
    const { a, b, channelId } = await makeDirectPair();
    const m1 = await send(b.id, channelId, '一');
    const m2 = await send(b.id, channelId, '二');
    await saveMessage(a.id, m1.id);

    const res = await listSavedMessageIds(a.id, channelId);
    expect(res.ok).toBe(true);
    expect(res.ok && res.ids).toEqual([m1.id]);
    expect(res.ok && res.ids).not.toContain(m2.id);
  });

  it('大区返回空数组（保存箱只收私聊）', async () => {
    const a = await makeUser({ role: 'core' });
    const res = await listSavedMessageIds(a.id, CHAT_LOBBY_ID);
    expect(res).toEqual({ ok: true, ids: [] });
  });

  it('非成员 forbidden / 频道不存在 notfound', async () => {
    const { channelId } = await makeDirectPair();
    const outsider = await makeUser({ role: 'core' });
    expect(await listSavedMessageIds(outsider.id, channelId)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await listSavedMessageIds(outsider.id, 'no-such-channel')).toEqual({
      ok: false,
      reason: 'notfound',
    });
  });
});
