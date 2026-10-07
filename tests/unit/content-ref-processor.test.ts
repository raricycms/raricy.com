// ─────────────────────────────────────────────────────────────────────────────
// content-ref-processor.test.ts —— 整篇引用预处理的预算 / 顺序 / 降级语义
//
// 与 blog-ref-render.test.ts 的分工：那边用真组件钉「两种模式各展开到哪一档」，
// 这里钉**处理器本身的算术** —— 预算按整篇计、取不到的不吃名额、收藏夹那趟
// 在最后（卡片里的字样不被二次解释）、会话级 resolver 跨渲染复用。
// 这些错法都不报错：预算数错只是「多展开 / 少展开一条」，顺序错了只是
// 「卡片里的字被当成引用」—— 页面一切如常。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentRefProcessor } from '@/lib/content-ref-processor';
import { ContentRefResolver } from '@/lib/content-ref-resolver';
import { MAX_BLOG_REF_ITEMS } from '@/lib/content-refs';

const CLIP_ID = 'AbCd1234';
const IMAGE_ID = 'AaBbCcDd10';
const VOTE_ID = 'AbCdEf123';
const FAV_ID = '123456';
const AUDIO_TOKEN = '[@音频/AaBbCcDd10]';

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

describe('替换预算（整篇 MAX_BLOG_REF_ITEMS）', () => {
  it(`★ 第 ${MAX_BLOG_REF_ITEMS + 1} 处引用保留字面量 ★`, async () => {
    stubFetch();
    const r = new ContentRefResolver('expand');
    const tokens = Array.from({ length: MAX_BLOG_REF_ITEMS + 1 }, () => `[@${IMAGE_ID}]`).join(' ');

    const out = await new ContentRefProcessor(r).preprocess(tokens);

    const expanded = out.match(/!\[/g) ?? [];
    expect(expanded).toHaveLength(MAX_BLOG_REF_ITEMS);
    expect(out).toContain(`[@${IMAGE_ID}]`); // 超出的那一处原样留着
  });

  it('取不到的引用不吃名额（缺失剪贴板在前，图床照样展开满额）', async () => {
    stubFetch();
    const r = new ContentRefResolver('external', {}); // 剪贴板不在下发表里
    const tokens = [`[@${CLIP_ID}]`, ...Array.from({ length: MAX_BLOG_REF_ITEMS }, () => `[@${IMAGE_ID}]`)].join('\n');

    const out = await new ContentRefProcessor(r).preprocess(tokens);

    expect(out).toContain(`[@${CLIP_ID}]`); // 缺失的保持字面量
    const expanded = out.match(/!\[/g) ?? [];
    expect(expanded, '缺失引用若吃了名额，这里会少一条').toHaveLength(MAX_BLOG_REF_ITEMS);
  });
});

describe('替换顺序', () => {
  it('★ 收藏夹卡片最后才插入：卡片标题里的 `[@8位]` 不会被二次解释 ★', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/api/spider/favorites/')) {
        // 卡片里含一条博客标题，标题正好是剪贴板引用的形状（不可信输入）
        return { title: '合集', count: 1, author: 'raricy', blogs: [{ id: 'b1', title: `[@${CLIP_ID}]` }] };
      }
      return { clip: { content: '不应内联进卡片' } };
    });
    const r = new ContentRefResolver('expand');

    const out = await new ContentRefProcessor(r).preprocess(`收藏 [@${FAV_ID}]`);

    expect(out).toContain('favorite-embed');
    expect(out).not.toContain('不应内联进卡片');
    // 正文里压根没写过这条剪贴板 token —— 它只存在于插入后的卡片里，
    // 所以连请求都不该发（扫描早在插入之前完成）。
    expect(calls.some((u) => u.includes('/api/clipboard/'))).toBe(false);
  });

  it('正文只有音频引用时照样展开（空集早退不吞播放器）', async () => {
    stubFetch();
    const r = new ContentRefResolver('expand');

    const out = await new ContentRefProcessor(r).preprocess(`听这段 ${AUDIO_TOKEN}`);

    expect(out).toContain('<audio');
    expect(out).not.toContain('[@音频/');
  });
});

describe('降级', () => {
  it('投票探测失败 → 换兜底链接而不是嵌入位', async () => {
    stubFetch(() => 'NOT_OK');
    const r = new ContentRefResolver('expand');

    const out = await new ContentRefProcessor(r).preprocess(`投一下 [@${VOTE_ID}]`);

    expect(out).not.toContain('vote-embed');
    expect(out).toContain(`[投票 ${VOTE_ID} 加载失败，点击查看]`);
  });
});

describe('会话级 resolver（编辑器预览形态）', () => {
  it('★ 同一个 resolver 跨两次 preprocess：第二条相同内容零请求 ★', async () => {
    const calls = stubFetch(() => ({ clip: { content: '剪贴板正文' } }));
    const r = new ContentRefResolver('expand');
    const p = new ContentRefProcessor(r);
    const text = `见 [@${CLIP_ID}]`;

    const first = await p.preprocess(text);
    const second = await p.preprocess(text);

    expect(first).toContain('剪贴板正文');
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('invalidate() 之后下一次 preprocess 重新取数（手动刷新预览）', async () => {
    let content = '旧正文';
    stubFetch(() => ({ clip: { content } }));
    const r = new ContentRefResolver('expand');
    const p = new ContentRefProcessor(r);
    const text = `见 [@${CLIP_ID}]`;

    expect(await p.preprocess(text)).toContain('旧正文');
    content = '新正文';
    r.invalidate();
    expect(await p.preprocess(text)).toContain('新正文');
  });
});
