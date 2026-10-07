// ─────────────────────────────────────────────────────────────────────────────
// content-ref-resolver.test.ts —— 引用取数层的缓存 / 去重 / 降级语义
//
// 【为什么值得单测】这层是编辑器预览「不重取、不串模式、失败可重试」的全部依据，
// 而错法全是静默的：并发重复请求只是「慢一点」、失败永久驻留只是「这次没加载出来」、
// external 模式多发一条请求只是「401 一下」—— 页面全都照常渲染。
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

  it('已落账的条目不再请求（编辑器预览跨重渲染复用的依据）', async () => {
    const calls = stubFetch(() => ({ clip: { content: '正文' } }));
    const r = new ContentRefResolver('expand');

    await r.resolve('clipboard', CLIP_ID);
    await r.resolve('clipboard', CLIP_ID);
    expect(r.peek('clipboard', CLIP_ID)?.content).toBe('正文');

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

describe('失败与刷新', () => {
  it('取数失败降级成文案并落缓存（不在每次渲染时重试）', async () => {
    const calls = stubFetch(() => 'NOT_OK');
    const r = new ContentRefResolver('expand');

    const first = await r.resolve('clipboard', CLIP_ID);
    const second = await r.resolve('clipboard', CLIP_ID);

    expect(first?.content).toBe(clipboardFailureText(CLIP_ID));
    expect(second?.content).toBe(clipboardFailureText(CLIP_ID));
    expect(calls).toHaveLength(1);
  });

  it('★ invalidate() 后重新请求 —— 403 不会被上一份缓存掩盖 ★', async () => {
    let gate: unknown = 'NOT_OK';
    const calls = stubFetch(() => gate);
    const r = new ContentRefResolver('expand');

    const denied = await r.resolve('clipboard', CLIP_ID);
    expect(denied?.content).toBe(clipboardFailureText(CLIP_ID));

    // 服务端随后放开了：不刷新就永远停在失败文案；刷新必须真去重取。
    gate = { clip: { content: '后来能读了' } };
    expect((await r.resolve('clipboard', CLIP_ID))?.content).toBe(clipboardFailureText(CLIP_ID));
    r.invalidate();
    expect((await r.resolve('clipboard', CLIP_ID))?.content).toBe('后来能读了');
    expect(calls).toHaveLength(2);
  });

  it('★ 刷新时在飞的旧请求被作废：新代真重取，旧响应不回填缓存 ★', async () => {
    // 场景：用户点了「刷新预览」，但刷新前那条请求还没落地。服务端状态在这中间
    // 变了（比如引用方把剪贴板从私有改成公开）—— 旧响应若写回缓存，刷新就白点了。
    const calls: string[] = [];
    // 两条都悬在半空，由用例控制落地顺序 —— 只有这样才能在「旧落地、新未落地」
    // 那个瞬间观察缓存，否则新代结果已经盖过旧代，断言看不出区别。
    const land: (() => void)[] = [];
    const respond = (content: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ clip: { content } }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Promise((resolve) => {
          land.push(() => resolve(respond(calls.length === 1 ? '旧正文' : '新正文')));
        });
      })
    );

    const r = new ContentRefResolver('expand');
    const first = r.resolve('clipboard', CLIP_ID); // 代 0，在飞

    r.invalidate(); // 刷新预览

    const second = r.resolve('clipboard', CLIP_ID);
    expect(calls, '刷新必须真去重取，不能复用刷新前那条在飞请求').toHaveLength(2);

    // 旧请求先落地 —— 不得写回缓存（否则把稍后取到的新结果又盖回旧的）
    land[0]();
    await first;
    expect(r.peek('clipboard', CLIP_ID), '旧代响应不得落进缓存').toBeUndefined();

    // 新请求落地后才落账
    land[1]();
    expect((await second)?.content).toBe('新正文');
    expect(r.peek('clipboard', CLIP_ID)?.content).toBe('新正文');

    // 新代落账后照常命中缓存
    await r.resolve('clipboard', CLIP_ID);
    expect(calls).toHaveLength(2);
  });

  it('刷新后同键的并发读取仍只发一次（旧的在飞请求不得摘掉新请求）', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input));
        if (calls.length === 1) return new Promise(() => {}); // 永不落地
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ clip: { content: 'x' } }) });
      })
    );

    const r = new ContentRefResolver('expand');
    void r.resolve('clipboard', CLIP_ID);
    r.invalidate();

    const [a, b] = await Promise.all([
      r.resolve('clipboard', CLIP_ID),
      r.resolve('clipboard', CLIP_ID),
    ]);

    // 一条旧的 + 一条新的；若新代两条没共用 in-flight 就是三条
    expect(calls).toHaveLength(2);
    expect(a).toBe(b);
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
  it('剪贴板只认下发的公开档；投票 / 收藏夹 / 图床各按口径', async () => {
    const calls = stubFetch();
    const r = new ContentRefResolver('external', { [CLIP_ID]: '公开剪贴板正文' });

    expect((await r.resolve('clipboard', CLIP_ID))?.content).toBe('公开剪贴板正文');
    // 不在表里的（私有 / 已软删 / 不存在）→ undefined = 保留字面量
    expect(await r.resolve('clipboard', 'ZZyy9876')).toBeUndefined();
    expect(await r.resolve('vote', VOTE_ID)).toBeUndefined();
    expect(await r.resolve('favorite', FAV_ID)).toBeUndefined();
    expect((await r.resolve('image', IMAGE_ID))?.url).toBe(`/api/images/${IMAGE_ID}/raw`);

    expect(calls, '对外视图一个请求都不发').toEqual([]);
  });

  it('不在表里的剪贴板不落缓存（payload 是固定快照，重查字典即可）', async () => {
    const r = new ContentRefResolver('external', {});
    await r.resolve('clipboard', CLIP_ID);
    expect(r.peek('clipboard', CLIP_ID)).toBeUndefined();
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
    stubFetch(() => ({ clip: { content: 'x' } }));
    const r = new ContentRefResolver('expand');

    // 填满后再多来一条 → 最早那条被逐出
    const firstId = 'Aa000000';
    await r.resolve('clipboard', firstId);
    for (let i = 0; i < RESOLVER_CACHE_CAP; i += 1) {
      await r.resolve('clipboard', `Bb${String(i).padStart(6, '0')}`);
    }
    expect(r.peek('clipboard', firstId)).toBeUndefined();

    // 被逐出不等于消失：再 resolve 一次重新拉回来
    const again = await r.resolve('clipboard', firstId);
    expect(again?.content).toBe('x');
  });
});
