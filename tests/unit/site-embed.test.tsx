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
import { compileLocal, type LocalNode, type LocalRuntime } from 'reactive-md';
import type { LocalRenderContext } from 'reactive-md/react';
import { SiteEmbedView } from '@/app/components/reactive/SiteEmbedView';
import { reactiveCompileOptions } from '@/lib/reactive/host-components';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AUDIO_ID = 'Ab12Cd34Ef';
const VOTE_ID = 'Ab12Cd34E';
const CLIP_ID = 'Ab12Cd34';
const MEDIA_REF = 'abcdef1234';

/** 内联剪贴板的新契约：hostData 只带同版本编译产物，不再带原始 content。 */
function inlineClipboardDocument() {
  const compiled = compileLocal('可内联的正文', reactiveCompileOptions('markdown'));
  if (!compiled.ok) throw new Error('fixture compile failed');
  return { document: compiled.document, hostData: {} };
}

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

describe('历史 HTML 音视频（media kind）', () => {
  const mediaPayload = (payload: Record<string, unknown>) => ({
    kind: 'media',
    ref: MEDIA_REF,
    status: 'ready',
    payload,
  });

  it('video：保留 controls / 图文属性，默认 preload=none，绝不 autoplay', () => {
    const box = mount(
      node('media', MEDIA_REF),
      mediaPayload({
        media: 'video',
        src: 'https://cdn.example/video.mp4',
        poster: 'https://cdn.example/poster.jpg',
        preload: 'metadata',
        loop: true,
        muted: true,
        playsInline: true,
        width: 640,
        height: 360,
        autoplay: true,
      }),
      ctx('static')
    );
    const video = box.querySelector<HTMLVideoElement>(
      'video.site-embed.site-embed--media.site-embed--video'
    );
    expect(video).not.toBeNull();
    expect(video?.controls).toBe(true);
    expect(video?.getAttribute('preload')).toBe('metadata');
    expect(video?.getAttribute('src')).toBe('https://cdn.example/video.mp4');
    expect(video?.getAttribute('poster')).toBe('https://cdn.example/poster.jpg');
    expect(video?.loop).toBe(true);
    expect(video?.muted).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.width).toBe(640);
    expect(video?.height).toBe(360);
    expect(video?.autoplay).toBe(false);
    expect(video?.hasAttribute('autoplay')).toBe(false);
  });

  it('缺省 preload 是 none；非法值也退回 none；非法的 poster / src 被丢弃', () => {
    const box = mount(
      node('media', MEDIA_REF),
      mediaPayload({
        media: 'video',
        src: 'https://cdn.example/video.mp4',
        poster: 'javascript:alert(1)',
        preload: 'loud',
      }),
      ctx('static')
    );
    const video = box.querySelector<HTMLVideoElement>('video');
    expect(video?.getAttribute('preload')).toBe('none');
    expect(video?.getAttribute('poster')).toBeNull();
  });

  it('audio：无直接 src 时保留 <source> 子结构，不消失', () => {
    const box = mount(
      node('media', MEDIA_REF),
      mediaPayload({
        media: 'audio',
        sources: [
          { src: '/api/audio/Ab12Cd34Ef/raw', type: 'audio/mp4' },
          { src: 'javascript:alert(1)', type: 'audio/ogg' },
        ],
        tracks: [
          {
            src: 'https://cdn.example/zh.vtt',
            kind: 'subtitles',
            srclang: 'zh',
            label: '中文',
            default: true,
          },
        ],
      }),
      ctx('static')
    );
    const audio = box.querySelector<HTMLAudioElement>(
      'audio.site-embed.site-embed--media.site-embed--audio'
    );
    expect(audio).not.toBeNull();
    expect(audio?.controls).toBe(true);
    expect(audio?.getAttribute('preload')).toBe('none');
    expect(audio?.getAttribute('src')).toBeNull();
    expect(audio?.querySelectorAll('source')).toHaveLength(1);
    expect(audio?.querySelector('source')?.getAttribute('src')).toBe(
      '/api/audio/Ab12Cd34Ef/raw'
    );
    expect(audio?.querySelector('source')?.getAttribute('type')).toBe('audio/mp4');
    const track = audio?.querySelector('track');
    expect(track?.getAttribute('src')).toBe('https://cdn.example/zh.vtt');
    expect(track?.getAttribute('kind')).toBe('subtitles');
    expect(track?.getAttribute('srclang')).toBe('zh');
    expect(track?.getAttribute('label')).toBe('中文');
    expect((track as HTMLTrackElement | null)?.default).toBe(true);
  });

  it('没有任何可用媒体源 → 错误占位，不渲染半个控件', () => {
    const box = mount(
      node('media', MEDIA_REF),
      mediaPayload({
        media: 'video',
        src: 'javascript:alert(1)',
        sources: [{ src: 'data:video/mp4;base64,AAAA' }],
      }),
      ctx('static')
    );
    expect(box.querySelector('video')).toBeNull();
    expect(box.querySelector('audio')).toBeNull();
    expect(box.querySelector('.site-embed__status--error')?.textContent).toBe('内容加载失败');
  });

  it('静态 / 预览渲染不发任何请求', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mount(
      node('media', MEDIA_REF),
      mediaPayload({ media: 'video', src: 'https://cdn.example/video.mp4' }),
      ctx('static')
    );
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

  it('静态快照的剪贴板忽略 payload href，只按 ref 拼站内地址，且不内联 content', () => {
    const box = mount(
      node('clipboard', CLIP_ID),
      embed('clipboard', CLIP_ID, 'ready', {
        title: '一段剪贴板',
        format: 'markdown',
        content: '正文不该出现',
        payload: { href: 'javascript:alert(1)', title: '伪造标题' },
      }),
      ctx('static')
    );
    const link = box.querySelector('a.site-embed-clipboard');
    expect(link?.getAttribute('href')).toBe(`/clipboard/${CLIP_ID}`);
    expect(box.querySelector('.site-embed-clipboard-inline')).toBeNull();
  });

  it('成员阅读的 Markdown 剪贴板走一层静态子文档外壳（不渲染成链接卡片）', () => {
    const box = mount(
      node('clipboard', CLIP_ID),
      embed('clipboard', CLIP_ID, 'ready', {
        title: '一段剪贴板',
        format: 'markdown',
        payload: { href: 'javascript:alert(1)', title: '伪造标题' },
        ...inlineClipboardDocument(),
      })
    );
    expect(box.querySelector('.site-embed-clipboard-inline')).not.toBeNull();
    expect(box.querySelector('a.site-embed-clipboard')).toBeNull();
    expect(box.textContent).toContain('可内联的正文');
  });

  it('只有 content 没有编译产物时退回链接卡片（不把原始正文交给旧引擎）', () => {
    const box = mount(
      node('clipboard', CLIP_ID),
      embed('clipboard', CLIP_ID, 'ready', {
        title: '一段剪贴板',
        format: 'markdown',
        content: '不该内联的正文',
      })
    );
    expect(box.querySelector('.site-embed-clipboard-inline')).toBeNull();
    expect(box.querySelector(`a.site-embed-clipboard[href="/clipboard/${CLIP_ID}"]`)).not.toBeNull();
    expect(box.textContent).not.toContain('不该内联的正文');
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
