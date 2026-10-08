// ─────────────────────────────────────────────────────────────────────────────
// content-ref-limits.test.ts —— 引用的三条**硬上限**：取数条数 / 并发 / 展开总量
//
// 【为什么单测】这三条全是「没有它也不报错」的东西：
//   · 取数条数没有上限 → 一篇塞满引用的正文，读者浏览器一次打出成千上万条请求
//     （id 甚至不必存在 —— 博客那条正则用的是 `\w`，不校验存在性）；
//   · 真实并发没有上限 → 同一堆请求一次性全发出去，把上游打成一堵墙；
//   · 展开总量没有上限 → 同一条 5 万字的剪贴板引用 50 次，正文从几百字放大到
//     **250 万**（改版前实测，见 artifact 里的审计报告）。
// 三条都不会让页面报错、不会让控制台报错，只会静默地慢、静默地大。
//
// 与 content-ref-processor.test.ts 的分工：那边钉「预算按整篇计 / 顺序 / 降级」，
// 这里钉**上限本身**（数量、并发、字符数）以及自引用 / 双向引用不递归。
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentRefProcessor } from '@/lib/content-ref-processor';
import { ContentRefResolver } from '@/lib/content-ref-resolver';
import {
  MAX_REF_CONCURRENCY,
  MAX_REF_EXPAND_CHARS,
  MAX_REF_FETCHES,
  createConcurrencyLimiter,
} from '@/lib/content-refs';

/** 8 位剪贴板 id（`\w` 认，`{8}`）。 */
const clipId = (i: number) => `cl${String(i).padStart(6, '0')}`;
/** 9 位投票 id。 */
const voteId = (i: number) => `vt${String(i).padStart(7, '0')}`;
/** 6 位收藏夹 id（必须全数字）。 */
const favId = (i: number) => String(100000 + i);
const ref = (id: string) => `[@${id}]`;

/** fetch 桩：url → 响应体由 impl 决定；记下每一次调用的 url。 */
function stubFetch(impl: (url: string) => unknown = () => ({ clip: { content: 'C' } })): string[] {
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

/**
 * 每条响应都由用例手动兑现的 fetch 桩 —— 只有这样才能把并发卡在指定位置观察，
 * 也才能测「刷新时排队的旧请求不再发出」。
 */
function deferredFetch() {
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const pending: Array<() => void> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        pending.push(() => {
          active -= 1;
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ clip: { content: '正文' } }),
          } as Response);
        });
      });
    })
  );
  return {
    calls,
    maxActive: () => peak,
    pendingCount: () => pending.length,
    /** 兑现一条在飞响应，并让闸门与 promise 链跑一拍（放行下一条）。 */
    drainOne: async () => {
      const next = pending.shift();
      if (!next) throw new Error('没有待兑现的响应');
      next();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══ 一、取数条数：一轮最多 MAX_REF_FETCHES 个「需要取数」的引用 ══════════════

describe(`取数上限（一轮最多 ${MAX_REF_FETCHES} 个不同 id）`, () => {
  it('★ 60 条不同剪贴板：只发 50 次请求，其余保留字面量 ★', async () => {
    const calls = stubFetch(() => ({ clip: { content: '正文' } }));
    const r = new ContentRefResolver('expand');
    const ids = Array.from({ length: 60 }, (_, i) => clipId(i));

    const out = await new ContentRefProcessor(r).preprocess(ids.map(ref).join(' '));

    const clipCalls = calls.filter((u) => u.includes('/api/clipboard/'));
    expect(clipCalls, `取数本该封在 ${MAX_REF_FETCHES} 条`).toHaveLength(MAX_REF_FETCHES);
    expect(calls).toHaveLength(MAX_REF_FETCHES);
    // 前 50 条展开、后 10 条保留字面量
    expect(out, '第 51 条起不该被替换').toContain(ref(ids[MAX_REF_FETCHES]));
  });

  it('★ 图床不占取数名额：50 条剪贴板的名额一条不少 ★', async () => {
    const calls = stubFetch(() => ({ clip: { content: '正文' } }));
    const r = new ContentRefResolver('expand');
    const IMG = 'AaBbCcDd10';
    // 一张图床打头 + 60 条剪贴板：图床只拼 URL、不取数，剪贴板该拿到完整的 50 个名额
    const ids = Array.from({ length: 60 }, (_, i) => clipId(i));
    const src = [ref(IMG), ...ids.map(ref)].join(' ');

    const out = await new ContentRefProcessor(r).preprocess(src);

    expect(
      calls.filter((u) => u.includes('/api/clipboard/')),
      '图床若吃了取数名额，这里会是 49'
    ).toHaveLength(MAX_REF_FETCHES);
    expect(calls.filter((u) => u.includes('/api/images/'))).toEqual([]);
    // 图床排在 60 条之前，照常在替换名额里展开
    expect(out).toContain(`![${IMG}](/api/images/${IMG}/raw)`);
  });

  it('★ 按原文出现顺序挑候选：正文前面的投票能拿到名额 ★', async () => {
    const calls = stubFetch((url) =>
      url.includes('/api/votes/') ? { code: 200, data: { title: 't' } } : { clip: { content: 'C' } }
    );
    const r = new ContentRefResolver('expand');
    // 3 条投票在前、47+ 条剪贴板在后 → 投票必须都在前 50 个候选里
    const votes = [0, 1, 2].map(voteId);
    const clips = Array.from({ length: 55 }, (_, i) => clipId(i));
    const src = [...votes.map(ref), ...clips.map(ref)].join(' ');

    await new ContentRefProcessor(r).preprocess(src);

    expect(
      calls.filter((u) => u.includes('/api/votes/')),
      '前面的投票被后面的剪贴板挤掉了'
    ).toHaveLength(3);
    expect(calls).toHaveLength(MAX_REF_FETCHES);
  });

  it('★ 反过来：投票排在 50 条剪贴板之后 → 一个都不取（保留字面量）★', async () => {
    const calls = stubFetch((url) =>
      url.includes('/api/votes/') ? { code: 200, data: { title: 't' } } : { clip: { content: 'C' } }
    );
    const r = new ContentRefResolver('expand');
    const clips = Array.from({ length: 50 }, (_, i) => clipId(i));
    const vote = voteId(0);
    const src = [...clips.map(ref), ref(vote)].join(' ');

    const out = await new ContentRefProcessor(r).preprocess(src);

    expect(calls.filter((u) => u.includes('/api/votes/'))).toEqual([]);
    expect(out, '超出取数预算的投票该保留字面量').toContain(ref(vote));
  });

  it('同一个 id 出现多次 → 只取一次（去重，不吃重复名额）', async () => {
    const calls = stubFetch(() => ({ clip: { content: '正文' } }));
    const r = new ContentRefResolver('expand');
    const src = Array.from({ length: 100 }, () => ref(clipId(0))).join(' ');

    await new ContentRefProcessor(r).preprocess(src);

    expect(calls).toEqual([`/api/clipboard/${clipId(0)}`]);
  });

  it('代码块 / 行内代码里的引用不取数（盖码在候选挑选之前）', async () => {
    const calls = stubFetch(() => ({ clip: { content: '不该内联' } }));
    const r = new ContentRefResolver('expand');
    const fenced = ['```', ref(clipId(0)), '```'].join('\n');
    const inline = `写法是 \`${ref(clipId(1))}\``;

    await new ContentRefProcessor(r).preprocess(`${fenced}\n\n${inline}`);

    expect(calls).toEqual([]);
  });

  it(`★ 收藏夹候选超过 ${MAX_REF_FETCHES}：HTTP 也不超 ${MAX_REF_FETCHES}（卡片另受 3 张上限）★`, async () => {
    // 60 个不同收藏夹：取数候选封在 50 ⇒ 50 次请求；卡片另有 MAX_FAVORITE_REFS=3，
    // 所以「请求数」与「卡片数」是两个不同的上界，别把其中一个当成另一个。
    const calls = stubFetch(() => ({ title: '合集', count: 0, author: 'a', blogs: [] }));
    const r = new ContentRefResolver('expand');
    const ids = Array.from({ length: 60 }, (_, i) => favId(i));

    const out = await new ContentRefProcessor(r).preprocess(ids.map(ref).join(' '));

    const favCalls = calls.filter((u) => u.includes('/api/spider/favorites/'));
    expect(favCalls, `收藏夹取数本该封在 ${MAX_REF_FETCHES} 次`).toHaveLength(MAX_REF_FETCHES);
    expect(calls).toHaveLength(MAX_REF_FETCHES);
    // 卡片最多 3 张 → 第 4 个及以后仍是字面量（数容器那个类，别数前缀 —— 卡片内部
    // 还有 favorite-embed__head 等一堆同前缀的类名）
    expect((out.match(/class="favorite-embed"/g) ?? [])).toHaveLength(3);
    expect(out).toContain(ref(ids[3]));
  });
});

// ═══ 二、并发：同一实例的真实异步读取封在 MAX_REF_CONCURRENCY ═══════════════

describe(`真实并发上限（${MAX_REF_CONCURRENCY}）`, () => {
  it('★ 10 条不同的剪贴板：同时最多 4 条在飞，其余排队 ★', async () => {
    const stub = deferredFetch();
    const r = new ContentRefResolver('expand');
    const ids = Array.from({ length: 10 }, (_, i) => clipId(i));

    const all = Promise.all(ids.map((id) => r.resolve('clipboard', id)));
    await Promise.resolve();
    expect(stub.calls, '闸门没生效：一次性全发出去了').toHaveLength(MAX_REF_CONCURRENCY);

    while (stub.pendingCount() > 0) await stub.drainOne();
    await all;

    expect(stub.calls).toHaveLength(10);
    expect(stub.maxActive(), `峰值并发 ${stub.maxActive()} 超过上限`).toBe(MAX_REF_CONCURRENCY);
  });

  it('★ 共享 resolver 的多轮渲染同时在飞：并发仍封在 4 ★', async () => {
    const stub = deferredFetch();
    const r = new ContentRefResolver('expand');
    const p = new ContentRefProcessor(r);
    const round = (prefix: string, n: number) =>
      p.preprocess(Array.from({ length: n }, (_, i) => ref(`${prefix}${String(i).padStart(6, '0')}`)).join(' '));

    const both = Promise.all([round('ee', 6), round('ff', 6)]);
    await Promise.resolve();
    expect(stub.calls).toHaveLength(MAX_REF_CONCURRENCY);

    while (stub.pendingCount() > 0) await stub.drainOne();
    await both;

    expect(stub.maxActive()).toBe(MAX_REF_CONCURRENCY);
  });

  it('★ 刷新后：排队的旧请求不再发出，且全部正常 settle（不挂死）★', async () => {
    const stub = deferredFetch();
    const r = new ContentRefResolver('expand');
    const ids = Array.from({ length: 10 }, (_, i) => clipId(i));

    const all = Promise.all(ids.map((id) => r.resolve('clipboard', id)));
    await Promise.resolve();
    expect(stub.calls, '4 条在飞、6 条排队').toHaveLength(MAX_REF_CONCURRENCY);

    r.invalidate(); // ←「刷新引用」：这 6 条排队请求拿的是刷新前的状态

    // 兑现那 4 条在飞的 → 闸门放行排队的 6 条，它们开工时发现代际过期
    while (stub.pendingCount() > 0) await stub.drainOne();

    const results = await all; // 全部 settle，绝不挂死
    expect(results).toHaveLength(10);
    expect(stub.calls, '过期的排队请求被发出去了').toHaveLength(MAX_REF_CONCURRENCY);
    // 排队的 6 条按「取不到」兑现（undefined = 保留字面量）；在飞的 4 条拿到真结果
    expect(results.filter((x) => x === undefined)).toHaveLength(6);
  });

  it('图床与对外视图不占并发名额（它们不发请求）', async () => {
    const stub = deferredFetch();
    const r = new ContentRefResolver('expand');
    // 4 条剪贴板吃满闸门，再问 10 张图床 —— 图床应当**立即**返回，不进队列
    const clips = Array.from({ length: MAX_REF_CONCURRENCY }, (_, i) => r.resolve('clipboard', clipId(i)));
    const images = await Promise.all(
      Array.from({ length: 10 }, (_, i) => r.resolve('image', `im${String(i).padStart(8, '0')}`))
    );

    expect(images.every((x) => x?.url?.startsWith('/api/images/'))).toBe(true);
    expect(stub.calls, '图床不该产生请求').toHaveLength(MAX_REF_CONCURRENCY);
    while (stub.pendingCount() > 0) await stub.drainOne();
    await Promise.all(clips);
  });

  it('★ 任务同步抛错 / 异步拒绝都不泄漏名额：后续任务照常启动（不挂死）★', async () => {
    // 闸门的任务若**同步**抛错（而不是返回一个 reject 的 Promise），实现里少放行一格
    // 就会让 `active` 永远差一个 → 后面的任务排到天荒地老。这条用例在「泄漏」的实现上
    // 不是断言失败，而是**超时**：第二段 `run(...)` 永远不启动。
    const run = createConcurrencyLimiter(1);

    const syncBoom = run((() => {
      throw new Error('同步炸');
    }) as () => Promise<never>);
    await expect(syncBoom).rejects.toThrow('同步炸');
    // 名额若被同步抛错吃掉，这一条永远不启动
    await expect(run(async () => 'after-sync')).resolves.toBe('after-sync');

    const asyncBoom = run(async () => {
      throw new Error('异步炸');
    });
    await expect(asyncBoom).rejects.toThrow('异步炸');
    await expect(run(async () => 'after-reject')).resolves.toBe('after-reject');
  });
});

// ═══ 三、展开总量：整篇 Markdown 封顶 MAX_REF_EXPAND_CHARS ═══════════════════

describe(`展开总量上限（${MAX_REF_EXPAND_CHARS}）`, () => {
  it('★ 大引用在前面装不下、后面的小引用照样展开 ★', async () => {
    const big = clipId(1);
    const small = clipId(2);
    stubFetch((url) =>
      url.includes(big) ? { clip: { content: 'x'.repeat(50000) } } : { clip: { content: 'y'.repeat(100) } }
    );
    const r = new ContentRefResolver('expand');
    // 原文 ≈ 499022，离预算只剩不到 1000
    const src = `${ref(big)} ${'z'.repeat(499000)} ${ref(small)}`;

    const out = await new ContentRefProcessor(r).preprocess(src);

    expect(out, '5 万字的引用装不下，该保留 token').toContain(ref(big));
    expect(out, '预算不该让后面的小引用也饿死').toContain('y'.repeat(100));
    expect(out.length).toBeLessThanOrEqual(MAX_REF_EXPAND_CHARS);
  });

  it('★ 原文本身就超预算（未合法草稿）：保留原文，不再增长 ★', async () => {
    stubFetch(() => ({ clip: { content: 'x'.repeat(50000) } }));
    const r = new ContentRefResolver('expand');
    const src = `${'z'.repeat(MAX_REF_EXPAND_CHARS + 1000)} ${ref(clipId(3))}`;

    const out = await new ContentRefProcessor(r).preprocess(src);

    expect(out, '超预算的原文不该被替换').toBe(src);
  });

  it('★ 同一条 5 万字剪贴板引用 50 次：输出不再 250 万 ★', async () => {
    stubFetch(() => ({ clip: { content: 'x'.repeat(50000) } }));
    const r = new ContentRefResolver('expand');
    const id = clipId(4);
    const src = Array.from({ length: 50 }, () => ref(id)).join(' ');

    const out = await new ContentRefProcessor(r).preprocess(src);

    expect(out.length, '展开总量没有封顶').toBeLessThanOrEqual(MAX_REF_EXPAND_CHARS);
    // 剩下的引用保留字面量（数一数还有多少个 token）
    expect((out.match(/\[@/g) ?? []).length).toBeGreaterThan(0);
    // 明确排除「250 万」这个旧行为
    expect(out.length).toBeLessThan(1000000);
  });

  it('★ 只有音频的早退路径同样受预算约束（正文超预算 → 不嵌播放器）★', async () => {
    stubFetch();
    const r = new ContentRefResolver('expand');
    const token = '[@音频/AbCdEf1234]';
    const src = `${'z'.repeat(MAX_REF_EXPAND_CHARS + 10)} ${token}`;

    const out = await new ContentRefProcessor(r).preprocess(src);

    expect(out).not.toContain('<audio');
    expect(out).toContain(token);
  });

  it('★ 收藏夹那最后一趟也受预算约束（卡片装不下就保留 token）★', async () => {
    stubFetch((url) =>
      url.includes('/api/spider/favorites/')
        ? { title: '合集', count: 1, author: 'raricy', blogs: [{ id: 'b1', title: '一篇' }] }
        : {}
    );
    const r = new ContentRefResolver('expand');
    const f1 = favId(1);
    const f2 = favId(2);
    // 原文 ≈ 499918（未超预算），但一张卡片就有几百字符，两张都装不下
    const src = `${'z'.repeat(499900)} ${ref(f1)} ${ref(f2)}`;

    const out = await new ContentRefProcessor(r).preprocess(src);

    expect(out).not.toContain('favorite-embed');
    expect(out).toContain(ref(f1));
    expect(out).toContain(ref(f2));
  });
});

// ═══ 四、自引用 / 双向引用不递归（一轮到底，一层）════════════════════════════

describe('自引用 / 双向引用', () => {
  it('★ 剪贴板引用自己：只取一次、只展开一层，内层 token 保留 ★', async () => {
    const id = clipId(9);
    const calls = stubFetch(() => ({ clip: { content: `A 的正文 ${ref(id)}` } }));
    const r = new ContentRefResolver('expand');

    const out = await new ContentRefProcessor(r).preprocess(`A 的正文 ${ref(id)}`);

    expect(calls, '自引用不该反复请求').toHaveLength(1);
    expect(out).toContain('A 的正文 A 的正文'); // 展开一层后拼在一起
    expect(out, '内层 token 该保留字面量（单向往回走一遍，不重扫）').toContain(ref(id));
  });

  it('★ 两个剪贴板互相引用：看 A 时只取 B 一次，A→B→A 的内层不再展开 ★', async () => {
    const a = clipId(10);
    const b = clipId(11);
    const calls = stubFetch((url) =>
      url.includes(b) ? { clip: { content: `B 的正文 ${ref(a)}` } } : { clip: { content: 'x' } }
    );
    const r = new ContentRefResolver('expand');

    const out = await new ContentRefProcessor(r).preprocess(`A 的正文 ${ref(b)}`);

    expect(calls, '双向引用不该递归（只应取 B 一条）').toHaveLength(1);
    expect(out).toContain('B 的正文');
    expect(out, '展开进来的 A 引用不该被二次展开').toContain(ref(a));
  });
});
