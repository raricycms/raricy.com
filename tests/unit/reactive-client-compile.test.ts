// ─────────────────────────────────────────────────────────────────────────────
// 编辑器预览和导出的引用取数、适配与并发上限。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { ReferenceReader } from '@/lib/reactive/ref-types';
import { MAX_REF_CONCURRENCY } from '@/lib/content-refs';
import {
  adaptReactivePreview,
  createClientReferenceReader,
} from '@/lib/reactive/client-compile';

const CLIP_ID = 'AbCd1234'; // 8 位
const FAV_ID = '123456'; // 6 位数字

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
