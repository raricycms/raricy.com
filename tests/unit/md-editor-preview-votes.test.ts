// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// md-editor-preview-votes.test.ts —— 只读预览里的投票位：一条数据，别拉第二遍
//
// 【为什么单测】预览是**防抖重渲染**的：每停一下手就把整块 DOM 换一次，而
// renderVoteEmbed 每换一次就自己去拉一遍 `GET /api/votes/<id>`。后果有三层，
// 全都不报错：
//   · 每停一下就多发一轮请求（还会撞上站内限频）；
//   · 投票位每次都先显示「加载投票…」再跳成结果 —— 一闪一闪；
//   · 「刷新引用」刷新不动的假象：旧数据被新一次的请求掩盖了来龙去脉。
// 判据只能是**数请求条数**（外加「刷新之后真的换了新数据」），
// 因为「结果看起来是对的」在缓存失效时同样成立。
//
// 还有一条只有把时序摆出来才看得见的：**取数响应落地之前缓存被作废**。那时再回头
// 问缓存就什么也问不到，正文里的引用会静默退成字面量。数据必须与正文来自**同一轮**
// 快照（ContentRefProcessor.preprocessRound 交出来的 entries）。
//
// 【环境】与 blog-ref-render.test.ts 同款：createRoot + React 19 的 act。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownRenderer from '@/app/components/MarkdownRenderer';
import { ContentRefResolver } from '@/lib/content-ref-resolver';
import type { VoteEmbedData } from '@/lib/blog-markdown';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VOTE_ID = 'AbCdEf123'; // 9 位 = 投票

function votePayload(total: number): unknown {
  const data: VoteEmbedData = {
    title: '晚饭吃什么',
    is_locked: false,
    total_votes: total,
    // 已投过 → 走「结果行」那一支，屏幕上才有一句「共 N 票」可断言
    user_voted: 1,
    options: [
      { id: 1, label: '面', count: total, percentage: 100 },
      { id: 2, label: '饭', count: 0, percentage: 0 },
    ],
  };
  return { code: 200, data };
}

/** fetch 桩：只认投票那条（标出**每一次**调用，重复拉一眼就能看出来）。 */
function stubVoteFetch(total: () => number): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return { ok: true, status: 200, json: async () => votePayload(total()) };
    })
  );
  return calls;
}

/**
 * 同上的桩，但**每一条响应都由用例手动兑现** —— 用来把竞态卡在指定的位置
 * （「响应还没落地时缓存被作废」这种时序，快接口上是复现不出来的）。
 */
function stubDeferredVoteFetch(): { calls: string[]; fulfill: () => void } {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Promise((resolve) => {
        pending.push(() =>
          resolve({ ok: true, status: 200, json: async () => votePayload(7) } as Response)
        );
      });
    })
  );
  return {
    calls,
    fulfill: () => {
      const next = pending.shift();
      next?.();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('预览里的投票位', () => {
  it('★ 重渲染不再重复拉接口，刷新之后才重取，并且换上新数据 ★', async () => {
    let total = 7;
    const calls = stubVoteFetch(() => total);

    const resolver = new ContentRefResolver('expand');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const render = (content: string, refreshToken: number) =>
      act(async () => {
        root.render(
          createElement(MarkdownRenderer, {
            content,
            contentRefs: 'expand',
            interactive: false,
            resolver,
            refreshToken,
          })
        );
      });

    await render(`投票：[@${VOTE_ID}]`, 0);
    await settle();

    expect(calls, '一次渲染只该有一条投票请求（存在性探测那条）').toEqual([
      `/api/votes/${VOTE_ID}`,
    ]);
    const widget = () => container.querySelector('.vote-embed-widget');
    expect(widget()?.textContent).toContain('晚饭吃什么');
    expect(widget()?.textContent).toContain('共 7 票');
    // 「加载投票…」只该属于真的要等的那些路径；这里是现成数据，写它就是在闪
    expect(container.textContent).not.toContain('加载投票');

    // 停手 → 防抖重渲染：正文变了，引用没变。**不该多打一条请求**。
    await render(`投票：[@${VOTE_ID}] `, 0);
    await settle();
    expect(calls, '防抖重渲染又拉了一遍投票').toEqual([`/api/votes/${VOTE_ID}`]);
    expect(container.textContent).not.toContain('加载投票');

    // 「刷新引用」：作废缓存 → 重取 → 换上新数据
    total = 9;
    await render(`投票：[@${VOTE_ID}] `, 1);
    await settle();
    expect(calls).toEqual([`/api/votes/${VOTE_ID}`, `/api/votes/${VOTE_ID}`]);
    expect(widget()?.textContent, '刷新之后投票位没换成新数据').toContain('共 9 票');
  });

  it('★ 响应落地前缓存被作废：这一轮仍然用它自己取到的那份，不退成字面量、不补第二条 ★', async () => {
    // 【这条盯的是什么】处理器是两段式的：先 `await` 所有 resolve，再拿结果去替换。
    // 如果第二段回头去问 resolver 的缓存，中间只要有人 `invalidate()`（用户点了
    // 「刷新引用」、另一次预览渲染起来了），缓存就是空的 —— 正文里的引用**静默退成
    // 字面量** `[@AbCdEf123]`，投票位连画都不画；而取数越慢越容易撞上。
    // 修法是让第一段 `await` 的返回值成为这一轮的唯一真值（preprocessRound），
    // 投票小组件的数据也从同一份快照里取（不是更新的一代、也不是第二条请求）。
    const stub = stubDeferredVoteFetch();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const resolver = new ContentRefResolver('expand');
    await act(async () => {
      root.render(
        createElement(MarkdownRenderer, {
          content: `投票：[@${VOTE_ID}]`,
          contentRefs: 'expand',
          interactive: false,
          resolver,
        })
      );
    });

    // 请求已经发出去、还悬着
    expect(stub.calls).toEqual([`/api/votes/${VOTE_ID}`]);
    // ★ 就在这一刻把缓存整代作废（等价于用户点了一下「刷新引用」）
    resolver.invalidate();
    stub.fulfill();
    await settle();

    // ① 不退成字面量：正文里那枚 token 被换成了真的投票位
    expect(container.textContent, '引用退成了字面量').not.toContain(`[@${VOTE_ID}]`);
    expect(container.querySelector('.vote-embed-widget')?.textContent).toContain('共 7 票');
    // ② 也不补第二条请求 —— 数据来自这一轮自己取到的那一份
    expect(stub.calls, '作废之后小组件又自己去拉了一条').toEqual([`/api/votes/${VOTE_ID}`]);
  });
});
