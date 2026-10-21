import { beforeEach, describe, expect, it, vi } from 'vitest';

// 设置页「专注模式」的读/写口：GET/PATCH /api/users/me/focus。
//
// 这里钉的是**契约本身**（形状、NULL vs []、鉴权、只改自己），不重复测各处的
// 闸门 —— 那些在 chat / market / realtime 的用例里。最容易静默错的两条：
//   1. hiddenCategoryIds: null（恢复默认）被当成 []（一个都不屏蔽）；
//   2. PATCH 接受了别人的 id / 写错账号。
const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (session.token ? { value: session.token } : undefined) }),
}));

import { GET as getFocus, PATCH as patchFocus } from '@/app/api/users/me/focus/route';
import { PATCH as patchProfile } from '@/app/api/users/me/route';
import { createSessionToken } from '@/lib/session';
import { makeCategory, makeUser, resetDb, prisma } from '../helpers/db';

beforeEach(async () => {
  session.token = undefined;
  await resetDb();
});

const login = async (id: string) => {
  session.token = await createSessionToken({ uid: id, sv: 0 });
};

function req(body?: unknown) {
  return new Request('http://localhost/api/users/me/focus', {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('GET /api/users/me/focus', () => {
  it('未登录 → 401', async () => {
    expect((await getFocus()).status).toBe(401);
  });

  it('新用户：三个子项默认全开、未自定义、selected 为空、只列启用中的栏目', async () => {
    const me = await makeUser();
    await login(me.id);
    const active = await makeCategory({ name: '启用栏目' });
    const inactive = await makeCategory({ name: '停用栏目', isActive: false });

    const res = await getFocus();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.settings).toEqual({
      enabled: false,
      blockLobby: true,
      blockGames: true,
      blockFishTrade: true,
    });
    expect(body.customized).toBe(false);
    expect(body.selected).toEqual([]);
    expect(body.categories.map((c: { id: number }) => c.id)).toContain(active.id);
    expect(body.categories.map((c: { id: number }) => c.id)).not.toContain(inactive.id);
  });

  it('未自定义时 selected = 站长标记的默认集合（含子栏目）', async () => {
    const me = await makeUser({ focusMode: true });
    await login(me.id);
    const flagged = await makeCategory({ focusHidden: true });
    const child = await makeCategory({ parentId: flagged.id });

    const body = await (await getFocus()).json();
    expect(new Set(body.selected)).toEqual(new Set([flagged.id, child.id]));
    expect(body.customized).toBe(false);
  });
});

describe('PATCH /api/users/me/focus', () => {
  it('开关与三个子项：只改传入的字段，其余保持', async () => {
    const me = await makeUser({ role: 'core' });
    await login(me.id);

    let res = await patchFocus(req({ enabled: true, blockGames: false }));
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.message).toBe('专注模式设置已保存');
    expect(body.settings).toEqual({
      enabled: true,
      blockLobby: true,
      blockGames: false,
      blockFishTrade: true,
    });

    res = await patchFocus(req({ blockLobby: false }));
    body = await res.json();
    expect(body.settings).toMatchObject({ enabled: true, blockGames: false, blockLobby: false });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(row.focusMode).toBe(true);
    expect(row.focusBlockGames).toBe(false);
    expect(row.focusBlockLobby).toBe(false);
    expect(row.focusBlockFishTrade).toBe(true);
  });

  it('★ hiddenCategoryIds: [] 与 null 是两种状态（一个都不屏蔽 vs 恢复默认集合）', async () => {
    const me = await makeUser({ focusMode: true });
    await login(me.id);
    const flagged = await makeCategory({ focusHidden: true });
    const normal = await makeCategory();

    // [] = 明确一个都不屏蔽
    let res = await patchFocus(req({ hiddenCategoryIds: [] }));
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.customized).toBe(true);
    expect(body.selected).toEqual([]);

    // 显式选中某栏目 → 展开子栏目
    res = await patchFocus(req({ hiddenCategoryIds: [normal.id] }));
    body = await res.json();
    expect(body.customized).toBe(true);
    expect(body.selected).toEqual([normal.id]);

    // null = 恢复站长默认集合
    res = await patchFocus(req({ hiddenCategoryIds: null }));
    body = await res.json();
    expect(body.customized).toBe(false);
    expect(body.selected).toContain(flagged.id);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(row.focusHideCategories).toBeNull();
  });

  it('非法请求 → 4xx，且不改库', async () => {
    const me = await makeUser();
    await login(me.id);

    expect((await patchFocus(req({ enabled: 'true' }))).status).toBe(400);
    expect((await patchFocus(req({ hiddenCategoryIds: 'x' }))).status).toBe(400);
    expect((await patchFocus(req({ hiddenCategoryIds: [1.5] }))).status).toBe(400);
    expect((await patchFocus(req({}))).status).toBe(400);
    expect((await patchFocus(new Request('http://localhost/x', { method: 'PATCH', body: '{' }))).status).toBe(400);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(row.focusMode).toBe(false);
    expect(row.focusHideCategories).toBeNull();
  });

  it('只改自己：另一个账号的设置不受影响', async () => {
    const me = await makeUser();
    const other = await makeUser({ focusMode: true, focusBlockGames: false });
    await login(me.id);

    expect((await patchFocus(req({ enabled: true }))).status).toBe(200);

    const otherRow = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    expect(otherRow.focusMode).toBe(true);
    expect(otherRow.focusBlockGames).toBe(false);
    const mine = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(mine.focusMode).toBe(true);
  });

  it('旧契约：PATCH /api/users/me 仍接受 focusMode（机器人文档在用）', async () => {
    const me = await makeUser();
    await login(me.id);
    const res = await patchProfile(
      new Request('http://localhost/api/users/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focusMode: true }),
      })
    );
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: me.id } })).focusMode).toBe(true);
  });
});
