import { beforeEach, describe, expect, it, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => session.token ? { value: session.token } : undefined }),
}));

import { GET } from '@/app/api/mentions/users/route';
import { createSessionToken } from '@/lib/session';
import { startDirectChannel, setChannelMuted } from '@/lib/chat-service';
import { makeUser, makeBlog, resetDb, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';

beforeEach(async () => { session.token = undefined; await resetDb(); });
const login = async (id: string) => { session.token = await createSessionToken({ uid: id, sv: 0 }); };
const request = (kind = 'chat', id = 'lobby', q = '') => GET(new Request(
  `http://localhost/api/mentions/users?${new URLSearchParams({ kind, id, q })}`,
));
const names = async (response: Response) => (await response.json()).users.map((u: { username: string }) => u.username);

describe('@ 选人接口', () => {
  it('匿名 401、普通账号 / 禁言账号 403', async () => {
    expect((await request()).status).toBe(401);
    const plain = await makeUser();
    await login(plain.id);
    expect((await request()).status).toBe(403);
    const banned = await makeUser({ role: 'core', isBanned: true });
    await login(banned.id);
    expect((await request()).status).toBe(403);
  });

  it('拒绝非法参数、已删除文章和无权访问的会话', async () => {
    const viewer = await makeUser({ role: 'core' }); await login(viewer.id);
    expect((await request('unknown')).status).toBe(400);
    expect((await request('chat', 'lobby', 'a b')).status).toBe(400);
    expect((await request('comment', 'missing')).status).toBe(404);
    const blog = await makeBlog({ ignore: true });
    expect((await request('comment', blog.id)).status).toBe(404);
    const a = await makeUser({ role: 'core' }), b = await makeUser({ role: 'core' });
    const channel = await startDirectChannel(a.id, b.id);
    expect(channel.ok).toBe(true); if (!channel.ok) return;
    expect((await request('chat', channel.channel.id)).status).toBe(404);
  });

  it('评论提示只列 core+，排除自己，保留有阅读权限的专注 / 禁言者', async () => {
    const viewer = await makeUser({ username: 'pick_self', role: 'core' }); await login(viewer.id);
    await makeUser({ username: 'pick_plain' });
    await makeUser({ username: 'pick_focus', role: 'core', focusMode: true });
    await makeUser({ username: 'pick_banned', role: 'admin', isBanned: true });
    const blog = await makeBlog({ authorId: viewer.id });
    const response = await request('comment', blog.id, 'pick_');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await names(response)).toEqual(['pick_banned', 'pick_focus']);
  });

  it('大区排除专注、有效禁言、静音者，过期禁言恢复可选', async () => {
    const viewer = await makeUser({ role: 'core' }); await login(viewer.id);
    await makeUser({ username: 'pick_focus', role: 'core', focusMode: true });
    await makeUser({ username: 'pick_banned', role: 'core', isBanned: true });
    const expired = new Date(nowForDb().getTime() - 1000);
    await makeUser({ username: 'pick_expired', role: 'core', isBanned: true, banUntil: expired });
    const muted = await makeUser({ username: 'pick_muted', role: 'core' });
    await setChannelMuted('lobby', muted.id, true);
    expect(await names(await request('chat', 'lobby', 'pick_'))).toEqual(['pick_expired']);
    await prisma.user.update({ where: { id: viewer.id }, data: { focusMode: true } });
    expect((await request()).status).toBe(404);
  });

  it('私聊只列本会话成员，专注模式不阻止私聊', async () => {
    const viewer = await makeUser({ role: 'core' }); await login(viewer.id);
    const peer = await makeUser({ username: 'pick_peer', role: 'core', focusMode: true });
    await makeUser({ username: 'pick_outsider', role: 'core' });
    const channel = await startDirectChannel(viewer.id, peer.id);
    expect(channel.ok).toBe(true); if (!channel.ok) return;
    expect(await names(await request('chat', channel.channel.id, 'pick_'))).toEqual(['pick_peer']);
    await setChannelMuted(channel.channel.id, peer.id, true);
    expect(await names(await request('chat', channel.channel.id, 'pick_'))).toEqual([]);
  });

  it('空前缀也限制最多八人，按用户名前缀搜索', async () => {
    const viewer = await makeUser({ role: 'core' }); await login(viewer.id);
    const blog = await makeBlog({ authorId: viewer.id });
    for (let i = 0; i < 12; i++) await makeUser({ username: `pick_${i.toString().padStart(2, '0')}`, role: 'core' });
    expect(await names(await request('comment', blog.id))).toHaveLength(8);
    expect(await names(await request('comment', blog.id, 'pick_11'))).toEqual(['pick_11']);
  });
});
