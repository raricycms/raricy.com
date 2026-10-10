import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { auth } = vi.hoisted(() => ({ auth: { user: null as unknown } }));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(), getCurrentUser: async () => auth.user }));
import { GET as chatStream } from '@/app/api/chat/stream/route';
import { GET as topbarStream } from '@/app/api/notifications/stream/route';
import { publishToUsers, __resetChatBus } from '@/lib/chat-bus';
import { publishToUser, __resetTopbarBus } from '@/lib/topbar-bus';
import { resetDb, makeUser, prisma } from '../helpers/db';
beforeEach(async () => { await resetDb(); });
afterEach(() => { __resetChatBus(); __resetTopbarBus(); });
it.each([chatStream, topbarStream])('鉴权快照刚过期、kick 已发生但尚未注册的流不投递私有帧', async (open) => {
  const user = await makeUser({ role: 'core' });
  auth.user = user;
  await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
  const response = await open(new Request('http://localhost/stream'));
  publishToUsers([user.id], { type: 'resync' });
  publishToUser(user.id, { count: 99 });
  const text = await response.text();
  expect(text).toContain(': connected');
  expect(text).not.toContain('data:');
});
it.each([{ role: 'user' }, { focusMode: true }])('角色/专注模式快照过期时，旧讨论流不投递消息（%j）', async (patch) => {
  const user = await makeUser({ role: 'core', focusMode: false });
  auth.user = user;
  // 两种变更不递增 sessionVersion；kick 可能早于这次注册。
  await prisma.user.update({ where: { id: user.id }, data: patch });
  const response = await chatStream(new Request('http://localhost/stream'));
  publishToUsers([user.id], { type: 'resync' });
  const reader = response.body!.getReader();
  let received = '';
  try {
    await vi.waitFor(async () => {
      const next = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
      ]);
      if (!next) throw new Error('等待权限复核');
      if (next.value) received += new TextDecoder().decode(next.value);
      expect(next.done).toBe(true);
    }, { timeout: 500 });
  } finally { await reader.cancel(); }
  expect(received).not.toContain('data:');
});
