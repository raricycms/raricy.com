// ─────────────────────────────────────────────────────────────────────────────
// content-ref-resolver.test.ts —— 引用取数层的缓存 / 去重 / 降级语义
//
// 【为什么值得单测】这层是「不重取、不串模式、失败可重试」的全部依据，
// 而错法全是静默的：并发重复请求只是「慢一点」、失败永久驻留只是「这次没加载出来」、
// external 模式多发一条请求只是「401 一下」—— 页面全都照常渲染。
// 缓存是否命中一律用 fetch 次数断言，不读内部成员。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContentRefResolver,
  RESOLVER_CACHE_CAP,
} from '@/lib/content-ref-resolver';
import { clipboardFailureText } from '@/lib/content-refs';
import { favoriteFailureText } from '@/lib/favorite-refs';

const CLIP_ID = 'AbCd1234';
const VOTE_ID = 'AbCdEf123';
const IMAGE_ID = 'AaBbCcDd10';
const FAV_ID = '123456';

/** fetch 桩：记下所有请求 URL；impl 返回 'NOT_OK' 时模拟非 2xx。 */
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

describe('并发去重与缓存命中', () => {
  it('★ 同一资源的并发读取复用同一个 in-flight Promise（只发一次请求）★', async () => {
    const calls = stubFetch(() => ({ clip: { content: '正文' } }));
    const r = new ContentRefResolver('expand');

    const [a, b] = await Promise.all([
      r.resolve('clipboard', CLIP_ID),
      r.resolve('clipboard', CLIP_ID),
    ]);

    expect(calls).toEqual([`/api/clipboard/${CLIP_ID}`]);
    expect(a).toBe(b);
    expect(a?.content).toBe('正文');
  });

  it('已落账的条目不再请求（同一 resolver 复用跨渲染的依据）', async () => {
    const calls = stubFetch(() => ({ clip: { content: '正文' } }));
    const r = new ContentRefResolver('expand');

    const first = await r.resolve('clipboard', CLIP_ID);
    const second = await r.resolve('clipboard', CLIP_ID);

    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('缓存键带资源类型：同 id 不同型互不命中', async () => {
    // 10 位 id 按分流是图床（不请求）；刻意用同一个串再按剪贴板问一次 ——
    // 两条缓存互不相干（真实分流不会这样混，这里钉的是键的形状）。
    const calls = stubFetch(() => ({ clip: { content: 'x' } }));
    const r = new ContentRefResolver('expand');

    const img = await r.resolve('image', IMAGE_ID);
    const clip = await r.resolve('clipboard', IMAGE_ID);

    expect(img?.url).toBe(`/api/images/${IMAGE_ID}/raw`);
    expect(clip?.content).toBe('x');
    expect(calls).toEqual([`/api/clipboard/${IMAGE_ID}`]);
  });
});

describe('失败与降级', () => {
  it('取数失败降级成文案并落缓存（不在每次渲染时重试）', async () => {
    const calls = stubFetch(() => 'NOT_OK');
    const r = new ContentRefResolver('expand');

    const first = await r.resolve('clipboard', CLIP_ID);
    const second = await r.resolve('clipboard', CLIP_ID);

    expect(first?.content).toBe(clipboardFailureText(CLIP_ID));
    expect(second?.content).toBe(clipboardFailureText(CLIP_ID));
    expect(calls).toHaveLength(1);
  });

  it('投票探测失败带 error 标记（渲染层据此换兜底链接）', async () => {
    stubFetch(() => 'NOT_OK');
    const r = new ContentRefResolver('expand');

    const hit = await r.resolve('vote', VOTE_ID);

    expect(hit?.type).toBe('vote');
    expect(hit?.error).toBe(true);
    expect(hit?.id).toBe(VOTE_ID);
  });
});

describe('external 模式：一个请求都不发', () => {
  it('成员资源一律保留字面量，图床仍可用', async () => {
    const calls = stubFetch();
    const r = new ContentRefResolver('external');

    expect(await r.resolve('clipboard', CLIP_ID)).toBeUndefined();
    expect(await r.resolve('vote', VOTE_ID)).toBeUndefined();
    expect(await r.resolve('favorite', FAV_ID)).toBeUndefined();
    expect((await r.resolve('image', IMAGE_ID))?.url).toBe(`/api/images/${IMAGE_ID}/raw`);

    expect(calls, '对外视图一个请求都不发').toEqual([]);
  });
});

describe('剪贴板格式：reactive 绝不内联', () => {
  it('expand 响应：带 reactive / 未知格式 → 链接；缺 format 的旧响应仍按 markdown 内联', async () => {
    let body: unknown = { clip: { content: '# 源码', format: 'reactive' } };
    const calls = stubFetch(() => body);
    const r = new ContentRefResolver('expand');

    const reactive = await r.resolve('clipboard', CLIP_ID);
    expect(reactive?.format).toBe('reactive');
    expect(reactive?.content).toBe('[查看剪贴板](/clipboard/AbCd1234)');

    body = { clip: { content: '认不出', format: 'weird' } };
    expect((await r.resolve('clipboard', 'Bad0Bad0'))?.content).toBe(
      '[查看剪贴板](/clipboard/Bad0Bad0)'
    );

    body = { clip: { content: '未知格式源码', format: null } };
    expect((await r.resolve('clipboard', 'Null0001'))?.content).toBe('[查看剪贴板](/clipboard/Null0001)');
    body = { clip: { content: '旧响应正文' } };
    expect((await r.resolve('clipboard', 'Legacy02'))?.content).toBe('旧响应正文');

    expect(calls).toHaveLength(4);
  });

  it('缓存保留格式（只存正文的话，第二次命中就分不出能不能内联）', async () => {
    stubFetch(() => ({ clip: { content: '# 源码', format: 'reactive' } }));
    const r = new ContentRefResolver('expand');

    await r.resolve('clipboard', CLIP_ID);
    const hit = await r.resolve('clipboard', CLIP_ID);

    expect(hit?.format).toBe('reactive');
    expect(hit?.content).toBe('[查看剪贴板](/clipboard/AbCd1234)');
  });
});

describe('图床与收藏夹', () => {
  it('图床不请求，只拼 raw URL（私有档由 raw 路由自己 404）', async () => {
    const calls = stubFetch();
    const r = new ContentRefResolver('expand');

    const hit = await r.resolve('image', IMAGE_ID);

    expect(hit).toEqual({ type: 'image', url: `/api/images/${IMAGE_ID}/raw` });
    expect(calls).toEqual([]);
  });

  it('收藏夹成功 → 拼卡片 HTML；失败 → 降级文案', async () => {
    stubFetch((url) =>
      url.includes('/api/spider/favorites/')
        ? { title: '我的收藏', count: 2, author: 'raricy', blogs: [{ id: 'b1', title: '第一篇' }] }
        : {}
    );
    const r = new ContentRefResolver('expand');

    const ok = await r.resolve('favorite', FAV_ID);
    expect(ok?.content).toContain('favorite-embed');
    expect(ok?.content).toContain('我的收藏');
    expect(ok?.content).toContain('/blog/b1');

    vi.unstubAllGlobals();
    stubFetch(() => 'NOT_OK');
    const bad = await r.resolve('favorite', '654321');
    expect(bad?.content).toBe(favoriteFailureText('654321'));
  });
});

describe('容量上限', () => {
  it(`超过 ${'RESOLVER_CACHE_CAP'} 条时逐出最旧（重取一次而已，不报错）`, async () => {
    const calls = stubFetch(() => ({ clip: { content: 'x' } }));
    const r = new ContentRefResolver('expand');

    // 填满后再多来一条 → 最早那条被逐出
    const firstId = 'Aa000000';
    await r.resolve('clipboard', firstId);
    for (let i = 0; i < RESOLVER_CACHE_CAP; i += 1) {
      await r.resolve('clipboard', `Bb${String(i).padStart(6, '0')}`);
    }
    expect(calls).toHaveLength(RESOLVER_CACHE_CAP + 1);

    // 被逐出不等于消失：再 resolve 一次重新拉回来（多发一条请求，不报错）
    const again = await r.resolve('clipboard', firstId);
    expect(again?.content).toBe('x');
    expect(calls).toHaveLength(RESOLVER_CACHE_CAP + 2);
  });
});
