// 投票域的档位与归属 —— route handler 层
//
// 【为什么单独一个文件】`/api/votes/:id` 的 PATCH / DELETE 是 2026-09 新收编进来的：
// 锁定 / 解锁 / 删除此前**只存在于** `/vote/[id]` 页面的 server action 里（全站唯一一处
// `'use server'`）。server action 走 RSC 协议、action id 随构建变 —— 站外调用方拿不到，
// 于是「机器人建得了投票，却锁不了也删不掉」。收编成接口后，这一域六个 handler 在
// 本文件里逐条钉住：删掉任何一条守卫，这里必须变红。
//
// 【归属也是断言对象】PATCH / DELETE 有两层，别混：
//   · 档位 —— 是不是 core+（与创建/投票同档，见 `docs/architecture.md` §8）；
//   · 归属 —— 这个投票是不是你的（service 层判 authorId）。
// 只判登录就当「是我的」的写法会在这里被抓住：非创建者的 core 用户必须拿 403，
// 而不是 200 —— 那才是「谁都能删别人的投票」。
//
// 【判据为什么看 message 而不只看 status】归属分支自己也会回 403（'无权管理该投票' /
// '无权删除该投票'），与「档位不够」是两回事。所以拒绝路径一律断言 status **且**
// message 恰是那几条文案；放行路径断言它**不是**档位拒绝，而不是断言 200。
//
// 【DB】真实 SQLite（tests/.tmp/test-*）。

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
import { nowForDb } from '@/lib/db-time';
import { prisma } from '@/lib/db';

import { GET as listVotes, POST as createVote } from '@/app/api/votes/route';
import {
  GET as getVote,
  PATCH as patchVote,
  DELETE as deleteVote,
} from '@/app/api/votes/[id]/route';
import { POST as castVote } from '@/app/api/votes/[id]/vote/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** Next 15 的 params 是 Promise。 */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const url = (p: string) => new Request(`http://localhost${p}`);
const withBody = (method: string) => (p: string, body: unknown = {}) =>
  new Request(`http://localhost${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const post = withBody('POST');
const patch = withBody('PATCH');
const del = (p: string) => new Request(`http://localhost${p}`, { method: 'DELETE' });

/**
 * 档位守卫的拒绝文案 —— 一字不差地钉住。
 * 禁言文案**不在**这个集合里：禁言是档位之后的另一道闸，而投票这一域压根不判禁言
 * （见 `vote/[id]/route.ts`：锁自己的投票不是发言，与 `POST /api/votes` 同口径）。
 */
const GUARD_MESSAGES = ['请先登录', '需要核心用户权限'];

/** 该响应是不是「被档位守卫挡住」的那个（而不是业务逻辑自己的 401/403）。 */
async function isGuardRejection(res: Response): Promise<boolean> {
  if (res.status !== 401 && res.status !== 403) return false;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return GUARD_MESSAGES.includes(body?.message ?? '');
}

let voteSeq = 0;
/** 造一个投票（两个选项）。不走 createVote 是为了能直接摆出 ignore / isLocked 这些状态。 */
async function makeVote(opts: {
  authorId: string;
  isLocked?: boolean;
  ignore?: boolean;
  title?: string;
}) {
  return prisma.vote.create({
    data: {
      id: `test-vote-${++voteSeq}`,
      title: opts.title ?? '测试投票',
      authorId: opts.authorId,
      isLocked: opts.isLocked ?? false,
      ignore: opts.ignore ?? false,
      createdAt: nowForDb(),
      options: {
        create: [
          { label: 'A', sortOrder: 0, voteCount: 0 },
          { label: 'B', sortOrder: 1, voteCount: 0 },
        ],
      },
    },
    include: { options: true },
  });
}

/** 递归找出所有 route.ts（用于下面「清单完整性」那条自检）。 */
function findRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findRouteFiles(full, out);
    else if (entry.name === 'route.ts') out.push(full);
  }
  return out;
}

// 一律用不存在的 id —— 拒绝方向上守卫跑在一切之前，id 无所谓；放行方向要的也只是
// 「过了档位」这一件事，落进业务后的 404 正合适。
const VOTE_ID = 'no-such-vote';

/** 六个 core+ handler。没有刻意匿名的例外：这一域没有匿名读口。 */
const cases: { name: string; call: () => Promise<Response> }[] = [
  { name: 'GET    /api/votes', call: () => listVotes() },
  { name: 'POST   /api/votes', call: () => createVote(post('/api/votes', {})) },
  { name: 'GET    /api/votes/:id', call: () => getVote(url('/x'), ctx(VOTE_ID)) },
  {
    name: 'PATCH  /api/votes/:id',
    call: () => patchVote(patch('/x', { locked: true }), ctx(VOTE_ID)),
  },
  { name: 'DELETE /api/votes/:id', call: () => deleteVote(del('/x'), ctx(VOTE_ID)) },
  {
    name: 'POST   /api/votes/:id/vote',
    call: () => castVote(post('/x', { optionId: 1 }), ctx(VOTE_ID)),
  },
];

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});

describe('投票的档位（6 个 core+ handler）', () => {
  it('清单要盖住这一域的**全部** handler（漏一条 = 漏一个免检的口子）', async () => {
    // 真的去扫盘，不是断言我自己写的数组长度 —— 新增一条本域路由而忘了补进 cases 时，
    // 它必须变红。否则那条路由在「有没有测试保护」这件事上是隐形的。
    const dir = path.resolve(import.meta.dirname, '../../src/app/api/votes');
    let count = 0;
    for (const f of findRouteFiles(dir)) {
      const src = fs.readFileSync(f, 'utf8');
      count += (
        src.match(/\bexport\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g) ?? []
      ).length;
    }
    expect(
      count,
      'votes/ 下的 handler 数与 cases 对不上，新路由要补进本文件'
    ).toBe(cases.length);
  });

  for (const c of cases) {
    it(`${c.name}：匿名 → 被守卫挡下`, async () => {
      const res = await c.call();
      expect(res.status, '匿名必须 401').toBe(401);
      expect(await isGuardRejection(res), '且要是档位那条文案，不是业务逻辑凑巧的 401').toBe(true);
    });

    it(`${c.name}：非 core → 被守卫挡下`, async () => {
      const plain = await makeUser({ role: 'user' });
      await login(plain.id);
      const res = await c.call();
      expect(res.status, '非 core 必须 403').toBe(403);
      expect(await isGuardRejection(res), '且要是档位那条文案').toBe(true);
    });

    it(`${c.name}：core → 过档位`, async () => {
      const core = await makeUser({ role: 'core' });
      await login(core.id);
      const res = await c.call();
      expect(await isGuardRejection(res), 'core 不该被档位挡住').toBe(false);
    });
  }
});

describe('PATCH /api/votes/:id — 锁定 / 解锁（创建者本人）', () => {
  it('创建者锁定 → 200，且库里真的锁上、随后投不了票', async () => {
    const author = await makeUser({ role: 'core' });
    const vote = await makeVote({ authorId: author.id });
    await login(author.id);

    const res = await patchVote(patch(`/api/votes/${vote.id}`, { locked: true }), ctx(vote.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; is_locked: boolean };
    expect(body.code).toBe(200);
    expect(body.is_locked).toBe(true);

    const row = await prisma.vote.findUnique({
      where: { id: vote.id },
      select: { isLocked: true },
    });
    expect(row?.isLocked, '接口返回 200 但库里没锁上 —— 锁了个寂寞').toBe(true);

    // 锁定**只有**在投票那条路上才看得见意义：锁完必须投不进去。
    const voted = await castVote(
      post(`/api/votes/${vote.id}/vote`, { optionId: vote.options[0].id }),
      ctx(vote.id)
    );
    expect(voted.status, '锁定的投票还投得进 —— 锁形同虚设').toBe(400);
  });

  it('创建者解锁 → 200，库里的锁真的解开', async () => {
    const author = await makeUser({ role: 'core' });
    const vote = await makeVote({ authorId: author.id, isLocked: true });
    await login(author.id);

    const res = await patchVote(patch(`/api/votes/${vote.id}`, { locked: false }), ctx(vote.id));
    expect(res.status).toBe(200);

    const row = await prisma.vote.findUnique({
      where: { id: vote.id },
      select: { isLocked: true },
    });
    expect(row?.isLocked).toBe(false);
  });

  it('★ 非创建者的 core 用户 → 403，且库里没变（两层别混）', async () => {
    const author = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });
    const vote = await makeVote({ authorId: author.id });
    await login(other.id);

    const res = await patchVote(patch(`/api/votes/${vote.id}`, { locked: true }), ctx(vote.id));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe('无权管理该投票');

    const row = await prisma.vote.findUnique({
      where: { id: vote.id },
      select: { isLocked: true },
    });
    expect(row?.isLocked, '403 了却把库改了 —— 拒绝路径必须无副作用').toBe(false);
  });

  it('不存在 / 已软删 → 404 投票不存在（两者同形）', async () => {
    const author = await makeUser({ role: 'core' });
    const gone = await makeVote({ authorId: author.id, ignore: true });
    await login(author.id);

    const missing = await patchVote(patch('/x', { locked: true }), ctx('no-such-vote'));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { message: string }).message).toBe('投票不存在');

    const deleted = await patchVote(patch('/x', { locked: true }), ctx(gone.id));
    expect(deleted.status, '软删过的投票必须当成不存在').toBe(404);
  });

  it('locked 不是布尔 → 400（作者也不行，且不落到 service）', async () => {
    const author = await makeUser({ role: 'core' });
    const vote = await makeVote({ authorId: author.id });
    await login(author.id);

    for (const bad of ['true', 1, 0, null]) {
      const res = await patchVote(patch('/x', { locked: bad }), ctx(vote.id));
      expect(res.status, `locked=${JSON.stringify(bad)} 必须 400`).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('locked 必须是 true 或 false');
    }

    const row = await prisma.vote.findUnique({
      where: { id: vote.id },
      select: { isLocked: true },
    });
    expect(row?.isLocked, '参数错误不该顺手改状态').toBe(false);
  });

  it('缺 body / 非 JSON → 400（不是 500）', async () => {
    const author = await makeUser({ role: 'core' });
    const vote = await makeVote({ authorId: author.id });
    await login(author.id);

    const noBody = await patchVote(
      new Request(`http://localhost/api/votes/${vote.id}`, { method: 'PATCH' }),
      ctx(vote.id)
    );
    expect(noBody.status).toBe(400);

    const notJson = await patchVote(
      new Request(`http://localhost/api/votes/${vote.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '不是 JSON',
      }),
      ctx(vote.id)
    );
    expect(notJson.status).toBe(400);
  });
});

describe('DELETE /api/votes/:id — 软删除（创建者本人）', () => {
  it('创建者删除 → 200，库里是软删（ignore=true）、票还留着', async () => {
    const author = await makeUser({ role: 'core' });
    const vote = await makeVote({ authorId: author.id });
    await login(author.id);

    // 先让两个人各投一票：验证「软删不抹账」—— VoteRecord 是别人投过的记录，
    // 不能跟着投票一起消失（全站永不物理删除）。
    const voter = await makeUser({ role: 'core' });
    for (const who of [author, voter]) {
      await login(who.id);
      const r = await castVote(
        post(`/api/votes/${vote.id}/vote`, { optionId: vote.options[0].id }),
        ctx(vote.id)
      );
      expect(r.status, `${who.username} 这一票没投进去，下面的断言会失去意义`).toBe(200);
    }
    await login(author.id);

    const res = await deleteVote(del(`/api/votes/${vote.id}`), ctx(vote.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: string }).message).toBe('投票已删除');

    const row = await prisma.vote.findUnique({
      where: { id: vote.id },
      select: { ignore: true },
    });
    expect(row, '软删是 UPDATE ignore，行必须还在').not.toBeNull();
    expect(row?.ignore).toBe(true);
    expect(
      await prisma.voteRecord.count({ where: { voteId: vote.id } }),
      '投票记录不该被连带删除'
    ).toBe(2);

    // 删过的再删 → 404；详情也读不到了
    expect((await deleteVote(del('/x'), ctx(vote.id))).status).toBe(404);
    expect((await getVote(url('/x'), ctx(vote.id))).status).toBe(404);
  });

  it('★ 非创建者的 core 用户 → 403，且没被软删', async () => {
    const author = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });
    const vote = await makeVote({ authorId: author.id });
    await login(other.id);

    const res = await deleteVote(del(`/api/votes/${vote.id}`), ctx(vote.id));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe('无权删除该投票');

    const row = await prisma.vote.findUnique({
      where: { id: vote.id },
      select: { ignore: true },
    });
    expect(row?.ignore, '403 了却把别人的投票删了').toBe(false);
  });

  it('不存在 / 已软删 → 404', async () => {
    const author = await makeUser({ role: 'core' });
    const gone = await makeVote({ authorId: author.id, ignore: true });
    await login(author.id);

    expect((await deleteVote(del('/x'), ctx('no-such-vote'))).status).toBe(404);
    expect((await deleteVote(del('/x'), ctx(gone.id))).status).toBe(404);
  });
});
