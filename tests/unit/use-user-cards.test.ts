// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// use-user-cards.test.ts —— `[@用户/<用户名>]` 异步取数的行为约束
//
// 【为什么值得单测】与 use-resolved-content.test.ts 是同一类：这段逻辑里有几件在
// 浏览器里**看不出来**的事 ——
//   · 模块级缓存：同一个人被 N 条消息引用时只请求一次；
//   · 并发去重：讨论列表一次挂载几十条，引用同一个人时会同时发几十个请求；
//   · 竞态：正文换成另一批名字后，旧的结果不能套用在新正文上；
//   · **失败也进缓存**（与剪贴板那条刻意相反）—— 这条最容易被「顺手统一」掉；
//   · URL 编码：用户名允许中文，不编码那一段字节会直接进 URL。
// e2e 只覆盖「名片画出来了」，覆盖不到这些。
//
// 【环境】不引 @testing-library/react（本仓库没有这个依赖），用 react-dom/client
// 的 createRoot + React 19 的 act 直接驱动 —— 照 use-resolved-content.test.ts 的路子。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useUserCards } from '@/app/components/useUserCards';
import { MAX_USER_REFS, type UserCardData } from '@/lib/user-refs';

// React 要求显式声明「这是测试环境」，否则 act 会警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 每个用例用不同的名字 —— 模块级缓存跨用例存活，复用名字会互相干扰。 */
let seq = 0;
function freshName(): string {
  seq += 1;
  return `n${seq}user`; // 合法用户名：字母数字、3-20 位
}

const out = { cards: undefined as Map<string, UserCardData> | undefined };

function Probe({ content }: { content: string }): ReactElement | null {
  out.cards = useUserCards(content);
  return null;
}

/** 挂载 hook，返回「改正文」。 */
function mountHook(content: string) {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe, { content }));
  });
  return {
    update: (next: string) =>
      act(() => {
        root.render(createElement(Probe, { content: next }));
      }),
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

/** 把挂起的 promise 链跑完（fetch 的 then / finally 都要轮到）。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 装一个 fetch 桩，返回请求过的 URL 列表。404 / 403 用 'MISS' 表示。 */
function stubFetch(impl: (url: string) => unknown) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = impl(url);
    if (body === 'MISS') return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

/** 成功的公开资料响应（形状对齐 GET /api/users/[id]）。 */
function profileResponse(username: string, over: Record<string, unknown> = {}) {
  return {
    code: 200,
    message: 'ok',
    user: {
      id: `id-${username}`,
      username,
      avatarPath: null,
      frameUrl: null,
      bio: null,
      createdAt: null,
      role: null,
      showRecentBlogs: true,
      showRecentComments: true,
      recentBlogs: [],
      recentComments: [],
      ...over,
    },
  };
}

const cardOf = (name: string) => out.cards?.get(name);

beforeEach(() => {
  // ⚠️ **不要重置 seq** —— 模块级缓存跨用例存活，名字一复用，上一个用例的结果就会
  // 被下一个用例读到（表现为「明明改了桩，拿到的还是旧数据」）。与
  // use-resolved-content.test.ts 里 freshClipId 的写法同源。
  out.cards = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useUserCards', () => {
  it('取到名片 → 按名字给出 id / username / frameUrl', async () => {
    const name = freshName();
    stubFetch(() => profileResponse(name, { frameUrl: '/api/frames/cat.png' }));
    mountHook(`你好 [@用户/${name}]`);

    expect(out.cards, '首帧必须是 undefined（还没取到）').toBeUndefined();
    await flush();

    const name2 = name;
    expect(cardOf(name2)).toEqual({
      id: `id-${name2}`,
      username: name2,
      frameUrl: '/api/frames/cat.png',
    });
  });

  it('★ 请求的是站内那条资料接口，名字段做过编码（中文名不能把字节直接塞进 URL）', async () => {
    stubFetch(() => profileResponse('张三丰'));
    mountHook('看 [@用户/张三丰]');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = String((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(url).toBe(`/api/users/${encodeURIComponent('张三丰')}`);
    expect(url, '未编码的中文会以原始字节进 URL').not.toContain('张三丰');
  });

  it('★ 查无此人 → 该名字不出现在结果里，且不抛（token 留在正文里当字面量）', async () => {
    stubFetch(() => 'MISS');
    mountHook('[@用户/ghostuser]');
    await flush();
    expect(out.cards?.has('ghostuser')).toBe(false);
    expect(out.cards?.size, '整张 Map 为空，渲染器据此把 token 当字面量').toBe(0);
  });

  it('★ 并发去重：同一个人被同一条消息引用多次，只请求一次', async () => {
    const name = freshName();
    stubFetch(() => profileResponse(name));
    mountHook(`[@用户/${name}] 和 [@用户/${name}] 还有 [@用户/${name}]`);
    await flush();
    expect(out.cards?.size).toBe(1);
    expect(fetch, 'collectUserCardNames 先去重，再交给并发去重').toHaveBeenCalledTimes(1);
  });

  it('★ 模块级缓存：第二次挂载同一个人不再发请求', async () => {
    const name = freshName();
    stubFetch(() => profileResponse(name));
    const h1 = mountHook(`[@用户/${name}]`);
    await flush();
    h1.unmount();

    const h2 = mountHook(`[@用户/${name}]`);
    await flush();
    h2.unmount();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cardOf(name)?.username).toBe(name);
  });

  it('★ 查不到也进缓存 —— 名字打错时不该每挂载一次就重打一次 404', async () => {
    // 这一条与剪贴板那条**刻意相反**（那边失败不进缓存，因为失败多半是瞬时的）。
    // 这里的失败绝大多数是确定性的（名字错 / 账号不存在 / 对方非 core+），重试只是
    // 把同一个 404 再打一遍。真·网络抖动由 5 分钟的 TTL 兜住。
    const name = freshName();
    stubFetch(() => 'MISS');
    const h1 = mountHook(`[@用户/${name}]`);
    await flush();
    h1.unmount();

    const h2 = mountHook(`[@用户/${name}]`);
    await flush();
    h2.unmount();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('正文里没有名片 → 一个请求都不发，返回 undefined', async () => {
    stubFetch(() => profileResponse('x'));
    mountHook('普通正文 [@a1b2c3d4] [@猫猫/开心] @张三丰');
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(out.cards).toBeUndefined();
  });

  it('★ 上限：一条消息最多查 MAX_USER_REFS 个人（与渲染时那个预算是同一个数）', async () => {
    const names = Array.from({ length: MAX_USER_REFS + 3 }, () => freshName());
    stubFetch((url) => profileResponse(url.split('/').pop() ?? ''));
    mountHook(names.map((n) => `[@用户/${n}]`).join(' '));
    await flush();
    expect(out.cards?.size).toBe(MAX_USER_REFS);
    expect(fetch).toHaveBeenCalledTimes(MAX_USER_REFS);
  });

  it('★ 竞态：正文换成另一批名字后，旧结果不套用在新正文上', async () => {
    const first = freshName();
    const second = freshName();
    stubFetch((url) => profileResponse(url.split('/').pop() ?? ''));
    const h = mountHook(`[@用户/${first}]`);
    // 还没等到第一批回来就换正文
    h.update(`[@用户/${second}]`);
    await flush();
    expect(out.cards?.has(first), '第一批的结果不能跟着新正文一起用').toBe(false);
    expect(out.cards?.has(second)).toBe(true);
  });

  it('★ 返回的 Map 引用稳定：同一批名字重渲染不会换一个新对象', async () => {
    // RichContentBody 拿它当 useMemo 的依赖 —— 每次渲染换新引用会让整条渲染管线
    // 每渲染一次就重算一遍 marked + DOMPurify（不报错，只是白烧 CPU）。
    const name = freshName();
    stubFetch(() => profileResponse(name));
    const h = mountHook(`[@用户/${name}]`);
    await flush();
    const firstRef = out.cards;

    h.update(`[@用户/${name}]`);
    expect(out.cards).toBe(firstRef);
    h.unmount();
  });

  it('接口载荷形状不对（缺 id / username）→ 当查不到，不画出半个坏节点', async () => {
    const name = freshName();
    stubFetch(() => ({ code: 200, message: 'ok', user: { username: name } }));
    mountHook(`[@用户/${name}]`);
    await flush();
    expect(out.cards?.size).toBe(0);
  });
});
