// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// md-editor-resource-panel.test.ts —— 「插入引用」面板的**竞态**（谁的结果落地）
//
// 【为什么单测】这一域的错误全都不报错、也没有任何日志，表现只是「列表里的东西
// 自己变了」或「刷新没生效」：
//   · 在「投票」加载中切回已经缓存好的「图床」—— 面板这一趟既不取数也不写 state
//     （缓存命中直接早退），可**别的那一条仍在飞**，落地时把图片列表覆盖成投票列表；
//   · 连点两次刷新：先发的那一条后到，把后发的**结果**连同**缓存**一起改回去；
//   · 先发的那一条失败，把后发那条刚写好的缓存**删掉**（下次切回来白重取一次）。
// 判据只能是「按可控顺序兑现响应之后，屏幕上与缓存里各是什么」—— 所以这里用手动
// 兑现的 fetch 桩，而不是响应顺序不可控的真接口。
//
// 【环境】与 blog-ref-render.test.ts 同款：不引 @testing-library（本仓库没有这个
// 依赖），用 react-dom/client 的 createRoot + React 19 的 act 直接驱动。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import ResourcePanel from '@/app/components/markdown-editor/ResourcePanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface PendingCall {
  url: string;
  fulfill(body: unknown): void;
  fail(): void;
}

/** 所有请求都**悬着**，由用例按想要的后到顺序逐条兑现。 */
function stubDeferredFetch(): PendingCall[] {
  const calls: PendingCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return new Promise((resolve, reject) => {
        calls.push({
          url,
          fulfill: (body) => resolve({ ok: true, status: 200, json: async () => body }),
          fail: () => reject(new Error('network')),
        });
      });
    })
  );
  return calls;
}

/** 图片列表的报文（只留解析用得到的字段）。 */
function imagePayload(...names: string[]): unknown {
  return {
    code: 200,
    images: names.map((filename, i) => ({
      id: `Img${String(i)}AbCdEf`,
      filename,
      created_at: '2026-10-07T21:04:05.000Z',
      is_public: true,
    })),
  };
}

function votePayload(...titles: string[]): unknown {
  return {
    code: 200,
    votes: titles.map((title, i) => ({
      id: `Vot${String(i)}AbCdEf`,
      title,
      created_at: '2026-10-07T21:04:05.000Z',
    })),
  };
}

/** 跑一轮宏任务，把 effect 与 promise 链推到底。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onInsert = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root.render(createElement(ResourcePanel, { onInsert, onClose }));
  });
  await settle();
  return { container, onInsert, onClose, root };
}

/** 当前列表条目的主标题（按屏幕顺序）。 */
function titles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.md-res-item__title')).map(
    (el) => el.textContent ?? ''
  );
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('要点的元素不在：选择器写错了，不是产品坏了');
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

const tab = (container: HTMLElement, key: string) =>
  container.querySelector(`#md-res-tab-${key}`);

function refreshBtn(container: HTMLElement): Element | null {
  return container.querySelector('.md-res-refresh');
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('缓存命中不许放走在飞的那条', () => {
  it('★ 「投票」加载中切回已缓存的「图床」，晚到的投票结果不许覆盖图片列表 ★', async () => {
    const calls = stubDeferredFetch();
    const { container } = await mount();

    // 首屏图床：兑现
    expect(calls.map((c) => c.url)).toEqual(['/api/images']);
    calls[0].fulfill(imagePayload('甲图.png'));
    await settle();
    expect(titles(container)).toEqual(['甲图.png']);

    // 切到投票 —— 请求发出去，**不兑现**（模拟还在飞）
    await click(tab(container, 'vote'));
    expect(calls.map((c) => c.url)).toEqual(['/api/images', '/api/votes']);
    expect(container.textContent).toContain('加载中');

    // 切回图床 —— 缓存命中，立刻见到图片，不发新请求
    await click(tab(container, 'image'));
    expect(calls).toHaveLength(2);
    expect(titles(container)).toEqual(['甲图.png']);

    // 现在那条投票请求才到（先发后到）
    calls[1].fulfill(votePayload('晚饭吃什么'));
    await settle();

    expect(titles(container), '图片列表被晚到的投票结果覆盖了').toEqual(['甲图.png']);
    // 也不能把投票那份塞进图床的缓存格：切回投票时应当**重新取数**，
    // 否则「图床」标签点开是投票列表。
    await click(tab(container, 'vote'));
    expect(calls.map((c) => c.url)).toEqual(['/api/images', '/api/votes', '/api/votes']);
  });
});

describe('连点刷新：先发的后到', () => {
  it('★ 晚到的旧结果不许覆盖新结果，也不许污染缓存 ★', async () => {
    const calls = stubDeferredFetch();
    const { container } = await mount();
    calls[0].fulfill(imagePayload('旧图.png'));
    await settle();
    expect(titles(container)).toEqual(['旧图.png']);

    // 连点两次刷新
    await click(refreshBtn(container));
    await click(refreshBtn(container));
    expect(calls).toHaveLength(3);

    // 后发的先到（新结果）
    calls[2].fulfill(imagePayload('新图.png'));
    await settle();
    expect(titles(container)).toEqual(['新图.png']);

    // 先发的后到（旧结果）—— 屏幕不能翻回去
    calls[1].fulfill(imagePayload('旧图.png'));
    await settle();
    expect(titles(container)).toEqual(['新图.png']);

    // ★ 真正的判据在缓存里 ★：切走再切回来走的是缓存命中这条路，
    // 缓存被旧结果污染的话，这里看到的就是「旧图.png」，而且不发任何请求。
    await click(tab(container, 'vote'));
    calls[calls.length - 1].fulfill(votePayload('晚饭吃什么'));
    await settle();
    await click(tab(container, 'image'));
    expect(titles(container), '缓存被晚到的旧结果覆盖了').toEqual(['新图.png']);
  });

  it('★ 晚到的失败不许删掉新结果那份缓存 ★', async () => {
    const calls = stubDeferredFetch();
    const { container } = await mount();
    calls[0].fulfill(imagePayload('旧图.png'));
    await settle();

    await click(refreshBtn(container));
    await click(refreshBtn(container));

    calls[2].fulfill(imagePayload('新图.png'));
    await settle();
    expect(titles(container)).toEqual(['新图.png']);

    // 先发的那一条现在才失败：它不该把「新图.png」这份缓存删掉
    calls[1].fail();
    await settle();

    // 切走再切回：走缓存命中（不发新请求），列表还是新的那一份。
    // 一轮往返只该多出**一条**请求（切到投票那次）；多出两条就是「切回图床时
    // 缓存已被删掉、只好重打接口」—— 而屏幕上看起来一切正常。
    const before = calls.length;
    await click(tab(container, 'vote'));
    calls[calls.length - 1].fulfill(votePayload('晚饭吃什么'));
    await settle();
    await click(tab(container, 'image'));
    expect(titles(container)).toEqual(['新图.png']);
    expect(calls.length, '缓存被删掉了 —— 切回来又打了一次接口').toBe(before + 1);
  });
});
