import { beforeEach, expect, it } from 'vitest';
import { ensureLobbyChannel, ensureLobbyMembership, CHAT_LOBBY_ID } from '@/lib/chat-service';
import { makeUser, prisma, resetDb } from '../helpers/db';

beforeEach(resetDb);

it('首次进入讨论的并发请求可同时兜底建大区，最终只有一行', async () => {
  const channels = await Promise.all(Array.from({ length: 12 }, () => ensureLobbyChannel()));
  expect(channels.every((channel) => channel.id === CHAT_LOBBY_ID)).toBe(true);
  expect(await prisma.chatChannel.count()).toBe(1);
});

it('并发首次进大区：成员行只建一行，所有请求都正常返回（P2002 不冒成 500）', async () => {
  const user = await makeUser({ role: 'core' });

  // 12 个请求同时走到「先查后建」：只有一个 create 成功，其余撞唯一约束。
  // 修复前它们会带着 P2002 抛到 poll 路由 → 500；修复后全部拿到同一行。
  const results = await Promise.all(
    Array.from({ length: 12 }, () => ensureLobbyMembership(user.id))
  );

  expect(results.every((r) => r.lastReadMessageId === 0)).toBe(true);
  expect(await prisma.chatMember.count()).toBe(1);
});
