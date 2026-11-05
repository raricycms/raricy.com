// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// blog-content-dom.test.ts —— 正文挂载后的 DOM 后处理
//
// 钉住的是正文页真实需要的行为：外链加固（站外补 target/rel、javascript: 剥掉）、
// 复制按钮反馈、投票小组件可交互、重复调用不重复取数。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { enhanceBlogContent } from '@/lib/blog-content-dom';
import type { VoteEmbedData } from '@/lib/blog-markdown';

const VOTE_ID = 'AbCdEf123';

const VOTE_DATA: VoteEmbedData = {
  title: '晚饭吃什么',
  is_locked: false,
  total_votes: 3,
  user_voted: null,
  options: [
    { id: 1, label: '食堂', count: 2, percentage: 67 },
    { id: 2, label: '外卖', count: 1, percentage: 33 },
  ],
};

function stubVoteFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return { ok: true, status: 200, json: async () => ({ code: 200, data: VOTE_DATA }) };
    })
  );
  return calls;
}

/** 建一个挂载到 document 的容器（URL 解析、querySelectorAll 都要真 DOM 树）。 */
function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('外链加固', () => {
  it('站外链接补 target=_blank 与 rel；同站链接默认就地（正文页行为）', () => {
    const root = mount('<a href="https://example.com/x">外</a><a href="/blog/abc">内</a>');

    enhanceBlogContent(root);

    const [ext, internal] = Array.from(root.querySelectorAll('a'));
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(ext.getAttribute('rel')).toContain('noopener');
    expect(ext.getAttribute('rel')).toContain('nofollow');
    expect(internal.getAttribute('target')).toBeNull();
  });

  it('javascript: 与畸形 href 直接剥掉（不留可点的东西）', () => {
    const root = mount('<a href="javascript:alert(1)">x</a>');

    enhanceBlogContent(root);

    expect(root.querySelector('a')?.getAttribute('href')).toBeNull();
  });
});

describe('复制按钮', () => {
  it('点击后变「已复制」（无 clipboard API 也走完成回调）', () => {
    const root = mount(
      `<div class="highlight"><pre><code>x</code></pre><button class="copy-btn" data-code="${encodeURIComponent('x')}">复制</button></div>`
    );

    enhanceBlogContent(root);

    const btn = root.querySelector<HTMLButtonElement>('.copy-btn')!;
    btn.click();
    expect(btn.textContent).toBe('已复制');
  });
});

describe('投票嵌入', () => {
  it('选项可点，选中后提交按钮解锁', async () => {
    stubVoteFetch();
    const root = mount(`<div class="vote-embed" data-vote-id="${VOTE_ID}"></div>`);

    enhanceBlogContent(root);
    await flush();

    const option = root.querySelector<HTMLButtonElement>('.vote-embed-option')!;
    const submit = root.querySelector<HTMLButtonElement>('.vote-embed-submit')!;
    expect(option.disabled).toBe(false);
    expect(submit.disabled).toBe(true);

    option.click();
    expect(submit.disabled, '选中一项后提交应解锁').toBe(false);
  });

  it('★ id 里带 HTML 也不会被当成结构注入 ★', async () => {
    const calls = stubVoteFetch();
    const root = mount(
      `<div class="vote-embed" data-vote-id='x"><img src=x onerror="window.__pwn=1">'></div>`
    );

    enhanceBlogContent(root);
    await flush();

    expect(root.querySelector('img'), '注入的标签不能出现在正文里').toBeNull();
    expect(calls.every((u) => u.startsWith('/api/votes/'))).toBe(true);
  });

  it('重复调用安全：投票位用 data-rendered 去重，不重复拉数据', async () => {
    const calls = stubVoteFetch();
    const root = mount(`<div class="vote-embed" data-vote-id="${VOTE_ID}"></div>`);

    enhanceBlogContent(root);
    enhanceBlogContent(root);
    await flush();

    expect(calls).toHaveLength(1);
  });
});
