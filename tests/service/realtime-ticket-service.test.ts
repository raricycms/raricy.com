import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { consumeRealtimeTicket, issueRealtimeTicket, REALTIME_TICKET_TTL_MS, validateRealtimeIdentity } from '@/lib/realtime-ticket-service';
import { POST } from '@/app/api/internal/realtime/session/route';

const SERVICE_TOKEN = 'unit-test-realtime-service-token-not-for-production';
beforeEach(async () => {
  await resetDb();
  vi.stubEnv('REALTIME_SERVICE_TOKEN', SERVICE_TOKEN);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('实时游戏一次性票据', () => {
  it('并发消费只成功一次，身份只取主站记录', async () => {
    const user = await makeUser();
    const issued = issueRealtimeTicket(user, 'wand')!;
    expect(issued.expiresIn).toBe(60);
    const results = await Promise.all(Array.from({ length: 3 }, () => consumeRealtimeTicket(issued.ticket, 'wand')));
    expect(results.filter(Boolean)).toEqual([{ userId: user.id, username: user.username, sessionVersion: user.sessionVersion }]);
  });

  it('不能跨游戏消费，过期后不能重新使用', async () => {
    const user = await makeUser();
    const issued = issueRealtimeTicket(user, 'wand')!;
    expect(await consumeRealtimeTicket(issued.ticket, 'other')).toBeNull();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + REALTIME_TICKET_TTL_MS);
    expect(await consumeRealtimeTicket(issued.ticket, 'wand')).toBeNull();
    clock.mockRestore();
    expect(await consumeRealtimeTicket(issued.ticket, 'wand')).toBeNull();
  });

  it('限制未消费的票据数量，重复申请使最旧票据失效', async () => {
    const user = await makeUser();
    const issued = Array.from({ length: 5 }, () => issueRealtimeTicket(user, 'wand')!);
    expect(await consumeRealtimeTicket(issued[0].ticket, 'wand')).toBeNull();
    for (const item of issued.slice(1)) expect(await consumeRealtimeTicket(item.ticket, 'wand')).not.toBeNull();
  });

  it.each(['focusMode', 'sessionVersion', 'isBanned'] as const)('签发后 %s 改变时拒绝消费和复核', async (field) => {
    const user = await makeUser();
    const issued = issueRealtimeTicket(user, 'wand')!;
    const identity = { userId: user.id, username: user.username, sessionVersion: user.sessionVersion };
    await prisma.user.update({ where: { id: user.id }, data: { [field]: field === 'sessionVersion' ? user.sessionVersion + 1 : true } });
    expect(await consumeRealtimeTicket(issued.ticket, 'wand')).toBeNull();
    expect(await validateRealtimeIdentity(identity)).toBeNull();
  });

  it('专注或封禁时不签发，已到期的临时封禁可以玩', async () => {
    const focused = await makeUser({ focusMode: true });
    const banned = await makeUser({ isBanned: true });
    const expired = await makeUser({ isBanned: true, banUntil: new Date(nowForDb().getTime() - 1000) });
    expect(issueRealtimeTicket(focused, 'wand')).toBeNull();
    expect(issueRealtimeTicket(banned, 'wand')).toBeNull();
    const issued = issueRealtimeTicket(expired, 'wand')!;
    expect(await consumeRealtimeTicket(issued.ticket, 'wand')).not.toBeNull();
  });
});

describe('主站服务间身份接口', () => {
  function request(body: unknown, token?: string) {
    return new Request('http://localhost/api/internal/realtime/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'session=browser-session', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it('浏览器 Cookie 或错误凭据无法消费票据，独立服务凭据才可以', async () => {
    const user = await makeUser();
    const issued = issueRealtimeTicket(user, 'wand')!;
    const body = { action: 'consume', gameId: 'wand', ticket: issued.ticket };
    for (const token of [undefined, 'incorrect-token']) expect((await POST(request(body, token))).status).toBe(401);
    const response = await POST(request(body, SERVICE_TOKEN));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ identity: { userId: user.id, username: user.username, sessionVersion: user.sessionVersion } });
    expect((await POST(request(body, SERVICE_TOKEN))).status).toBe(403);
  });

  it('不允许伪造身份绕过专注模式，拒绝不完整身份和未知操作', async () => {
    const user = await makeUser({ focusMode: true });
    const identity = { userId: user.id, username: '伪造名字', sessionVersion: user.sessionVersion };
    expect((await POST(request({ action: 'validate', gameId: 'wand', identity }, SERVICE_TOKEN))).status).toBe(403);
    expect((await POST(request({ action: 'validate', gameId: 'wand', identity: { userId: user.id } }, SERVICE_TOKEN))).status).toBe(400);
    expect((await POST(request({ action: 'unknown' }, SERVICE_TOKEN))).status).toBe(400);
  });
});
