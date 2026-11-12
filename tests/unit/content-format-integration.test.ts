import { resolveReadRender } from '@/lib/reactive/read-render';
// ─────────────────────────────────────────────────────────────────────────────
// content-format-integration.test.ts —— 内容格式的**写入闸门与落库/读出口**
//
// 这一层最容易出的错全是静默的：
//   · 未知格式被当成 markdown → 把另一种语言的源码交给旧解析器；
//   · 更新省略 format → 把库里 reactive 的内容改写成 markdown，格式列还留在 reactive；
//   · reactive 写入「先落了正文再报错」→ 正文与格式只成功一半。
// 所以这里同时钉三件事：纯决策函数、service 层落库、读出口（含 spider DTO）。
//
// 【为什么不是「纯单测」】格式列是 DB 默认值与 Prisma select 的一部分，
// 只测纯函数会漏掉「忘了 select / 忘了写回」这一类；用真实测试库（db push 出 schema）。
// ─────────────────────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it } from 'vitest';
import { makeUser, prisma, resetDb } from '../helpers/db';
import {
  createBlog,
  getBlogDetail,
  getBlogForEdit,
  resolveBlogContentFormat,
  updateBlog,
  validateBlogData,
} from '@/lib/blog-service';
import {
  createClip,
  resolveClipContentFormat,
  updateClip,
} from '@/lib/clipboard-service';
import { getClip } from '@/lib/clipboard-query';
import { getSpiderBlog } from '@/lib/spider-service';
import { nowForDb } from '@/lib/db-time';
import { validateContentForPublish } from '@/lib/reactive/publish';
import { LOCAL_SYNTAX_VERSION } from 'reactive-md';

const BLOG_BASE = { title: 'T', description: 'D', content: 'C' };

beforeEach(async () => {
  await resetDb();
});

/** 直接造一条 reactive 正文行（本期没有开放的写入路径，只能这样准备存量）。 */
async function makeReactiveBlog(authorId: string): Promise<string> {
  const id = await createBlog(authorId, { ...BLOG_BASE, categoryId: null, visibility: 'internal' });
  await prisma.blogContent.update({
    where: { blogId: id },
    data: { format: 'reactive', syntaxVersion: 'local-draft-2' },
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
          format: 'reactive',
          syntaxVersion: 'local-draft-2',
          updatedAt: nowForDb(),
        },
      },
    },
  });
  return id;
}

// ── 1. 纯决策：写入闸门 ──────────────────────────────────────────────────────
describe('resolveBlogContentFormat / resolveClipContentFormat —— 写入闸门', () => {
  it('省略 format：新建默认 markdown，更新保留存量 markdown', () => {
    expect(resolveBlogContentFormat(undefined)).toEqual({ ok: true, format: 'markdown' });
    expect(resolveBlogContentFormat(undefined, 'markdown')).toEqual({ ok: true, format: 'markdown' });
    expect(resolveClipContentFormat(undefined)).toEqual({ ok: true, format: 'markdown' });
    expect(resolveClipContentFormat(undefined, 'markdown')).toEqual({ ok: true, format: 'markdown' });
  });

  it('省略 format 而存量是 reactive → 保留 reactive（不静默降级）', () => {
    expect(resolveBlogContentFormat(undefined, 'reactive')).toEqual({ ok: true, format: 'reactive' });
    expect(resolveClipContentFormat(undefined, 'reactive')).toEqual({ ok: true, format: 'reactive' });
  });

  it('显式 reactive → 允许（能否发布由 service 的编译+快照校验决定）', () => {
    expect(resolveBlogContentFormat('reactive')).toEqual({ ok: true, format: 'reactive' });
    expect(resolveClipContentFormat('reactive')).toEqual({ ok: true, format: 'reactive' });
  });

  it('显式 markdown 而存量是 reactive → 允许显式降级（不猜、不丢格式）', () => {
    expect(resolveBlogContentFormat('markdown', 'reactive')).toEqual({ ok: true, format: 'markdown' });
    expect(resolveClipContentFormat('markdown', 'reactive')).toEqual({ ok: true, format: 'markdown' });
  });

  it('★ 未知值一律拒绝，绝不猜成 markdown ★（请求值与存量值都算）', () => {
    expect(resolveBlogContentFormat(undefined, null)).toEqual({ ok: false, reason: 'invalid_format' });
    expect(resolveClipContentFormat(undefined, null)).toEqual({ ok: false, reason: 'invalid_format' });
    expect(resolveBlogContentFormat('markdow')).toEqual({ ok: false, reason: 'invalid_format' });
    expect(resolveBlogContentFormat(undefined, 'private')).toEqual({
      ok: false,
      reason: 'invalid_format',
    });
    expect(resolveClipContentFormat(null, 'markdown')).toEqual({
      ok: false,
      reason: 'invalid_format',
    });
    expect(resolveClipContentFormat(undefined, '')).toEqual({ ok: false, reason: 'invalid_format' });
  });
});

// ── 2. 博客：校验、落库、读出口 ──────────────────────────────────────────────
describe('博客格式：validateBlogData / 落库 / 读出口', () => {
  it('validateBlogData：省略 format 不产生该键；显式 markdown 原样带回；未知值 400', async () => {
    const omitted = await validateBlogData({ ...BLOG_BASE });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) expect('format' in omitted.data).toBe(false);

    const explicit = await validateBlogData({ ...BLOG_BASE, format: 'markdown' });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.data.format).toBe('markdown');

    const bad = await validateBlogData({ ...BLOG_BASE, format: 'markdow' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('内容格式');
  });

  it('新建默认写 format=markdown、syntaxVersion=null（显式落库，不靠列默认值）', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, { ...BLOG_BASE, categoryId: null, visibility: 'internal' });
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.format).toBe('markdown');
    expect(row?.syntaxVersion).toBeNull();
  });

  it('createBlog 写 reactive：保存正文与 syntaxVersion，不写快照', async () => {
    const u = await makeUser();
    const content = '# 标题\n\n正文 **加粗**';
    const id = await createBlog(u.id, {
      ...BLOG_BASE,
      content,
      categoryId: null,
      visibility: 'internal',
      format: 'reactive',
    });
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.format).toBe('reactive');
    expect(row?.syntaxVersion).toBe(LOCAL_SYNTAX_VERSION);
  });

  // R3-101 复核：**不**拒绝旧版前导声明。旧版 RMD 原文必须可保存、可编辑（云剪贴板
  // 与博客的既有契约：原文不变、syntax_version 保持旧标记、阅读时按声明迁移）。
  // 收紧写入会让存量旧内容一编辑就 400，属破坏兼容；迁移责任在读路径。
  it('带旧版前导声明的 reactive 正文仍可保存：原文与旧 syntax_version 原样保留', async () => {
    const u = await makeUser();
    const stale = '<!-- reactive-md: local-draft-2 -->\n\n正文';

    // 纯校验层：旧声明内容能通过发布校验
    expect(await validateContentForPublish({ content: stale, format: 'reactive' })).toMatchObject({
      ok: true,
    });

    const blogId = await createBlog(u.id, {
      ...BLOG_BASE,
      content: stale,
      categoryId: null,
      visibility: 'internal',
      format: 'reactive',
    });
    const blogRow = await prisma.blogContent.findUnique({ where: { blogId } });
    expect(blogRow?.content).toBe(stale);
    expect(blogRow?.syntaxVersion).toBe('local-draft-2');

    const clip = await createClip(u.id, { title: 't', content: stale, format: 'reactive' });
    expect(clip.ok).toBe(true);
    if (clip.ok) {
      const clipRow = await prisma.clipText.findUnique({ where: { clipId: clip.id } });
      expect(clipRow?.content).toBe(stale);
      expect(clipRow?.syntaxVersion).toBe('local-draft-2');
    }

    // 没有声明 / 当前版本声明的新内容写当前版本
    const current = '# 标题\n\n正文';
    const id = await createBlog(u.id, {
      ...BLOG_BASE,
      content: current,
      categoryId: null,
      visibility: 'internal',
      format: 'reactive',
    });
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.syntaxVersion).toBe(LOCAL_SYNTAX_VERSION);
  });

  it('历史 HTML 属性被净化后正文仍可读，并与交互组件一起发布', async () => {
    const u = await makeUser();
    const content = '<div style="color:red" class="legacy">红色正文</div>\n\n<counter bind="n" label="N" initial="2" />';
    const id = await createBlog(u.id, {
      ...BLOG_BASE, content, categoryId: null, visibility: 'internal', format: 'reactive',
    });
    const rendered = await resolveReadRender({ source: content, format: 'reactive', viewer: u, mode: 'expand' });
    if (!rendered.bundle?.result.ok) throw new Error('live compilation failed');
    const document = rendered.bundle.result.document;
    expect(JSON.stringify(document)).toContain('红色正文');
    expect(JSON.stringify(document)).not.toContain('color:red');
    expect(document.bindings.n).toBeDefined();
  });

  it('★ 绕过 HTTP 直接调 createBlog 写无法编译的 reactive → 抛错且什么都不落库 ★', async () => {
    const u = await makeUser();
    await expect(
      createBlog(u.id, {
        ...BLOG_BASE,
        content: '{{ 1 + }}',
        categoryId: null,
        visibility: 'internal',
        format: 'reactive',
      })
    ).rejects.toThrow('正文无法编译渲染');
    expect(await prisma.blog.count()).toBe(0);
    expect(await prisma.blogContent.count()).toBe(0);
  });

  it('可恢复的增强正文保存原文，命中缓存后仍保留警告与后续章节', async () => {
    const u = await makeUser();
    const content = '<panel title="未闭合">\n\n片段 {{ missing }}\n\n## 后续章节\n\n正常正文';
    const blogId = await createBlog(u.id, {
      ...BLOG_BASE, content, categoryId: null, visibility: 'internal', format: 'reactive',
    });
    expect(await prisma.blogContent.findUnique({ where: { blogId } })).toMatchObject({
      content, format: 'reactive', syntaxVersion: LOCAL_SYNTAX_VERSION,
    });
    const input = { source: content, format: 'reactive', viewer: u, mode: 'expand' } as const;
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

  it('★ 有效增强语法却写 markdown → 具名格式不匹配，不落库 ★', async () => {
    const u = await makeUser();
    await expect(
      createBlog(u.id, {
        ...BLOG_BASE,
        content: '<counter bind="n" label="N" initial="1" />',
        categoryId: null,
        visibility: 'internal',
        format: 'markdown',
      })
    ).rejects.toMatchObject({ code: 'content_format_mismatch' });
    expect(await prisma.blog.count()).toBe(0);

    const id = await createBlog(u.id, {
      ...BLOG_BASE, content: '普通 Markdown', categoryId: null, visibility: 'internal',
    });
    const updated = await updateBlog(
      id,
      {
        ...BLOG_BASE,
        content: '<counter bind="n" label="N" initial="1" />',
        categoryId: null,
        visibility: 'internal',
        format: 'markdown',
      },
      u.id
    );
    expect(updated.error).toBe('format_mismatch');
    expect((await prisma.blogContent.findUniqueOrThrow({ where: { blogId: id } })).content).toBe('普通 Markdown');
  });

  it('★ markdown 格式的 invalid-enhanced 也不能被字面化后接受 ★', async () => {
    const u = await makeUser();
    for (const content of [
      '<panel title="未闭合">',
      '{{ 1 + }}',
      // 半截增强：解析器还没认出结构、但诊断位置已指向已知组件 / 未闭合插值。
      '<panel title="x"',
      '文字 {{ 未闭合',
      '<section color="#000"',
    ]) {
      await expect(
        createBlog(u.id, {
          ...BLOG_BASE,
          content,
          categoryId: null,
          visibility: 'internal',
          format: 'markdown',
        })
      ).rejects.toMatchObject({ code: 'content_format_mismatch' });
    }
    expect(await prisma.blog.count()).toBe(0);
  });

  it('超预算的未闭合标签正文被明确拒绝，不落库、不截断原文', async () => {
    const u = await makeUser();
    const content = '<'.repeat(250_000);
    await expect(
      createBlog(u.id, {
        ...BLOG_BASE,
        content,
        categoryId: null,
        visibility: 'internal',
        format: 'markdown',
      })
    ).rejects.toMatchObject({ code: 'content_unrenderable' });
    expect(await prisma.blog.count()).toBe(0);
    expect(await prisma.blogContent.count()).toBe(0);
  });

  it('未知普通标签的历史 Markdown 仍可保存（不被误判成增强语法）', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, {
      ...BLOG_BASE,
      content: `<TAB>教程占位</TAB>

普通正文`,
      categoryId: null,
      visibility: 'internal',
      format: 'markdown',
    });
    expect((await prisma.blogContent.findUniqueOrThrow({ where: { blogId: id } })).format).toBe('markdown');
  });

  it('更新省略 format → 保留库里原值（markdown 仍是 markdown）', async () => {
    const u = await makeUser();
    const id = await createBlog(u.id, { ...BLOG_BASE, categoryId: null, visibility: 'internal' });

    const result = await updateBlog(
      id,
      { ...BLOG_BASE, content: '新正文', categoryId: null, visibility: 'internal' },
      u.id
    );
    expect(result.error).toBeUndefined();
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.content).toBe('新正文');
    expect(row?.format).toBe('markdown');
  });

  it('更新 reactive → 更新原文、不写快照；改回 markdown 也允许（显式）', async () => {
    const u = await makeUser();
    const id = await makeReactiveBlog(u.id);

    const result = await updateBlog(
      id,
      {
        ...BLOG_BASE,
        content: '# 新 reactive\n\n正文',
        categoryId: null,
        visibility: 'internal',
        format: 'reactive',
      },
      u.id
    );
    expect(result.error).toBeUndefined();
    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.content).toBe('# 新 reactive\n\n正文');
    expect(row?.format).toBe('reactive');
    expect(row?.syntaxVersion).toBe('local-draft-3');

    const downgraded = await updateBlog(
      id,
      { ...BLOG_BASE, content: '普通 markdown', categoryId: null, visibility: 'internal', format: 'markdown' },
      u.id
    );
    expect(downgraded.error).toBeUndefined();
    const after = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(after?.format).toBe('markdown');
    expect(after?.syntaxVersion).toBeNull();
  });

  it('读出口带 format / syntaxVersion / rendererOverride（详情与编辑页同源）', async () => {
    const u = await makeUser();
    const id = await makeReactiveBlog(u.id);
    await prisma.blog.update({ where: { id }, data: { rendererOverride: 'reactive' } });

    const detail = await getBlogDetail(id, { id: u.id, isCore: true });
    expect(detail?.content?.format).toBe('reactive');
    expect(detail?.content?.syntaxVersion).toBe('local-draft-2');
    expect(detail?.rendererOverride).toBe('reactive');

    const edit = await getBlogForEdit(id);
    expect(edit?.format).toBe('reactive');
    expect(edit?.syntaxVersion).toBe('local-draft-2');
    expect(edit?.rendererOverride).toBe('reactive');
  });

  it('spider DTO：format / syntax_version 与 content 源码一起出，未知值给 null', async () => {
    const u = await makeUser();
    const id = await makeReactiveBlog(u.id);
    const spider = await getSpiderBlog(id);
    expect(spider?.meta.format).toBe('reactive');
    expect(spider?.meta.syntax_version).toBe('local-draft-2');
    expect(spider?.content).toBe('C');

    await prisma.blogContent.update({ where: { blogId: id }, data: { format: 'weird' } });
    const dirty = await getSpiderBlog(id);
    expect(dirty?.meta.format, '未知格式不能冒充 markdown').toBeNull();
  });
});

// ── 3. 剪贴板：落库、读出口 ─────────────────────────────────────────────────
describe('剪贴板格式：createClip / updateClip / getClip', () => {
  it('新建默认 markdown；显式 reactive 只保存源码；无法编译时整笔拒绝', async () => {
    const u = await makeUser();
    const ok = await createClip(u.id, { title: 't', content: 'c' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const row = await prisma.clipText.findUnique({ where: { clipId: ok.id } });
      expect(row?.format).toBe('markdown');
      expect(row?.syntaxVersion).toBeNull();
    }

    const reactive = await createClip(u.id, { title: 't', content: '# reactive', format: 'reactive' });
    expect(reactive.ok).toBe(true);
    if (reactive.ok) {
      const row = await prisma.clipText.findUnique({ where: { clipId: reactive.id } });
      expect(row?.format).toBe('reactive');
      expect(row?.syntaxVersion).toBe('local-draft-3');
    }

    expect(
      await createClip(u.id, { title: 't', content: '{{ 1 + }}', format: 'reactive' })
    ).toEqual({ ok: false, reason: 'reactive_invalid' });
  });

  it('★ 剪贴板：有效增强语法却写 markdown → format_mismatch ★', async () => {
    const u = await makeUser();
    const result = await createClip(u.id, {
      title: 't',
      content: '<counter bind="n" label="N" initial="1" />',
      format: 'markdown',
    });
    expect(result).toEqual({ ok: false, reason: 'format_mismatch' });
    expect(await prisma.clipBoard.count()).toBe(0);
  });

  it('★ 剪贴板 markdown 的 invalid-enhanced / 半截增强也拒绝 ★', async () => {
    const u = await makeUser();
    for (const content of ['<panel title="未闭合">', '<panel title="x"', '文字 {{ 未闭合']) {
      const result = await createClip(u.id, {
        title: 't',
        content,
        format: 'markdown',
      });
      expect(result, content).toEqual({ ok: false, reason: 'format_mismatch' });
    }
    expect(await prisma.clipBoard.count()).toBe(0);
  });

  it('更新省略 format → 保留原格式；存量 reactive → 拒绝且正文不变', async () => {
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
      expect(row?.format).toBe('markdown');
    }

    const reactiveId = await makeReactiveClip(u.id);
    const edited = await updateClip(reactiveId, u.id, {
      title: 't',
      content: '# 改过的 reactive\n\n正文',
      publicity: true,
      format: 'reactive',
    });
    expect(edited).toEqual({ ok: true, id: reactiveId });
    const reactive = await prisma.clipText.findUnique({ where: { clipId: reactiveId } });
    expect(reactive?.content).toBe('# 改过的 reactive\n\n正文');
    expect(reactive?.format).toBe('reactive');
    expect(reactive?.syntaxVersion).toBe('local-draft-3');

    expect(
      await updateClip(reactiveId, u.id, {
        title: 't',
        content: '{{ 1 + }}',
        publicity: true,
        format: 'reactive',
      })
    ).toEqual({ ok: false, reason: 'reactive_invalid' });
  });

  it('getClip 把 format / syntaxVersion 一起交出；未知存量值给 null', async () => {
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

    const dirty = await makeReactiveClip(u.id);
    await prisma.clipText.update({ where: { clipId: dirty }, data: { format: 'weird' } });
    const got = await getClip(dirty);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.clip.format, '未知值不能猜成 markdown').toBeNull();
  });

  it('所有格式的站内剪贴板均只有成员视图读得到正文', async () => {
    const u = await makeUser();
    const md = await createClip(u.id, { title: 'md 标题', content: 'md 正文' });
    expect(md.ok).toBe(true);
    if (!md.ok) return;
    const reactiveId = await makeReactiveClip(u.id);
    const member = await getClip(md.id, u.id);
    expect(member.ok && member.clip.content).toBe('md 正文');
    // reactive 剪贴板读出来仍是源码 + 自己的格式，由阅读路径决定怎么渲染。
    const reactive = await getClip(reactiveId, u.id);
    expect(reactive.ok && reactive.clip.format).toBe('reactive');
  });
});

describe('普通作者的键名示例（vimtutor 类正文）', () => {
  it('大小写键名 / 命令范围按 Markdown 保存，不触发 invalid-enhanced', async () => {
    const u = await makeUser();
    const content = [
      'Press <ESC> then :q! <ENTER>.',
      'Press <TAB>.',
      'Press <tab>.',
      '<Help> / <F1>',
      '箭头示意 < h l >',
      "命令范围 :'<,'>",
    ].join('\n\n');
    const id = await createBlog(u.id, {
      ...BLOG_BASE,
      content,
      categoryId: null,
      visibility: 'internal',
      format: 'markdown',
    });
    const row = await prisma.blogContent.findUniqueOrThrow({ where: { blogId: id } });
    expect(row.format).toBe('markdown');
    expect(row.syntaxVersion).toBeNull();
    expect(row.content).toBe(content);
  });
});
