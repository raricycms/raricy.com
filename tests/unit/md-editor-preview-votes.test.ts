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
    // 与 MarkdownEditor 的 previewVoteData 同一段逻辑：复用探测那一条报文
    const voteData = (id: string) => {
      const hit = resolver.peek('vote', id);
      return hit ? (hit.data ?? null) : undefined;
    };

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
            voteData,
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

  it('缓存里没有这一格时静默降级：自己拉一条，仍然渲染得出', async () => {
    const calls = stubVoteFetch(() => 3);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(MarkdownRenderer, {
          content: `投票：[@${VOTE_ID}]`,
          contentRefs: 'expand',
          interactive: false,
          // 缓存是空的（peek 恒 undefined = 「没给数据，你自己去拉」）
          voteData: () => undefined,
        })
      );
    });
    await settle();

    // 两条：一条是引用的存在性探测（走 resolver），一条是组件自己补的 —— 这正是
    // 缓存没命中时要付的代价，别让「降级」变成「什么都不显示」。
    expect(calls).toEqual([`/api/votes/${VOTE_ID}`, `/api/votes/${VOTE_ID}`]);
    expect(container.querySelector('.vote-embed-widget')?.textContent).toContain('共 3 票');
  });
});
