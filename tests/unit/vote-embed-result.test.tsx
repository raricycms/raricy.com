// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// vote-embed-result.test.tsx —— 投票详情组件：票数以**服务端结果**为准（R3-123）
//
// 【为什么单测】详情页的 VoteEmbed 旧实现是「提交成功后本地 +1 再 router.refresh()」：
// 本地累加会在并发投票/重放时与服务端漂开，而 router.refresh 只重组服务端组件，
// 这个 *客户端* 组件的 options/total 状态不会重新初始化 —— 页面上的票数就停在
// 「旧值 + 1」。正文里的嵌入投票（SiteEmbedView.InteractiveVote）已经改成提交后重新
// GET /api/votes/:id 取服务端结果，这里对齐同一口径。
//
// 同时钉住「已提交成功」与「结果加载失败」的区分：GET 失败时仍进入结果视图并提示失败，
// 不能把一次**已成功**的投票说成投票失败，也不能吞掉错误。
//
// 环境：jsdom + react-dom/client + React 19 act（仓库没有 @testing-library）。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

// VoteEmbed 在提交成功后调用 router.refresh()；单测里没有 App Router 上下文，
// 换成一个哑实现（与仓库其它组件用例同款）。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import VoteEmbed from '@/app/components/VoteEmbed';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { id: 1, label: '选项甲', count: 1, percentage: 50 },
  { id: 2, label: '选项乙', count: 1, percentage: 50 },
];

type Root = ReturnType<typeof createRoot>;
let roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    roots.forEach((root) => root.unmount());
  });
  roots = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** 依次兑现的 fetch 桩：按调用顺序返回给定响应（可抛错）。 */
function stubFetch(responses: Array<() => Promise<unknown>>): string[] {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      const next = responses[i];
      i += 1;
      return next ? next() : Promise.reject(new Error('unexpected fetch'));
    })
  );
  return urls;
}

const jsonResponse = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(VoteEmbed, {
        voteId: 'abc123',
        isLocked: false,
        initialUserVoted: null,
        initialTotal: 2,
        initialOptions: OPTIONS,
      })
    );
  });
  await settle();
  return container;
}

/** 选中第一个选项并提交。 */
async function voteFirst(container: HTMLElement): Promise<void> {
  const options = container.querySelectorAll('.vote-embed-option');
  await act(async () => {
    (options[0] as HTMLElement).click();
  });
  await settle();
  const submit = container.querySelector('.vote-embed-submit') as HTMLElement;
  await act(async () => {
    submit.click();
  });
  await settle();
}

describe('VoteEmbed —— 投票后以服务端结果更新（R3-123）', () => {
  it('★ 提交成功后重新拉取服务端结果：票数/百分比来自 GET，不是本地 +1', async () => {
    const urls = stubFetch([
      () => jsonResponse({ code: 200, message: '投票成功' }),
      () =>
        jsonResponse({
          code: 200,
          data: {
            options: [
              { id: 1, label: '选项甲', count: 9, percentage: 90 },
              { id: 2, label: '选项乙', count: 1, percentage: 10 },
            ],
            total_votes: 10,
            user_voted: 1,
          },
        }),
    ]);
    const container = await mount();

    await voteFirst(container);

    expect(urls).toEqual(['POST /api/votes/abc123/vote', 'GET /api/votes/abc123']);
    expect(container.textContent, '总数以服务端为准').toContain('共 10 票');
    expect(container.textContent, '旧实现会显示本地累加的 3 票').not.toContain('共 3 票');
    expect(container.textContent).toContain('9 票 · 90%');
    expect(
      container.querySelector('.vote-embed-option--voted'),
      '已投项高亮应该按服务端的 user_voted'
    ).not.toBeNull();
    expect(container.querySelector('.vote-embed-submit'), '结果视图不再显示提交按钮').toBeNull();
    expect(container.textContent).not.toContain('结果加载失败');
  });

  it('★ 已提交但结果拉取失败：进入结果视图 + 明确提示失败（不吞错、不说成投票失败）', async () => {
    stubFetch([
      () => jsonResponse({ code: 200, message: '投票成功' }),
      () => jsonResponse({ code: 500, message: '服务器开小差了' }),
    ]);
    const container = await mount();

    await voteFirst(container);

    expect(container.textContent, '不能把已提交的成功说成投票失败').not.toContain('投票失败');
    expect(container.textContent, '必须明确区分「已提交」与「结果加载失败」').toContain(
      '投票已提交，但结果加载失败'
    );
    // 仍进入结果视图（已投项可见），提交按钮消失
    expect(container.querySelector('.vote-embed-submit')).toBeNull();
    expect(container.querySelector('.vote-embed-option--result')).not.toBeNull();
  });
});
