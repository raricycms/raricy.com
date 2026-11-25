import { resolveReadRender } from '@/lib/reactive/read-render';
// ─────────────────────────────────────────────────────────────────────────────
// content-format-integration.test.ts —— 正文格式的**写入闸门与落库/读出口**
//
// 2026-11 起库里没有 format 列：正文语言由正文自己决定。这一层最容易出的错仍是
// 静默的，所以这里同时钉三件事：
//   · 纯决策：请求里那个已废弃的 `format` 只校验白名单，不决定存储；
//   · service 层落库：含增强语法 → syntax_version 非 NULL，纯 Markdown → NULL；
//   · 读出口：对外 `format` 由 syntax_version 派生（详情 / 编辑页 / spider / 剪贴板）。
//
// 【为什么不是「纯单测」】syntax_version 是 Prisma select 的一部分，
// 只测纯函数会漏掉「忘了 select / 忘了写回」这一类；用真实测试库（db push 出 schema）。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeUser, prisma, resetDb } from '../helpers/db';
import {
  createBlog,
  getBlogDetail,
  getBlogForEdit,
  updateBlog,
  validateBlogData,
} from '@/lib/blog-service';
import { createClip, updateClip } from '@/lib/clipboard-service';
import { getClip } from '@/lib/clipboard-query';
import { getSpiderBlog } from '@/lib/spider-service';
import { nowForDb } from '@/lib/db-time';
import { LOCAL_SYNTAX_VERSION } from 'reactive-md';

const BLOG_BASE = { title: 'T', description: 'D', content: 'C' };
const REACTIVE_SOURCE = '<counter bind="n" label="N" initial="1" />';

beforeEach(async () => {
  await resetDb();
});

/** 直接造一条「增强语法」正文行（模拟历史存量：写入后手工标成旧语法版本）。 */
async function makeReactiveBlog(authorId: string): Promise<string> {
  const id = await createBlog(authorId, {
    ...BLOG_BASE,
    content: REACTIVE_SOURCE,
    categoryId: null,
    visibility: 'internal',
  });
  await prisma.blogContent.update({
    where: { blogId: id },
    data: { syntaxVersion: 'local-draft-2' },
  });
  return id;
}

async function makeReactiveClip(authorId: string): Promise<string> {
  // 必须是合法的 8 位剪贴板 id —— 引用分流按 id 长度判定。
  const id = 'react001';
  await prisma.clipBoard.create({
    data: {
      id,
      title: 'reactive 剪贴板',
      authorId,
      createdAt: nowForDb(),
      content: {
        create: {
          content: '# reactive 源码',
          syntaxVersion: 'local-draft-2',
          updatedAt: nowForDb(),
        },
      },
    },
  });
  return id;
}

// ── 1. 纯决策：请求里的 format 只校验，不落库 ────────────────────────────────
describe('validateBlogData —— 已废弃的 format 只校验白名单', () => {
  it('省略 format 不产生该键', async () => {
    const omitted = await validateBlogData({ ...BLOG_BASE });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect('format' in omitted.data).toBe(false);
  });

  it('★ 合法值被接受但**不进入**落库字段（正文语言由正文决定）★', async () => {
    for (const format of ['markdown', 'reactive']) {
      const explicit = await validateBlogData({ ...BLOG_BASE, format });
      expect(explicit.ok, format).toBe(true);
      if (explicit.ok) expect('format' in explicit.data).toBe(false);
    }
  });

  it('未知值仍 400，不静默接受', async () => {
    const bad = await validateBlogData({ ...BLOG_BASE, format: 'markdow' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('内容格式');
  });
});

// ── 2. 博客：落库、更新、读出口 ──────────────────────────────────────────────
describe('博客：syntax_version 落库 / 读出口派生 format', () => {
  it('新建纯 Markdown → syntax_version=null', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, { ...BLOG_BASE, categoryId: null, visibility: 'internal' });
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.syntaxVersion).toBeNull();
  });

  it('★ 正文含增强语法 → 自动按增强语法保存（不再要求调用方声明格式）★', async () => {
    const u = await makeUser();
    const v = await validateBlogData({
      ...BLOG_BASE,
      content: REACTIVE_SOURCE,
      // 显式声明 markdown 也不阻止：声明已废弃，正文自己说了算。
      format: 'markdown',
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const id = await createBlog(u.id, { ...v.data, categoryId: null, visibility: 'internal' });
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.content).toBe(REACTIVE_SOURCE);
    expect(row?.syntaxVersion).toBe(LOCAL_SYNTAX_VERSION);
  });

  // R3-101 复核：**不**拒绝旧版前导声明。旧版 RMD 原文必须可保存、可编辑（云剪贴板
  // 与博客的既有契约：原文不变、syntax_version 保持旧标记、阅读时按声明迁移）。
  // 收紧写入会让存量旧内容一编辑就 400，属破坏兼容；迁移责任在读路径。

  it('★ 绕过 HTTP 直接调 createBlog 写无法编译的正文 → 抛错且什么都不落库 ★', async () => {
    const u = await makeUser();
    await expect(
      createBlog(u.id, {
        ...BLOG_BASE,
        content: '{{ 1 + }}',
        categoryId: null,
        visibility: 'internal',
      })
    ).rejects.toThrow('正文无法编译渲染');
    expect(await prisma.blog.count()).toBe(0);
    expect(await prisma.blogContent.count()).toBe(0);
  });

  it('可恢复的增强正文保存原文，命中缓存后仍保留警告与后续章节', async () => {
    const u = await makeUser();
    const content = '<panel title="未闭合">\n\n片段 {{ missing }}\n\n## 后续章节\n\n正常正文';
    const blogId = await createBlog(u.id, {
      ...BLOG_BASE, content, categoryId: null, visibility: 'internal',
    });
    expect(await prisma.blogContent.findUnique({ where: { blogId } })).toMatchObject({
      content, syntaxVersion: LOCAL_SYNTAX_VERSION,
    });
    const input = { source: content, viewer: u, mode: 'expand' } as const;
    await resolveReadRender(input);
    const cached = await resolveReadRender(input);
    expect(cached.bundle?.cacheHit).toBe(true);
    expect(cached.bundle?.result).toMatchObject({
      ok: true,
      recoveries: [{ code: 'local.recovery.unclosed', boundary: 'heading' }],
      diagnostics: [{ code: 'local.recovery.unclosed', severity: 'warning' }],
      document: { nodes: expect.arrayContaining([expect.objectContaining({ type: 'heading' })]) },
    });
  });

  it('★ 半截增强按编译器结果处理：能恢复的保存为增强语法，解析不了的拒绝 ★', async () => {
    const u = await makeUser();
    // 解析器可恢复（未闭合标签）：保存为增强语法，渲染时带恢复警告。
    // 「声明 markdown 所以整篇拒绝」这一层已随 format 列退役 —— 没有声明就没有不匹配。
    const recovered = await createBlog(u.id, {
      ...BLOG_BASE,
      content: '<panel title="未闭合">',
      categoryId: null,
      visibility: 'internal',
    });
    expect(
      (await prisma.blogContent.findUniqueOrThrow({ where: { blogId: recovered } })).syntaxVersion
    ).toBe(LOCAL_SYNTAX_VERSION);

    // 解析不了：整篇拒绝，不落库。
    await expect(
      createBlog(u.id, {
        ...BLOG_BASE,
        content: '{{ 1 + }}',
        categoryId: null,
        visibility: 'internal',
      })
    ).rejects.toMatchObject({ code: 'content_unrenderable' });
    expect(await prisma.blog.count()).toBe(1);
  });

  it('超预算的未闭合标签正文被明确拒绝，不落库、不截断原文', async () => {
    const u = await makeUser();
    const content = '{{ '.repeat(30_000);
    await expect(
      createBlog(u.id, {
        ...BLOG_BASE,
        content,
        categoryId: null,
        visibility: 'internal',
      })
    ).rejects.toMatchObject({ code: 'content_unrenderable' });
    expect(await prisma.blog.count()).toBe(0);
    expect(await prisma.blogContent.count()).toBe(0);
  });

  it('只改标题不重编正文，syntax_version 原样保留', async () => {
    const u = await makeUser();
    const id = await makeReactiveBlog(u.id);

    const result = await updateBlog(
      id,
      { ...BLOG_BASE, content: REACTIVE_SOURCE, categoryId: null, visibility: 'internal' },
      u.id
    );
    expect(result.error).toBeUndefined();
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.syntaxVersion).toBe('local-draft-2');
  });

  it('更新：换成增强语法 → 落当前版本；改回纯 Markdown → 归 null', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, { ...BLOG_BASE, categoryId: null, visibility: 'internal' });

    const upgraded = await updateBlog(
      id,
      { ...BLOG_BASE, content: REACTIVE_SOURCE, categoryId: null, visibility: 'internal' },
      u.id
    );
    expect(upgraded.error).toBeUndefined();
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.content).toBe(REACTIVE_SOURCE);
    expect(row?.syntaxVersion).toBe(LOCAL_SYNTAX_VERSION);

    const downgraded = await updateBlog(
      id,
      { ...BLOG_BASE, content: '普通 markdown', categoryId: null, visibility: 'internal' },
      u.id
    );
    expect(downgraded.error).toBeUndefined();
    const after = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(after?.content).toBe('普通 markdown');
    expect(after?.syntaxVersion).toBeNull();
  });

  it('★ 更新写无法编译的正文 → 拒绝且正文不变 ★', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, {
      ...BLOG_BASE, content: '普通 Markdown', categoryId: null, visibility: 'internal',
    });
    const updated = await updateBlog(
      id,
      { ...BLOG_BASE, content: '{{ 1 + }}', categoryId: null, visibility: 'internal' },
      u.id
    );
    expect(updated.error).toBe('reactive_invalid');
    expect((await prisma.blogContent.findUniqueOrThrow({ where: { blogId: id } })).content).toBe('普通 Markdown');
  });

  it('读出口：详情不带 format 列，编辑页与 spider 的 format 由 syntax_version 派生', async () => {
    const u = await makeUser();
    const id = await makeReactiveBlog(u.id);
    await prisma.blog.update({ where: { id }, data: { rendererOverride: 'reactive' } });

    const detail = await getBlogDetail(id, { id: u.id, isCore: true });
    expect(detail?.content?.syntaxVersion).toBe('local-draft-2');
    expect(detail?.rendererOverride).toBe('reactive');

    const edit = await getBlogForEdit(id);
    expect(edit?.format).toBe('reactive');
    expect(edit?.syntaxVersion).toBe('local-draft-2');
    expect(edit?.rendererOverride).toBe('reactive');

    const spider = await getSpiderBlog(id);
    expect(spider?.meta.format).toBe('reactive');
    expect(spider?.meta.syntax_version).toBe('local-draft-2');
    expect(spider?.content).toBe(REACTIVE_SOURCE);
  });

  it('纯 Markdown 行在所有读出口都派生成 markdown', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, { ...BLOG_BASE, categoryId: null, visibility: 'internal' });

    expect((await getBlogForEdit(id))?.format).toBe('markdown');
    expect((await getSpiderBlog(id))?.meta.format).toBe('markdown');
  });
});

// ── 3. 剪贴板：落库、读出口 ─────────────────────────────────────────────────
describe('剪贴板：createClip / updateClip / getClip', () => {
  it('新建：纯 Markdown 为 null；含增强语法落版本；无法编译时整笔拒绝', async () => {
    const u = await makeUser();
    const ok = await createClip(u.id, { title: 't', content: 'c' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const row = await prisma.clipText.findUnique({ where: { clipId: ok.id } });
      expect(row?.syntaxVersion).toBeNull();
    }

    const reactive = await createClip(u.id, { title: 't', content: REACTIVE_SOURCE });
    expect(reactive.ok).toBe(true);
    if (reactive.ok) {
      const row = await prisma.clipText.findUnique({ where: { clipId: reactive.id } });
      expect(row?.syntaxVersion).toBe(LOCAL_SYNTAX_VERSION);
    }

    expect(await createClip(u.id, { title: 't', content: '{{ 1 + }}' })).toEqual({
      ok: false,
      reason: 'reactive_invalid',
    });
  });

  it('★ 剪贴板：解析不了的增强语法整笔拒绝；可恢复的按增强语法保存 ★', async () => {
    const u = await makeUser();
    expect(await createClip(u.id, { title: 't', content: '{{ 1 + }}' })).toEqual({
      ok: false,
      reason: 'reactive_invalid',
    });
    expect(await prisma.clipBoard.count()).toBe(0);

    const recovered = await createClip(u.id, { title: 't', content: '<panel title="未闭合">' });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(
        (await prisma.clipText.findUniqueOrThrow({ where: { clipId: recovered.id } })).syntaxVersion
      ).toBe(LOCAL_SYNTAX_VERSION);
    }
  });

  it('更新：正文变了就重编；只剩纯 Markdown 时 syntax_version 归 null', async () => {
    const u = await makeUser();
    const created = await createClip(u.id, { title: 't', content: '旧正文' });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(await updateClip(created.id, u.id, { title: 't2', content: '新正文', publicity: true })).toEqual({
        ok: true,
        id: created.id,
      });
      const row = await prisma.clipText.findUnique({ where: { clipId: created.id } });
      expect(row?.content).toBe('新正文');
      expect(row?.syntaxVersion).toBeNull();
    }

    const reactiveId = await makeReactiveClip(u.id);
    const edited = await updateClip(reactiveId, u.id, {
      title: 't',
      content: '# 改过的 reactive\n\n正文',
      publicity: true,
    });
    expect(edited).toEqual({ ok: true, id: reactiveId });
    const reactive = await prisma.clipText.findUnique({ where: { clipId: reactiveId } });
    expect(reactive?.content).toBe('# 改过的 reactive\n\n正文');
    expect(reactive?.syntaxVersion).toBeNull();

    expect(
      await updateClip(reactiveId, u.id, {
        title: 't',
        content: '{{ 1 + }}',
        publicity: true,
      })
    ).toEqual({ ok: false, reason: 'reactive_invalid' });
  });

  it('只改标题不重编：存量旧版本号原样保留', async () => {
    const u = await makeUser();
    const reactiveId = await makeReactiveClip(u.id);
    const row = await prisma.clipText.findUniqueOrThrow({ where: { clipId: reactiveId } });
    const edited = await updateClip(reactiveId, u.id, {
      title: '新标题',
      content: row.content,
      publicity: true,
    });
    expect(edited).toEqual({ ok: true, id: reactiveId });
    expect(
      (await prisma.clipText.findUniqueOrThrow({ where: { clipId: reactiveId } })).syntaxVersion
    ).toBe('local-draft-2');
  });

  it('getClip 把派生 format / syntaxVersion 一起交出', async () => {
    const u = await makeUser();
    const created = await createClip(u.id, { title: 't', content: 'c' });
    expect(created.ok).toBe(true);
    if (created.ok) {
      const got = await getClip(created.id);
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.clip.format).toBe('markdown');
        expect(got.clip.syntaxVersion).toBeNull();
      }
    }

    const reactiveId = await makeReactiveClip(u.id);
    const got = await getClip(reactiveId);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.clip.format).toBe('reactive');
      expect(got.clip.syntaxVersion).toBe('local-draft-2');
    }
  });

  it('剪贴板正文只有成员视图读得到（格式不影响可见性）', async () => {
    const u = await makeUser();
    const md = await createClip(u.id, { title: 'md 标题', content: 'md 正文' });
    expect(md.ok).toBe(true);
    if (!md.ok) return;
    const reactiveId = await makeReactiveClip(u.id);
    const member = await getClip(md.id, u.id);
    expect(member.ok && member.clip.content).toBe('md 正文');
    // 增强语法剪贴板读出来仍是源码 + 派生格式，由阅读路径决定怎么渲染。
    const reactive = await getClip(reactiveId, u.id);
    expect(reactive.ok && reactive.clip.format).toBe('reactive');
  });
});
