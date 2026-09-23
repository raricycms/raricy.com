// ─────────────────────────────────────────────────────────────────────────────
// clipboard-refs.test.ts —— `resolvePublicClipRefs`：对外视图能拿到哪几条剪贴板
//
// 【为什么值得单测】它是**唯一**一处「匿名读者能看到哪位成员的剪贴板正文」的判定。
// 判错的形态是静默的：公开文章里多出别人的私有正文，页面照常渲染、谁也不报错，
// 只有把那条链接发给一个没登录的人才知道。
//
// 三个必须钉住的：
//   · ★ 私有档一条都不许漏出去 ★（`publicity=false` 是「只有本人和站长」，
//     比 core+ 更窄的一档，被引用进公开文章也不放宽）；
//   · 已软删 / 不存在的同形（都不出现，不区分 —— 区分等于确认存在性）；
//   · 一次调用最多查 MAX_BLOG_REF_ITEMS 条（这是服务端每个访客请求都要跑的路径，
//     没有上限时一篇塞满引用的文章就是一次几千条查询）。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeUser, prisma, resetDb } from '../helpers/db';
import { resolvePublicClipRefs } from '@/lib/clipboard-service';
import { MAX_BLOG_REF_ITEMS } from '@/lib/content-refs';
import { nowForDb } from '@/lib/db-time';

/** 造一条剪贴板（正文与可见性都可指定），返回它的 8 位 id。 */
async function makeClip(
  authorId: string,
  opts: { content?: string; publicity?: boolean; ignore?: boolean } = {}
): Promise<string> {
  const id = Math.random().toString(36).slice(2, 10);
  await prisma.clipBoard.create({
    data: {
      id,
      title: '引用用例',
      authorId,
      ignore: opts.ignore ?? false,
      publicity: opts.publicity ?? true,
      createdAt: nowForDb(),
      content: { create: { content: opts.content ?? '正文', updatedAt: nowForDb() } },
    },
  });
  return id;
}

const ref = (id: string) => `[@${id}]`;

// ⚠️ 必须 await：resetDb 是异步的（一串 DELETE）。裸调会让删除**与用例里的建行赛跑**
// —— 表现为同一个用例时而通过、时而少出一半结果（本文件真踩过：51 条只解析出 28 条）。
beforeEach(async () => {
  await resetDb();
});

describe('resolvePublicClipRefs', () => {
  it('公开档 → 拿到正文', async () => {
    const author = await makeUser({ username: 'clip-author-a', role: 'core' });
    const id = await makeClip(author.id, { content: '公开的正文' });

    const out = await resolvePublicClipRefs(`见 ${ref(id)} 谢谢`);
    expect(out).toEqual({ [id]: '公开的正文' });
  });

  it('★ 私有档 → 一条都不给 ★', async () => {
    const author = await makeUser({ username: 'clip-author-b', role: 'core' });
    const id = await makeClip(author.id, { content: '私有正文', publicity: false });

    const out = await resolvePublicClipRefs(`见 ${ref(id)}`);
    expect(out).toEqual({});
  });

  it('已软删 / 不存在的 id → 都不出现（同形，不区分）', async () => {
    const author = await makeUser({ username: 'clip-author-c', role: 'core' });
    const deleted = await makeClip(author.id, { content: '已删正文', ignore: true });
    const missing = 'zzzz9999';

    const out = await resolvePublicClipRefs(`${ref(deleted)} ${ref(missing)}`);
    expect(out).toEqual({});
  });

  it('没有引用 → 空表，且不碰库', async () => {
    const out = await resolvePublicClipRefs('普通正文，一个引用都没有');
    expect(out).toEqual({});
  });

  it('同一个 id 出现多次 → 只解析一次', async () => {
    const author = await makeUser({ username: 'clip-author-d', role: 'core' });
    const id = await makeClip(author.id, { content: '重复引用' });

    const out = await resolvePublicClipRefs(`${ref(id)} 和 ${ref(id)}`);
    expect(out).toEqual({ [id]: '重复引用' });
  });

  it('★ 代码块里的引用不解析（与渲染器同口径，指南承诺「代码里一律不展开」）★', async () => {
    const author = await makeUser({ username: 'clip-author-f', role: 'core' });
    const id = await makeClip(author.id, { content: '公开的正文' });
    const fenced = ['```', ref(id), '```'].join('\n');
    const inline = `写法是 \`${ref(id)}\``;

    expect(await resolvePublicClipRefs(fenced)).toEqual({});
    expect(await resolvePublicClipRefs(inline)).toEqual({});
    // 同一篇里既有围栏又有正文引用 → 只解析正文那处
    expect(await resolvePublicClipRefs([fenced, '', ref(id)].join('\n'))).toEqual({
      [id]: '公开的正文',
    });
  });

  it('只认严格形态的 id：下划线的伪 id 不进结果', async () => {
    // `\w` 会把 `[@________]` 当成 8 位 id —— 那条宽松形态是渲染器的分流，
    // 不是这里的。这里一个非 id 形态都不该被拿去查库。
    const out = await resolvePublicClipRefs('[@________] 与 [@ABCDEFGH]');
    expect(out).toEqual({});
  });

  it(`★ 一次最多解析 ${MAX_BLOG_REF_ITEMS} 条（按出现顺序，超出的不看）★`, async () => {
    const author = await makeUser({ username: 'clip-author-e', role: 'core' });
    const ids: string[] = [];
    for (let i = 0; i < MAX_BLOG_REF_ITEMS + 1; i += 1) {
      ids.push(await makeClip(author.id, { content: `第 ${i} 条` }));
    }

    const out = await resolvePublicClipRefs(ids.map(ref).join(' '));
    expect(Object.keys(out)).toHaveLength(MAX_BLOG_REF_ITEMS);
    expect(out[ids[0]]).toBe('第 0 条');
    expect(out, '第 51 条不该被解析').not.toHaveProperty(ids[MAX_BLOG_REF_ITEMS]);
  });
});
