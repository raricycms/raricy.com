// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// site-embed.test.tsx — 宿主组件渲染器的三条契约
//
// 这些错误都**不会在界面上报错**，所以必须钉住：
//   · 三态：ready / error / forbidden 各有可见说明，不能白屏；
//   · static / 预览不发请求：编辑器预览与无 JS 快照都走同一条渲染器；
//   · kind/ref 与 hostData 不一致时落占位，而不是「按数据里的 href 建链接」——
//     伪造一份 hostData 就是一次 `javascript:` 注入。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LocalNode, LocalRuntime } from 'reactive-md';
import type { LocalRenderContext } from 'reactive-md/react';
import { SiteEmbedView } from '@/app/components/reactive/SiteEmbedView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AUDIO_ID = 'Ab12Cd34Ef';
const VOTE_ID = 'Ab12Cd34E';
const CLIP_ID = 'Ab12Cd34';

interface Mounted {
  root: Root;
  container: HTMLElement;
}

const mounted: Mounted[] = [];

function ctx(mode: 'interactive' | 'static' = 'interactive'): LocalRenderContext {
  return { runtime: {} as LocalRuntime, render: () => null, visible: true, mode };
}

function node(kind: string, ref: string): LocalNode {
  return {
    type: 'hostComponent',
    id: 'host-1',
    name: 'site-embed',
    attrs: { kind, ref },
    range: { start: 0, end: 0 },
  };
}

function embed(kind: string, ref: string, status: string, extra: Record<string, unknown> = {}) {
  return { kind, ref, status, ...extra };
}

function Wrapper(props: {
  node: LocalNode;
  data: unknown;
  context: LocalRenderContext;
  options?: { preview?: boolean };
}) {
  return <>{SiteEmbedView(props.node, props.data, props.context, props.options)}</>;
}

function mount(
  embedNode: LocalNode,
  data: unknown,
  context: LocalRenderContext = ctx('interactive'),
  options?: { preview?: boolean }
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      createElement(Wrapper, { node: embedNode, data, context, options })
    );
  });
  return container;
}

const VOTE = {
  title: '测试投票',
  is_locked: false,
  total_votes: 0,
  user_voted: null as number | null,
  options: [
    { id: 1, label: '甲', count: 0, percentage: 0 },
    { id: 2, label: '乙', count: 0, percentage: 0 },
  ],
};

afterEach(() => {
  act(() => {
    for (const item of mounted) item.root.unmount();
  });
  for (const item of mounted) item.container.remove();
  mounted.length = 0;
  vi.unstubAllGlobals();
});

describe('三态', () => {
  it('ready：音频按受控路径渲染播放器', () => {
    const box = mount(
      node('audio', AUDIO_ID),
      embed('audio', AUDIO_ID, 'ready')
    );
    const audio = box.querySelector('audio.site-embed.site-embed--audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe(`/api/audio/${AUDIO_ID}/raw`);
    expect(box.querySelector('.site-embed__status')).toBeNull();
  });

  it('error：渲染可见说明，不渲染半个组件', () => {
    const box = mount(node('audio', AUDIO_ID), embed('audio', AUDIO_ID, 'error'));
    expect(box.querySelector('.site-embed__status--error')?.textContent).toBe('内容加载失败');
    expect(box.querySelector('audio')).toBeNull();
  });

  it('forbidden：渲染权限说明，不带链接', () => {
    const box = mount(
      node('vote', VOTE_ID),
      embed('vote', VOTE_ID, 'forbidden')
    );
    expect(box.querySelector('.site-embed__status--forbidden')?.textContent).toBe(
      '无权查看此内容'
    );
    expect(box.querySelector('a')).toBeNull();
  });
});

describe('static / 预览不发请求', () => {
  it('static 投票：控件禁用，一个 fetch 都不发', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const box = mount(
      node('vote', VOTE_ID),
      embed('vote', VOTE_ID, 'ready', { payload: VOTE }),
      ctx('static')
    );

    const option = box.querySelector<HTMLButtonElement>('.vote-embed-option');
    const submit = box.querySelector<HTMLButtonElement>('.vote-embed-submit');
    expect(option?.disabled).toBe(true);
    expect(submit?.disabled).toBe(true);

    option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('interactive + preview：同样只读，不发写请求', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const box = mount(
      node('vote', VOTE_ID),
      embed('vote', VOTE_ID, 'ready', { payload: VOTE }),
      ctx('interactive'),
      { preview: true }
    );

    expect(box.querySelector<HTMLButtonElement>('.vote-embed-submit')?.disabled).toBe(true);
    box
      .querySelector<HTMLButtonElement>('.vote-embed-option')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('投票交互沿用现有接口', () => {
  it('POST 形状与旧管线一致，成功后重新拉取结果', async () => {
    const voted = {
      ...VOTE,
      total_votes: 1,
      user_voted: 1,
      options: [
        { id: 1, label: '甲', count: 1, percentage: 100 },
        { id: 2, label: '乙', count: 0, percentage: 0 },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ code: 200, message: '投票成功' }) })
      .mockResolvedValueOnce({ json: async () => ({ code: 200, data: voted }) });
    vi.stubGlobal('fetch', fetchMock);

    const box = mount(
      node('vote', VOTE_ID),
      embed('vote', VOTE_ID, 'ready', { payload: VOTE }),
      ctx('interactive')
    );

    const option = box.querySelector<HTMLButtonElement>('.vote-embed-option')!;
    await act(async () => {
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const submit = box.querySelector<HTMLButtonElement>('.vote-embed-submit')!;
    expect(submit.disabled).toBe(false);

    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/votes/${VOTE_ID}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ optionId: 1 }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/votes/${VOTE_ID}`, {
      credentials: 'same-origin',
    });
    expect(box.querySelector('.vote-embed-total')?.textContent).toBe('共 1 票');
    expect(box.querySelector('.vote-embed-submit')).toBeNull();
  });
});

describe('校验与伪造', () => {
  it('kind/ref 与 hostData 不一致 → 错误占位', () => {
    const box = mount(
      node('audio', AUDIO_ID),
      embed('vote', AUDIO_ID, 'ready', { payload: VOTE })
    );
    expect(box.querySelector('.site-embed__status--error')).not.toBeNull();
    expect(box.querySelector('audio')).toBeNull();
    expect(box.querySelector('.vote-embed-widget')).toBeNull();
  });

  it('非法 ref（含协议字符）不产生任何链接', () => {
    const box = mount(
      node('clipboard', 'javascript:alert(1)'),
      embed('clipboard', 'javascript:alert(1)', 'ready', { title: 'x' })
    );
    expect(box.querySelector('.site-embed__status--error')).not.toBeNull();
    expect(box.querySelector('a')).toBeNull();
  });

  it('剪贴板忽略 payload 里的 href，只按 ref 拼站内地址，且不渲染 content', () => {
    const box = mount(
      node('clipboard', CLIP_ID),
      embed('clipboard', CLIP_ID, 'ready', {
        title: '一段剪贴板',
        format: 'markdown',
        content: '正文不该出现',
        payload: { href: 'javascript:alert(1)', title: '伪造标题' },
      })
    );
    const link = box.querySelector('a.site-embed-clipboard');
    expect(link?.getAttribute('href')).toBe(`/clipboard/${CLIP_ID}`);
    expect(box.textContent).not.toContain('正文不该出现');
  });

  it('收藏夹条目里的 javascript: id 只作为文本，不成链接', () => {
    const box = mount(
      node('favorite', '123456'),
      embed('favorite', '123456', 'ready', {
        payload: {
          title: '收藏夹',
          count: 1,
          items: [{ blogId: 'javascript:alert(1)', title: '危险条目' }],
        },
      })
    );
    expect(box.querySelectorAll('a')).toHaveLength(0);
    expect(box.textContent).toContain('危险条目');
  });
});
