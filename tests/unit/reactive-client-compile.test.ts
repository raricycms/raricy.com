// ─────────────────────────────────────────────────────────────────────────────
// reactive-client-compile.test.ts —— 编辑器预览的客户端适配 + 编译（T3）
//
// 钉四件事，每件错了都**不报错**：
//   · `[@…]` token 没被适配（预览里只剩一串原文，作者以为引用坏了）；
//   · 代码块里的 token 被适配（《内容引用语法指南》承诺不展开）；
//   · 适配后的源码编译不过（预览永远停在上一版 / 空白）；
//   · 坏源码没有诊断（作者看不到错在哪，只看到旧预览）。
//
// 全程离线：reader 是假的，编译走本地 `compileLocal`。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { ReferenceReader } from '@/lib/reactive/ref-types';
import { MAX_REF_CONCURRENCY } from '@/lib/content-refs';
import {
  adaptReactivePreview,
  compileReactivePreview,
  createClientReferenceReader,
} from '@/lib/reactive/client-compile';

const IMAGE_ID = 'AaBbCcDd10'; // 10 位
const AUDIO_ID = 'EeFfGgHh20'; // 10 位
const VOTE_ID = 'AbCdEf123'; // 9 位
const CLIP_ID = 'AbCd1234'; // 8 位
const FAV_ID = '123456'; // 6 位数字

/** 一个按 kind 回固定数据、并记录调用的 reader（形状对齐 ref-reader）。 */
function fakeReader(): { reader: ReferenceReader; calls: string[] } {
  const calls: string[] = [];
  const reader: ReferenceReader = async (slot) => {
    calls.push(`${slot.kind}:${slot.ref}`);
    if (slot.kind === 'clipboard') {
      return {
        status: 'ready',
        title: '剪贴板标题',
        format: 'markdown',
        version: 'v1',
        content: '# 不该被内联的正文',
        payload: { href: `/clipboard/${slot.ref}`, title: '剪贴板标题' },
      };
    }
    if (slot.kind === 'vote') {
      return {
        status: 'ready',
        title: '投票标题',
        payload: {
          id: slot.ref,
          title: '投票标题',
          is_locked: false,
          total_votes: 3,
          user_voted: null,
          options: [{ id: 1, label: '甲', count: 3, percentage: 100 }],
        },
      };
    }
    if (slot.kind === 'favorite') {
      return {
        status: 'ready',
        title: '收藏夹标题',
        payload: {
          title: '收藏夹标题',
          authorName: '站长',
          href: `/favorite/${slot.ref}`,
          count: 1,
          items: [{ blogId: 'blog-1', title: '一篇博客' }],
        },
      };
    }
    return undefined;
  };
  return { reader, calls };
}

const tag = (kind: string, ref: string) => `<site-embed kind="${kind}" ref="${ref}" />`;

describe('compileReactivePreview', () => {
  it('适配五类引用：图床拼 URL，其余发宿主标签并带 hostData', async () => {
    const { reader, calls } = fakeReader();
    const source = [
      `图 ![x] 在 [@${IMAGE_ID}]。`,
      `音频 [@音频/${AUDIO_ID}]`,
      `投票 [@${VOTE_ID}]`,
      `收藏 [@${FAV_ID}]`,
      `剪贴板 [@${CLIP_ID}]`,
    ].join('\n\n');

    const { adaptedSource, hostData, result } = await compileReactivePreview(source, reader);

    expect(adaptedSource).toContain(`![${IMAGE_ID}](/api/images/${IMAGE_ID}/raw)`);
    expect(adaptedSource).toContain(tag('audio', AUDIO_ID));
    expect(adaptedSource).toContain(tag('vote', VOTE_ID));
    expect(adaptedSource).toContain(tag('favorite', FAV_ID));
    expect(adaptedSource).toContain(tag('clipboard', CLIP_ID));

    expect(hostData[`audio:${AUDIO_ID}`]).toMatchObject({ status: 'ready' });
    expect(hostData[`vote:${VOTE_ID}`]).toMatchObject({
      kind: 'vote',
      ref: VOTE_ID,
      status: 'ready',
    });
    expect(hostData[`favorite:${FAV_ID}`]).toMatchObject({
      kind: 'favorite',
      ref: FAV_ID,
      status: 'ready',
    });
    // Markdown 剪贴板在 expand 下内联一层（宿主渲染器只读展示）；Reactive 剪贴板才保持卡片。
    expect(hostData[`clipboard:${CLIP_ID}`]).toMatchObject({
      kind: 'clipboard',
      ref: CLIP_ID,
      status: 'ready',
    });
    // 原始正文只用于编译；预览与阅读拿到的是同版本静态子文档。
    expect(hostData[`clipboard:${CLIP_ID}`].content).toBeUndefined();
    expect(hostData[`clipboard:${CLIP_ID}`].document).toBeTruthy();
    expect(hostData[`clipboard:${CLIP_ID}`].hostData).toBeTruthy();

    // 取数只发生在需要它的三类上；图床 / 音频不占请求。
    expect(calls.sort()).toEqual(
      [`clipboard:${CLIP_ID}`, `favorite:${FAV_ID}`, `vote:${VOTE_ID}`].sort()
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document).toBeTruthy();
    }
  });

  it('代码块与行内代码里的 token 原样保留，且不触发取数', async () => {
    const { reader, calls } = fakeReader();
    const source = [
      '```',
      `[@${CLIP_ID}]`,
      '<site-embed kind="vote" ref="AbCdEf123" />',
      '```',
      '',
      `行内 \`[@${VOTE_ID}]\` 也不展开。`,
    ].join('\n');

    const { adaptedSource, hostData } = await compileReactivePreview(source, reader);

    expect(adaptedSource).toBe(source);
    expect(hostData).toEqual({});
    expect(calls).toEqual([]);
  });

  it('普通文档能编译出文档对象', async () => {
    const { reader } = fakeReader();
    const { result } = await compileReactivePreview('# 标题\n\n一段正文。', reader);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document).toBeTruthy();
  });

  it('非法源码返回诊断而不是抛出', async () => {
    const { reader } = fakeReader();
    const { result } = await compileReactivePreview('{{ 1 + }}', reader);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });
});

describe('createClientReferenceReader', () => {
  it('只发 GET（无 method 字段），并按 kind 复用同一次请求', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/clipboard/')) {
        return new Response(
          JSON.stringify({
            code: 200,
            clip: { title: '标题', content: '正文', format: 'markdown', version: 'v1' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });
    const reader = createClientReferenceReader({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const first = await reader({ kind: 'clipboard', ref: CLIP_ID, token: '', start: 0, end: 0 });
    const second = await reader({ kind: 'clipboard', ref: CLIP_ID, token: '', start: 0, end: 0 });

    expect(first).toMatchObject({ status: 'ready', format: 'markdown', version: 'v1' });
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit | undefined,
    ];
    expect(init).toMatchObject({ credentials: 'same-origin' });
    expect((init as RequestInit | undefined)?.method).toBeUndefined();
  });

  it('收藏夹把 blogs[].id 映射成 items[].blogId（否则卡片静默 0 篇）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: FAV_ID,
          title: '收藏夹',
          author: '站长',
          count: 2,
          blogs: [{ id: 'b1', title: '一' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const reader = createClientReferenceReader({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const resolved = await reader({ kind: 'favorite', ref: FAV_ID, token: '', start: 0, end: 0 });
    expect(resolved).toMatchObject({
      status: 'ready',
      payload: {
        title: '收藏夹',
        authorName: '站长',
        count: 2,
        items: [{ blogId: 'b1', title: '一' }],
      },
    });
  });

  // R3-240：6 位白名单必须只有 favorite-refs 一处。把 FAVORITE_ID_LEN 改成 7 时，
  // 取数处手写的 `/^\d{6}$/` 不会跟随 → 收藏夹卡片静默消失、页面不报错。
  it('6 位**字母** token 不当收藏夹（不请求）；6 位数字才请求', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: FAV_ID, title: '收藏夹', count: 0, blogs: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const reader = createClientReferenceReader({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const letters = await reader({ kind: 'favorite', ref: 'abc123', token: '', start: 0, end: 0 });
    expect(letters, '6 位字母不是收藏夹 id，应保留字面量').toBeUndefined();
    expect(fetchImpl, '不是收藏夹就不该发请求').not.toHaveBeenCalled();

    const digits = await reader({ kind: 'favorite', ref: FAV_ID, token: '', start: 0, end: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(digits).toMatchObject({ status: 'ready' });
  });
});

describe('发布时的访客预览',()=>{
  it('不读取任何成员资源，引用保持原文，与实际外部文章一致',async()=>{
    const reader=vi.fn<ReferenceReader>();
    const source='正文 [@AbCd1234] [@AbCdEf123] [@123456]';
    const result=await adaptReactivePreview(source,reader,'external');
    expect(result.adaptedSource).toBe(source);expect(result.hostData).toEqual({});expect(reader).not.toHaveBeenCalled();
  });
});

// R3-103：编辑器里「预览」与「导出 / 打印」各自调一次 adaptReactivePreview。
// 以前每次适配各建一个 4 并发闸门 → 同页并发时真实请求峰值 2×4；现在两处共用
// client-compile.ts 的模块级闸门，峰值封在 MAX_REF_CONCURRENCY。
describe('预览与导出共享同一条取数闸门（R3-103）', () => {
  it(`两次并发适配的真实取数峰值不超过 ${MAX_REF_CONCURRENCY}`, async () => {
    let active = 0;
    let peak = 0;
    const reader: ReferenceReader = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: 'ready' };
    };
    // 两次适配各 4 条不同的投票引用：各建闸门时峰值会到 8。
    const ids = Array.from({ length: 8 }, (_, i) => `AbCdEf3${String(i).padStart(2, '0')}`);
    const sourceOf = (from: number) => ids.slice(from, from + 4).map((id) => `投 [@${id}]`).join('\n\n');

    await Promise.all([
      adaptReactivePreview(sourceOf(0), reader),
      adaptReactivePreview(sourceOf(4), reader),
    ]);

    expect(peak, '共享闸门没生效时这里会是 8').toBeLessThanOrEqual(MAX_REF_CONCURRENCY);
    expect(peak, '探针没测到并发，这条就测不到东西了').toBeGreaterThan(1);
  });
});
