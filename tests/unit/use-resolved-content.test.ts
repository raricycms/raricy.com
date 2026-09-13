// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// use-resolved-content.test.ts —— `[@<8位>]` 异步展开的行为约束
//
// 【为什么值得单测】这段逻辑有三件容易做错、又都**在浏览器里看不出来**的事：
//   · 模块级缓存：同一条剪贴板要被 N 条消息引用时只请求一次；失败**不能**缓存，
//     否则一次网络抖动会让这条剪贴板在整个会话里永远是「加载失败」；
//   · 并发去重：聊天列表一次挂载几十条，引用同一条剪贴板时会同时发几十个请求；
//   · 竞态：正文换成另一个引用后，旧的展开结果不能套用在新正文上。
// e2e（tests/e2e/content-ref.spec.ts）只覆盖「展开出来了」，覆盖不到这些。
//
// 【环境】不引 @testing-library/react（本仓库没有这个依赖），用 react-dom/client
// 的 createRoot + React 19 的 act 直接驱动 —— 够用，且不多一个依赖。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useResolvedContent } from '@/app/components/useResolvedContent';

// React 要求显式声明「这是测试环境」，否则 act 会警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 每个用例用不同的剪贴板 id —— 模块级缓存跨用例存活，复用 id 会互相干扰。 */
let seq = 0;
function freshClipId(): string {
  seq += 1;
  return `t${String(seq).padStart(7, '0')}`; // 恰好 8 位字母数字
}

const out = { value: '' };

function Probe({ content }: { content: string }): ReactElement | null {
  out.value = useResolvedContent(content);
  return null;
}

/** 挂载 hook，返回「改正文」与「卸载」两个动作。 */
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

/** 装一个 fetch 桩，返回调用计数。 */
function stubFetch(impl: (url: string) => Promise<unknown> | unknown) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = await impl(url);
    if (body === 'NOT_OK') return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

/** 成功的剪贴板响应（形状对齐 GET /api/clipboard/[id]）。 */
function clipResponse(content: string) {
  return { code: 200, message: 'ok', clip: { id: 'x', content } };
}

beforeEach(() => {
  out.value = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useResolvedContent', () => {
  it('没有引用 → 原样返回，且一个请求都不发', async () => {
    const { calls } = stubFetch(() => clipResponse('不该被取'));
    mountHook('普通正文，没有引用');
    await flush();
    expect(out.value).toBe('普通正文，没有引用');
    expect(calls).toEqual([]);
  });

  it('9 位 / 10 位引用不在这里处理（不请求、原样返回）', async () => {
    const { calls } = stubFetch(() => clipResponse('不该被取'));
    mountHook('投票 [@vOtE12345] 图片 [@AbCdEf1234]');
    await flush();
    expect(calls).toEqual([]);
    expect(out.value).toBe('投票 [@vOtE12345] 图片 [@AbCdEf1234]');
  });

  it('8 位引用 → 展开成剪贴板正文', async () => {
    const id = freshClipId();
    const { calls } = stubFetch(() => clipResponse('剪贴板**正文**'));
    mountHook(`看这个 [@${id}] 谢谢`);
    await flush();
    expect(calls).toEqual([`/api/clipboard/${id}`]);
    expect(out.value).toBe('看这个 剪贴板**正文** 谢谢');
  });

  it('★ 只有第一条被展开（一条消息最多 1 条云剪贴板）', async () => {
    const id1 = freshClipId();
    const id2 = freshClipId();
    const { calls } = stubFetch((url) =>
      clipResponse(url.includes(id1) ? '第一条正文' : '第二条正文')
    );
    mountHook(`[@${id1}] 和 [@${id2}]`);
    await flush();
    expect(calls, '第二条不该被请求').toEqual([`/api/clipboard/${id1}`]);
    expect(out.value).toBe(`第一条正文 和 [@${id2}]`);
  });

  it('★ 同一条剪贴板被多处引用：只请求一次（模块级缓存 + 并发去重）', async () => {
    const id = freshClipId();
    const { calls } = stubFetch(() => clipResponse('共用正文'));

    // 两个组件同时挂载（模拟聊天列表里两条消息引用同一条剪贴板）
    const a = mountHook(`甲 [@${id}]`);
    const b = mountHook(`乙 [@${id}]`);
    await flush();

    expect(calls, '并发挂载只应发一次请求').toHaveLength(1);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();

    // 再挂第三个：命中缓存，依然不发请求
    mountHook(`丙 [@${id}]`);
    await flush();
    expect(calls, '命中缓存不该再发请求').toHaveLength(1);
  });

  it('★ 失败 → 显示失败文案，且**不缓存**（重新挂载会重试）', async () => {
    const id = freshClipId();
    let attempt = 0;
    const { calls } = stubFetch(() => {
      attempt += 1;
      // 第一次失败，第二次成功 —— 若实现把失败也缓存了，第二次会永远是失败文案
      return attempt === 1 ? 'NOT_OK' : clipResponse('重试成功');
    });

    const first = mountHook(`[@${id}]`);
    await flush();
    expect(out.value).toBe(`[剪贴板 ${id} 加载失败]`);
    first.unmount();

    mountHook(`[@${id}]`);
    await flush();
    expect(out.value, '失败不该进缓存，重挂应当重试').toBe('重试成功');
    expect(calls).toHaveLength(2);
  });

  it('★ 空正文的剪贴板是合法结果，不能当成「没取到」（引用被替换成空）', async () => {
    const id = freshClipId();
    stubFetch(() => clipResponse(''));
    mountHook(`前 [@${id}] 后`);
    await flush();
    expect(out.value).toBe('前  后');
  });

  it('★ 竞态：正文换成另一个引用后，不套用旧结果', async () => {
    const id1 = freshClipId();
    const id2 = freshClipId();
    stubFetch((url) => clipResponse(url.includes(id1) ? '甲的正文' : '乙的正文'));

    const h = mountHook(`[@${id1}]`);
    await flush();
    expect(out.value).toBe('甲的正文');

    // 换成另一个引用：在新结果到达前，应当是**字面量**而不是「甲的正文」
    h.update(`[@${id2}]`);
    expect(out.value).toBe(`[@${id2}]`);

    await flush();
    expect(out.value).toBe('乙的正文');
  });

  it('卸载后结果才回来 → 不报错、不写入已卸载的组件', async () => {
    const id = freshClipId();
    stubFetch(() => clipResponse('迟到的正文'));
    const h = mountHook(`[@${id}]`);
    h.unmount();
    await flush(); // 这一步若没做取消保护，React 会抛「更新已卸载组件」
    expect(true).toBe(true);
  });
});
