// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// blog-ref-render.test.ts —— 博客正文两种视图下「`[@…]` 展开到哪一档」
//
// 【为什么值得单测】这一域的错误**全是静默的**：正文里静静躺着一个播放器语法 /
// 一个图片语法 / 一个投票语法，页面不报错、控制台不报错、构建也不报错。已经发生过
// 一次（下面的第一条用例就是它的复现）：
//
//   · `[@音频/<ID>]` 是**中文合集名**，而按 id 长度分流那条正则用的是 `\w` ——
//     正文里没有别的 `[@…]` 引用时，`ContentRefProcessor.preprocess` 开头的空集
//     早退会把音频那一趟一起吞掉。「只贴了一段录音的文章」= 什么都不展开。
//   · 对外视图曾经整个走 'plain'（一次预处理都不做），于是**访客看不到正文里的
//     图片和录音** —— 而《音频床使用指南》的 FAQ 与 robots.ts 的注释都写着能听到。
//
// 【为什么不放 e2e】e2e 要真 build 才跑得起来，而这里要钉的是「客户端管线在不
// 同模式下各展开什么」，用真组件 + 真 marked + 真 DOMPurify 就够了。e2e 那边
// （tests/e2e/blog-visibility.spec.ts）另钉「访客在真浏览器里读到的正文」。
//
// 【环境】与 avatar-component.test.ts 同款：不引 @testing-library（本仓库没有
// 这个依赖），用 react-dom/client 的 createRoot + React 19 的 act 直接驱动。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import MarkdownRenderer from '@/app/components/MarkdownRenderer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AUDIO_ID = 'AaBbCcDd10';
const IMAGE_ID = 'AaBbCcDd10'; // 与音频同长（都是 10 位 base62），分流按长度看的是**前缀**
const CLIP_ID = 'AbCd1234';
const VOTE_ID = 'AbCdEf123';
const FAV_ID = '123456';
const AUDIO_TOKEN = `[@音频/${AUDIO_ID}]`;

interface RenderOpts {
  contentRefs: 'expand' | 'external';
  externalClips?: Record<string, string>;
}

/** 渲染一次，等 effect 里的异步渲染（含 fetch 桩）落地，返回正文容器。 */
async function render(content: string, opts: RenderOpts): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(MarkdownRenderer, {
        content,
        contentRefs: opts.contentRefs,
        externalClips: opts.externalClips,
      })
    );
  });
  // 预处理是 async 的（'expand' 下还带 fetch 桩），多轮几次把 promise 链跑完
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return container;
}

/** 正文 HTML（#userContentContainer 里那份，已经过 marked + DOMPurify）。 */
async function bodyHtml(content: string, opts: RenderOpts): Promise<string> {
  const box = await render(content, opts);
  return box.querySelector('#userContentContainer')?.innerHTML ?? '';
}

/** fetch 桩：记下所有请求 URL。'expand' 之外的模式**一个请求都不该发**。 */
function stubFetch(impl: (url: string) => unknown = () => ({})): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const body = await impl(url);
      if (body === 'NOT_OK') return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══ 一、音频：与「正文里还有没有别的引用」无关 ═══════════════════════════════

describe('音频引用（两种模式都展开）', () => {
  it('★ 正文里**只有**音频引用时也展开（空集早退吞掉播放器的那条回归）★', async () => {
    stubFetch();
    const html = await bodyHtml(`听这段 ${AUDIO_TOKEN}`, { contentRefs: 'expand' });

    expect(html).toContain(`<audio`);
    expect(html).toContain(`src="/api/audio/${AUDIO_ID}/raw"`);
    expect(html).not.toContain('[@音频/');
  });

  it('正文里还有别的引用时照常展开（没被那条早退牵着走）', async () => {
    stubFetch((url) => (url.includes('/api/clipboard/') ? { clip: { content: '剪贴板正文' } } : {}));
    const html = await bodyHtml(`听 ${AUDIO_TOKEN} 和 [@${CLIP_ID}]`, { contentRefs: 'expand' });

    expect(html).toContain('<audio');
    expect(html).toContain('剪贴板正文');
  });

  it('对外视图也展开（访客读公开文章时该听到）', async () => {
    const calls = stubFetch();
    const html = await bodyHtml(`听这段 ${AUDIO_TOKEN}`, { contentRefs: 'external' });

    expect(html).toContain(`src="/api/audio/${AUDIO_ID}/raw"`);
    expect(calls, '对外视图一个请求都不发').toEqual([]);
  });

  it('代码块里的语法仍然不展开（对外视图同样盖码）', async () => {
    const html = await bodyHtml(['```', AUDIO_TOKEN, '```'].join('\n'), {
      contentRefs: 'external',
    });

    expect(html).not.toContain('<audio');
    expect(html).toContain(AUDIO_TOKEN);
  });
});

// ═══ 一·B、代码块：一律不展开（含不请求、不改写）═════════════════════════════
//
// 《内容引用语法指南》对读者的承诺是「代码里的引用一律不展开，四处都一样」——
// 想展示语法本身时就把它写进代码块。这件事做错**不报错**，只是悄悄把用户写下的
// 代码改掉：围栏里的 `[@10位]` 曾被改写成 `![id](…/raw)`，连复制按钮复制走的
// 都是改过的那份。

describe('代码块 / 行内代码里的引用', () => {
  const cases: [string, string][] = [
    ['剪贴板', `[@${CLIP_ID}]`],
    ['投票', `[@${VOTE_ID}]`],
    ['图床', `[@${IMAGE_ID}]`],
    ['收藏夹', `[@${FAV_ID}]`],
  ];

  it.each(cases)('★ 围栏里的%s引用：保留字面量，且不发请求 ★', async (_name, token) => {
    const calls = stubFetch(() => ({ clip: { content: '不该被内联' } }));
    const html = await bodyHtml(['```', token, '```'].join('\n'), { contentRefs: 'expand' });

    expect(html).toContain(token);
    expect(html).not.toContain('不该被内联');
    expect(calls, '代码块里的 token 连请求都不该发').toEqual([]);
  });

  it('行内代码里的引用同样不展开', async () => {
    const calls = stubFetch(() => ({ clip: { content: '不该被内联' } }));
    const html = await bodyHtml(`写法是 \`[@${CLIP_ID}]\``, { contentRefs: 'expand' });

    expect(html).toContain(`[@${CLIP_ID}]`);
    expect(calls).toEqual([]);
  });

  it('★ 同一个 token 既在围栏里又在正文里：只展开正文那处 ★', async () => {
    stubFetch(() => ({ clip: { content: '剪贴板正文' } }));
    const html = await bodyHtml(
      ['```', `[@${CLIP_ID}]`, '```', '', `正文里的 [@${CLIP_ID}]`].join('\n'),
      { contentRefs: 'expand' }
    );

    // 展开的是正文那处（切片按位置，不会被「内容相同」骗到围栏里那处去）
    expect(html).toContain('剪贴板正文');
    // 围栏里那处仍是字面量 —— 数一下：token 还剩一次
    expect(html.match(/\[@AbCd1234\]/g) ?? []).toHaveLength(1);
  });

  it('对外视图的围栏引用也不展开（服务端也不会把它放进 externalClips）', async () => {
    const html = await bodyHtml(['```', `[@${CLIP_ID}]`, '```'].join('\n'), {
      contentRefs: 'external',
      externalClips: { [CLIP_ID]: '服务端本不该给这一条' },
    });

    expect(html).toContain(`[@${CLIP_ID}]`);
    expect(html).not.toContain('服务端本不该给这一条');
  });
});

// ═══ 二、图床：拼 URL，不请求 ════════════════════════════════════════════════

describe('图床引用', () => {
  it('对外视图展开成 <img>（访客读得到公开文章里的图）', async () => {
    const calls = stubFetch();
    const html = await bodyHtml(`图：[@${IMAGE_ID}]`, { contentRefs: 'external' });

    expect(html).toContain(`<img`);
    expect(html).toContain(`src="/api/images/${IMAGE_ID}/raw"`);
    expect(calls, '拼 URL 不该产生请求').toEqual([]);
  });
});

// ═══ 三、剪贴板：对外视图只出服务端判过的公开档 ═══════════════════════════════

describe('剪贴板引用', () => {
  it('在 externalClips 里 → 正文内联', async () => {
    const html = await bodyHtml(`见 [@${CLIP_ID}]`, {
      contentRefs: 'external',
      externalClips: { [CLIP_ID]: '这是一段公开的剪贴板正文' },
    });

    expect(html).toContain('这是一段公开的剪贴板正文');
    expect(html).not.toContain(`[@${CLIP_ID}]`);
  });

  it('★ 不在表里（私有 / 已软删 / 不存在）→ 保留字面量，不提示、不区分 ★', async () => {
    const calls = stubFetch();
    const html = await bodyHtml(`见 [@${CLIP_ID}]`, { contentRefs: 'external', externalClips: {} });

    expect(html).toContain(`[@${CLIP_ID}]`);
    expect(calls, '拿不到就保留字面量，绝不回退成请求 core+ 接口').toEqual([]);
  });

  it('成员视图照旧自己带凭据拉（私有剪贴板在那边也能展开）', async () => {
    const calls = stubFetch(() => ({ clip: { content: '成员视图拿到的正文' } }));
    const html = await bodyHtml(`见 [@${CLIP_ID}]`, { contentRefs: 'expand' });

    expect(html).toContain('成员视图拿到的正文');
    expect(calls).toEqual([`/api/clipboard/${CLIP_ID}`]);
  });
});

// ═══ 四、投票与收藏夹：对外视图一律不展开 ════════════════════════════════════

describe('投票 / 收藏夹（对外视图的字面量）', () => {
  it('★ 对外视图的投票引用保留字面量，且**不发请求** ★', async () => {
    const calls = stubFetch();
    const html = await bodyHtml(`投一下 [@${VOTE_ID}]`, { contentRefs: 'external' });

    expect(html).toContain(`[@${VOTE_ID}]`);
    expect(html).not.toContain('vote-embed');
    expect(calls).toEqual([]);
  });

  it('对外视图的收藏夹引用保留字面量，且**不发请求**', async () => {
    const calls = stubFetch();
    const html = await bodyHtml(`收藏 [@${FAV_ID}]`, { contentRefs: 'external' });

    expect(html).toContain(`[@${FAV_ID}]`);
    expect(calls).toEqual([]);
  });

  it('成员视图的投票引用照旧请求 + 建嵌入位', async () => {
    const calls = stubFetch();
    const html = await bodyHtml(`投一下 [@${VOTE_ID}]`, { contentRefs: 'expand' });

    expect(html).toContain(`data-vote-id="${VOTE_ID}"`);
    // 两次是**刻意的**：预处理那次只探「存在吗」，小组件自己要再拉一次票数与选项
    // （renderVoteEmbed，写在 blog-markdown.ts）。对外视图两次都没有。
    expect(calls).toEqual([`/api/votes/${VOTE_ID}`, `/api/votes/${VOTE_ID}`]);
  });
});
