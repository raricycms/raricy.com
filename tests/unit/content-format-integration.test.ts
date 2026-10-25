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
  getClip,
  resolveClipContentFormat,
  resolvePublicClipRefs,
  updateClip,
} from '@/lib/clipboard-service';
import { getSpiderBlog } from '@/lib/spider-service';
import { nowForDb } from '@/lib/db-time';

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
  // 必须是合法的 8 位剪贴板 id —— resolvePublicClipRefs 只认这个长度。
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

  it('★ 省略 format 而存量是 reactive → 拒绝 ★（否则会把源码按 markdown 改写而格式列不动）', () => {
    expect(resolveBlogContentFormat(undefined, 'reactive')).toEqual({
      ok: false,
      reason: 'reactive_not_ready',
    });
    expect(resolveClipContentFormat(undefined, 'reactive')).toEqual({
      ok: false,
      reason: 'reactive_not_ready',
    });
  });

  it('★ 显式 reactive → 拒绝 ★（本期写入整体关闭）', () => {
    expect(resolveBlogContentFormat('reactive')).toEqual({
      ok: false,
      reason: 'reactive_not_ready',
    });
    expect(resolveClipContentFormat('reactive')).toEqual({
      ok: false,
      reason: 'reactive_not_ready',
    });
  });

  it('★ 显式 markdown 而存量是 reactive 也拒绝 ★（不做未实现的「降级转换」）', () => {
    expect(resolveBlogContentFormat('markdown', 'reactive')).toEqual({
      ok: false,
      reason: 'reactive_not_ready',
    });
    expect(resolveClipContentFormat('markdown', 'reactive')).toEqual({
      ok: false,
      reason: 'reactive_not_ready',
    });
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

  it('★ 绕过 HTTP 直接调 createBlog 写 reactive → 抛错且不落库 ★', async () => {
    const u = await makeUser();
    await expect(
      createBlog(u.id, {
        ...BLOG_BASE,
        categoryId: null,
        visibility: 'internal',
        format: 'reactive',
      })
    ).rejects.toThrow('ReactiveMD 内容暂未开放写入');
    expect(await prisma.blog.count()).toBe(0);
    expect(await prisma.blogContent.count()).toBe(0);
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

  it('★ 存量 reactive 的任何更新都被拒，且正文一个字都没变 ★', async () => {
    const u = await makeUser();
    const id = await makeReactiveBlog(u.id);

    const result = await updateBlog(
      id,
      { ...BLOG_BASE, content: '想改成 markdown', categoryId: null, visibility: 'internal' },
      u.id
    );
    expect(result).toEqual({ hasChanges: false, changesDetail: [], error: 'reactive_not_ready' });

    const row = await prisma.blogContent.findUnique({ where: { blogId: id } });
    expect(row?.content, '被拒的写入不得留下半份结果').toBe('C');
    expect(row?.format).toBe('reactive');
    expect(row?.syntaxVersion).toBe('local-draft-2');
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

// ── 3. 剪贴板：落库、读出口、对外解析 ────────────────────────────────────────
describe('剪贴板格式：createClip / updateClip / getClip / resolvePublicClipRefs', () => {
  it('新建默认 markdown；显式 reactive 被拒且不落库', async () => {
    const u = await makeUser();
    const ok = await createClip(u.id, { title: 't', content: 'c' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const row = await prisma.clipText.findUnique({ where: { clipId: ok.id } });
      expect(row?.format).toBe('markdown');
      expect(row?.syntaxVersion).toBeNull();
    }

    expect(await createClip(u.id, { title: 't', content: 'c', format: 'reactive' })).toEqual({
      ok: false,
      reason: 'reactive_not_ready',
    });
    expect(await prisma.clipBoard.count({ where: { authorId: u.id } }), '被拒的创建不得留下元信息行').toBe(1);
    expect(await prisma.clipText.count({ where: { format: 'reactive' } })).toBe(0);
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
    expect(await updateClip(reactiveId, u.id, { title: 't', content: '改掉', publicity: true })).toEqual({
      ok: false,
      reason: 'reactive_not_ready',
    });
    const reactive = await prisma.clipText.findUnique({ where: { clipId: reactiveId } });
    expect(reactive?.content).toBe('# reactive 源码');
    expect(reactive?.format).toBe('reactive');
    expect(reactive?.syntaxVersion).toBe('local-draft-2');
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

  it('resolvePublicClipRefs 返回结构化数据；reactive 带源码但格式标明，未知值不进表', async () => {
    const u = await makeUser();
    const md = await createClip(u.id, { title: 'md 标题', content: 'md 正文' });
    expect(md.ok).toBe(true);
    if (!md.ok) return;
    const reactiveId = await makeReactiveClip(u.id);

    const out = await resolvePublicClipRefs(`[@${md.id}] 与 [@${reactiveId}]`);
    expect(out[md.id]).toMatchObject({
      content: 'md 正文',
      format: 'markdown',
      title: 'md 标题',
    });
    expect(typeof out[md.id].version).toBe('string');
    const member = await getClip(md.id, u.id);
    expect(member.ok && member.clip.version).toBe(out[md.id].version);
    await updateClip(md.id, u.id, { title: 'md 标题', content: 'edited body', publicity: true });
    const refreshed = await resolvePublicClipRefs(`[@${md.id}]`);
    expect(refreshed[md.id].version).not.toBe(out[md.id].version);
    expect(out[reactiveId]).toMatchObject({ content: '# reactive 源码', format: 'reactive' });

    // 未知格式：不下发（调用方保留字面量），绝不冒充 markdown。
    await prisma.clipText.update({ where: { clipId: md.id }, data: { format: 'weird' } });
    const out2 = await resolvePublicClipRefs(`[@${md.id}]`);
    expect(out2).toEqual({});
  });
});
