import { beforeEach, expect, it } from 'vitest';
import { ensureLobbyChannel, CHAT_LOBBY_ID } from '@/lib/chat-service';
import { prisma, resetDb } from '../helpers/db';

beforeEach(resetDb);

it('首次进入讨论的并发请求可同时兜底建大区，最终只有一行', async () => {
  const channels = await Promise.all(Array.from({ length: 12 }, () => ensureLobbyChannel()));
  expect(channels.every((channel) => channel.id === CHAT_LOBBY_ID)).toBe(true);
  expect(await prisma.chatChannel.count()).toBe(1);
});
