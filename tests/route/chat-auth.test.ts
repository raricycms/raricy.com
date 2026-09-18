// 讨论接口的档位 —— route handler 层
//
// 【为什么单独一个文件】讨论的 13 个 handler **全都**在参数解析之前调
// `requireChatUser()`（`src/app/api/chat/_auth.ts`），口径是整齐的 core+。但整齐不等于
// 有保护：本轮审计发现，全仓**没有任何用例**断言过讨论接口对非核心用户 403 ——
// 唯一的契约是页面级的 `/chat` 403（tests/e2e/access-control.spec.ts）。
// 也就是说，把这 13 条守卫删掉任何一条，现有测试都不会变红。
//
// 【判据为什么看 message 而不只看 status】业务逻辑自己也会回 403
// （`canAccessChannel` 判频道归属），与「档位不够」是两回事。所以：
//   · 拒绝路径断言 status **且** message 恰是守卫那三条文案；
//   · 放行路径断言它**不是**守卫拒绝 —— 而不是断言 200，否则业务侧的 400/404
//     会把「档位已放行」误判成失败，测试就变成了「顺带测业务」，脆且跑偏。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。频道用固定的大区 `lobby`：它对任何 core
// 用户开放且会自动建行（`canAccessChannel` 的 lobby 分支），无需种子数据。

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import fs from 'node:fs';
import path from 'node:path';
import { resetDb, makeUser } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { CHAT_LOBBY_ID } from '@/lib/chat-shared';

import { POST as createChannel } from '@/app/api/chat/channels/route';
import { GET as listMessages, POST as sendMessage } from '@/app/api/chat/channels/[id]/messages/route';
import { POST as muteChannel } from '@/app/api/chat/channels/[id]/mute/route';
import { POST as hideChannel } from '@/app/api/chat/channels/[id]/hide/route';
import { POST as readChannel } from '@/app/api/chat/channels/[id]/read/route';
import { GET as searchChannel } from '@/app/api/chat/channels/[id]/search/route';
import { POST as typing } from '@/app/api/chat/channels/[id]/typing/route';
import { POST as viewing } from '@/app/api/chat/channels/[id]/viewing/route';
import { DELETE as deleteMessage } from '@/app/api/chat/messages/[id]/route';
import { GET as poll } from '@/app/api/chat/poll/route';
import { GET as stream } from '@/app/api/chat/stream/route';
import { GET as chatUsers } from '@/app/api/chat/users/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** Next 15 的 params 是 Promise。 */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** 守卫的三种拒绝文案（`src/app/api/chat/_auth.ts`）—— 一字不差地钉住。 */
const GUARD_MESSAGES = ['请先登录', '需要核心用户权限', '你已被禁言，暂时无法讨论'];

/** 递归找出所有 route.ts（用于「清单完整性」那条自检）。 */
function findRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findRouteFiles(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

const url = (path: string) => new Request(`http://localhost${path}`);
const post = (path: string, body: unknown = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 该响应是不是「被档位守卫挡住」的那个（而不是业务逻辑自己的 401/403）。 */
async function isGuardRejection(res: Response): Promise<boolean> {
  if (res.status !== 401 && res.status !== 403) return false;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return GUARD_MESSAGES.includes(body?.message ?? '');
}

/**
 * 13 个 handler。`call` 一律用合法的大区 id，好让 core 用户走完档位之后能落进业务逻辑。
 * ⚠️ `/api/chat/stream` 只进「拒绝」两连、不进「放行」组：它一旦放行就会挂起一条 SSE
 * 长连接，把用例拖到超时 —— 那不是档位的问题，是这条路由的形态使然。
 */
const cases: { name: string; call: () => Promise<Response>; canProbeAllow?: boolean }[] = [
  { name: 'POST /api/chat/channels', call: () => createChannel(post('/api/chat/channels', {})) },
  { name: 'GET  /api/chat/channels/:id/messages', call: () => listMessages(url('/x'), ctx(CHAT_LOBBY_ID)) },
  { name: 'POST /api/chat/channels/:id/messages', call: () => sendMessage(post('/x', { content: 'x' }), ctx(CHAT_LOBBY_ID)) },
  { name: 'POST /api/chat/channels/:id/mute', call: () => muteChannel(post('/x'), ctx(CHAT_LOBBY_ID)) },
  { name: 'POST /api/chat/channels/:id/hide', call: () => hideChannel(post('/x'), ctx(CHAT_LOBBY_ID)) },
  { name: 'POST /api/chat/channels/:id/read', call: () => readChannel(post('/x'), ctx(CHAT_LOBBY_ID)) },
  { name: 'GET  /api/chat/channels/:id/search', call: () => searchChannel(url('/x?q=x'), ctx(CHAT_LOBBY_ID)) },
  { name: 'POST /api/chat/channels/:id/typing', call: () => typing(post('/x'), ctx(CHAT_LOBBY_ID)) },
  { name: 'POST /api/chat/channels/:id/viewing', call: () => viewing(post('/x'), ctx(CHAT_LOBBY_ID)) },
  { name: 'DELETE /api/chat/messages/:id', call: () => deleteMessage(new Request('http://localhost/x', { method: 'DELETE' }), ctx('999999')) },
  { name: 'GET  /api/chat/poll', call: () => poll(url(`/api/chat/poll?channel=${CHAT_LOBBY_ID}`)) },
  { name: 'GET  /api/chat/users', call: () => chatUsers(url('/api/chat/users?q=x')) },
  { name: 'GET  /api/chat/stream（SSE，只测拒绝）', call: () => stream(url('/api/chat/stream')), canProbeAllow: false },
];

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});

describe('讨论接口的档位（13 个 handler）', () => {
  it('清单要盖住 chat 下的**全部** handler（漏一条 = 漏一个免检的口子）', () => {
    // 真的去扫盘，不是断言我自己写的数组长度 —— 新增一条讨论路由而忘了补进 cases 时，
    // 它必须变红。否则那条路由在「有没有测试保护」这件事上是隐形的。
    const dir = path.resolve(import.meta.dirname, '../../src/app/api/chat');
    const count = findRouteFiles(dir).reduce((n, f) => {
      const src = fs.readFileSync(f, 'utf8');
      return (
        n + (src.match(/\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g) ?? []).length
      );
    }, 0);
    expect(count, 'chat 下的 handler 数与 cases 表对不上，新路由要补进本文件的 cases').toBe(
      cases.length
    );
  });

  for (const c of cases) {
    it(`${c.name}：匿名 → 被守卫挡下`, async () => {
      const res = await c.call();
      expect(res.status, '匿名必须 401').toBe(401);
      expect(await isGuardRejection(res), '且要是守卫那条文案，不是业务逻辑凑巧的 401').toBe(true);
    });

    it(`${c.name}：非 core → 被守卫挡下`, async () => {
      const plain = await makeUser({ role: 'user' });
      await login(plain.id);
      const res = await c.call();
      expect(res.status, '非 core 必须 403').toBe(403);
      expect(await isGuardRejection(res), '且要是守卫那条文案').toBe(true);
    });

    if (c.canProbeAllow !== false) {
      it(`${c.name}：core → 过档位`, async () => {
        const core = await makeUser({ role: 'core' });
        await login(core.id);
        const res = await c.call();
        expect(await isGuardRejection(res), 'core 不该被档位挡住').toBe(false);
      });
    }
  }
});
