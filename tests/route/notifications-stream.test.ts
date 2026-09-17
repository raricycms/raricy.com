// GET /api/notifications/stream —— 顶栏指示器 SSE 路由
//
// 【为什么测这个】这条路由有三件「写错了不会报错、只会静默失效」的事：
//   1. **首帧全量快照**：整条流的可靠性兜底就靠它（重连即自愈，没有 Last-Event-ID 补齐）。
//      漏发它，客户端重连后一直停在旧值，而服务端一切正常。
//   2. **未登录 401**：EventSource 对非 200 会 fail the connection 且不再重试 —— 这正是
//      我们要的（会话废了就别空转）。若改成 200 + 空流，它会永远重连。
//   3. **订阅先于快照**：反过来的话，算快照那几毫秒里产生的推送会丢。这条不好直接断言，
//      但下面「订阅后写通知 → 收到 patch」的用例覆盖了订阅确实建立了。
//
// 本文件打的是真实 route handler（不 mock Prisma），只 mock 登录态。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 只替换 getCurrentUser，保留真实的 isCoreUser / isCurrentlyBanned ——
// 红点闸门（core+ / 未禁言）正是被测语义的一部分
const mockUser = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getCurrentUser: async () => mockUser.current };
});

import { resetDb, makeUser } from '../helpers/db';
import { GET } from '@/app/api/notifications/stream/route';
import { sendNotification, markAllRead } from '@/lib/notification-service';
import { __resetTopbarBus } from '@/lib/topbar-bus';

type Patch = { count?: number; chatUnread?: boolean; refresh?: true };

/**
 * 后台读流，把 data 帧解析成对象追加进 frames；注释帧（`: ping`、`retry:`）直接丢掉。
 * 返回的 cancel() 用于收尾 —— 不取消的话，下一条用例的 resetDb 会撞上还开着的流。
 */
function pump(res: Response) {
  const frames: Patch[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {
      /* 被 cancel 掉了 */
    }
  })();
  return {
    frames,
    done,
    cancel: () => {
      void reader.cancel().catch(() => {});
    },
  };
}

/** 轮询等待条件成立（帧是异步到达的，没有可 await 的信号）。 */
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

const openStreams: Array<() => void> = [];

beforeEach(async () => {
  await resetDb();
  __resetTopbarBus();
  mockUser.current = null;
});

afterEach(async () => {
  while (openStreams.length) openStreams.pop()!();
  __resetTopbarBus();
});

async function open(userId: string) {
  mockUser.current = { id: userId };
  const res = await GET(new Request('http://x/api/notifications/stream'));
  if (res.body) {
    const p = pump(res);
    openStreams.push(() => {
      p.cancel();
      void p.done;
    });
    return { res, ...p };
  }
  return { res, frames: [] as Patch[], done: Promise.resolve(), cancel: () => {} };
}

describe('GET /api/notifications/stream', () => {
  it('未登录 → 401（EventSource 会因此 fail 且不再重试，正是我们要的）', async () => {
    mockUser.current = null;
    const res = await GET(new Request('http://x/api/notifications/stream'));
    expect(res.status).toBe(401);
  });

  it('已登录 → 响应头是 SSE，且首帧就是全量快照（两个字段都在）', async () => {
    const u = await makeUser({ role: 'core' });
    const { res, frames } = await open(u.id);

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // no-transform 不可省：少了它 next start 的压缩中间件会把事件攒到流结束才发
    expect(res.headers.get('cache-control')).toContain('no-transform');

    expect(await waitFor(() => frames.length >= 1), '没有收到首帧快照').toBe(true);
    expect(frames[0]).toEqual({ count: 0, chatUnread: false });
  });

  it('快照里的未读数来自库（不是写死的 0）', async () => {
    const u = await makeUser({ role: 'core' });
    await sendNotification({ recipientId: u.id, action: '系统公告', force: true });
    await sendNotification({ recipientId: u.id, action: '系统公告', force: true });

    const { frames } = await open(u.id);
    expect(await waitFor(() => frames.length >= 1)).toBe(true);
    expect(frames[0].count).toBe(2);
  });

  it('连接期间产生通知 → 推来 {count} 补丁帧', async () => {
    const u = await makeUser({ role: 'core' });
    const { frames } = await open(u.id);
    expect(await waitFor(() => frames.length >= 1)).toBe(true);

    await sendNotification({ recipientId: u.id, action: '系统公告', force: true });

    expect(await waitFor(() => frames.length >= 2), '通知产生了却没推来').toBe(true);
    expect(frames[1]).toEqual({ count: 1 });
  });

  it('补丁只带变化的字段 —— {count} 帧里没有 chatUnread（客户端按字段 merge）', async () => {
    const u = await makeUser({ role: 'core' });
    const { frames } = await open(u.id);
    expect(await waitFor(() => frames.length >= 1)).toBe(true);

    await sendNotification({ recipientId: u.id, action: '系统公告', force: true });
    await waitFor(() => frames.length >= 2);

    expect(Object.keys(frames[1])).toEqual(['count']);
  });

  it('标已读 → 推来回落后的 {count}', async () => {
    const u = await makeUser({ role: 'core' });
    await sendNotification({ recipientId: u.id, action: '系统公告', force: true });

    const { frames } = await open(u.id);
    expect(await waitFor(() => frames.length >= 1)).toBe(true);
    expect(frames[0].count).toBe(1);

    await markAllRead(u.id);

    expect(await waitFor(() => frames.length >= 2)).toBe(true);
    expect(frames[1]).toEqual({ count: 0 });
  });

  it('别人的通知不会推给我（只推目标用户）', async () => {
    const me = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });

    const { frames } = await open(me.id);
    expect(await waitFor(() => frames.length >= 1)).toBe(true);

    await sendNotification({ recipientId: other.id, action: '系统公告', force: true });
    await sendNotification({ recipientId: other.id, action: '系统公告', force: true });

    // 反向确认：给我自己发一条必须到（否则「没收到」可能只是流坏了）
    await sendNotification({ recipientId: me.id, action: '系统公告', force: true });
    expect(await waitFor(() => frames.length >= 2)).toBe(true);

    expect(frames.slice(1)).toEqual([{ count: 1 }]);
  });

  it('非 core 用户的快照里 chatUnread 恒为 false（够不着讨论页）', async () => {
    const u = await makeUser({ role: 'user' });
    const { frames } = await open(u.id);

    expect(await waitFor(() => frames.length >= 1)).toBe(true);
    expect(frames[0]).toEqual({ count: 0, chatUnread: false });
  });
});
