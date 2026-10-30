import { beforeEach, expect, it, vi } from 'vitest';
const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));
vi.mock('next/headers', () => ({ cookies: async () => ({
  get: (name: string) => name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
}) }));
import { GET, PUT } from '@/app/api/users/me/bubble/route';
import { POST } from '@/app/api/fish/market/bubble-rent/route';
import { GET as appearances } from '@/app/api/chat/channels/[id]/appearance/route';
import { resetDb, makeUser } from '../helpers/db';
import { makeFishUser, expectLedgerConsistent } from '../helpers/fish-ledger';
import { createSessionToken } from '@/lib/session';
import { prisma } from '@/lib/db';
import { grantBubble, equipBubble } from '@/lib/bubble-service';
import { sendMessage } from '@/lib/chat-service';
import { nowForDb } from '@/lib/db-time';

const KEY = 'blue-square';
const login = async (id: string) => { session.token = await createSessionToken({ uid: id, sv: 0 }); };
const request = (method: string, body: unknown) => new Request('http://localhost/api/bubble', { method,
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(async () => { await resetDb(); session.token = undefined; });
it('只认会话，未登录的读取、装备、凭据购买全部拒绝', async () => {
  expect((await GET()).status).toBe(401);
  expect((await PUT(request('PUT', { bubble_key: null }))).status).toBe(401);
  expect((await POST(request('POST', { username: 'somebody', password: 'secret', bubble_key: KEY, count: 1 }))).status).toBe(401);
});
it('非法装备请求不能静默卸下；未持有不能使用；显式 null 恢复默认', async () => {
  const user = await makeUser(); await login(user.id);
  expect((await PUT(request('PUT', { bubble_key: KEY }))).status).toBe(403);
  await grantBubble({ userId: user.id, key: KEY, expiresAt: null, source: 'cli' });
  await equipBubble(user.id, KEY);
  for (const body of [{}, null, [], { bubble_key: 1 }]) expect((await PUT(request('PUT', body))).status).toBe(400);
  expect((await (await GET()).json()).activeKey).toBe(KEY);
  expect((await PUT(request('PUT', { bubble_key: null }))).status).toBe(200);
  expect((await (await GET()).json()).activeKey).toBeNull();
});
it('成员可花自己的鱼干；篡改价格/单位无效；禁言拒扣款', async () => {
  const user = await makeFishUser(30, { role: 'core' }); await login(user.id);
  const res = await POST(request('POST', { bubble_key: KEY, count: 1, price: 0, unit: 'day' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ cost: 10, unit: 'month', balance: 20 });
  await prisma.user.update({ where: { id: user.id }, data: { isBanned: true, banUntil: null } });
  expect((await POST(request('POST', { bubble_key: KEY, count: 1 }))).status).toBe(403);
  await expectLedgerConsistent();
});
it('装备快照遵守会话权限、专注模式及作者范围', async () => {
  const user = await makeUser({ role: 'core' }); const outsider = await makeUser({ role: 'core' });
  await sendMessage({ channelId: 'lobby', authorId: user.id, content: 'scope' });
  await grantBubble({ userId: user.id, key: KEY, expiresAt: null, source: 'cli' });
  await equipBubble(user.id, KEY); await login(user.id);
  const read = (id: string, users = [user.id, outsider.id]) => appearances(new Request(`http://localhost/appearance?${new URLSearchParams({ users: users.join(',') })}`), { params: Promise.resolve({ id }) });
  expect(await (await read('lobby')).json()).toMatchObject({ authors: [{ id: user.id, bubble_key: KEY }] });
  await prisma.chatChannel.create({ data: { id: 'private-scope', kind: 'direct', createdAt: nowForDb() } });
  expect((await read('private-scope')).status).toBe(403);
  expect((await read('missing-channel')).status).toBe(404);
  expect((await read('lobby', Array.from({ length: 101 }, (_, i) => `u-${i}`))).status).toBe(400);
  await prisma.user.update({ where: { id: user.id }, data: { focusMode: true } });
  expect((await read('lobby')).status).toBe(403);
});

it('历史账号不能购买气泡，余额和持有账不变', async () => {
  const u = await makeFishUser(30, { role: 'user' }); await login(u.id);
  expect((await POST(request('POST', { bubble_key: KEY, count: 1 }))).status).toBe(403);
  expect(await prisma.userBubble.count()).toBe(0);
  await expectLedgerConsistent('非成员拒绝购买');
});
