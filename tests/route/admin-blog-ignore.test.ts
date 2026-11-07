// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/blogs/:id 的 {ignore} 分支 —— 管理员删文/恢复必须走三件套
//
// 【为什么单独测这个】R3-416：这个分支曾直接调 setBlogIgnore，于是 `{ignore:true}`
// 是「无痕软删」—— 不用填理由、不写 delete_blog 审计（/audit 公示页上查无此事）、
// 不通知作者；`{ignore:false}` 静默恢复也不写 restore_blog。而同一路由的 DELETE
// 三件套齐全：两条入口、两种行为，且缺的那条连测试都没有（删掉守卫不会变红）。
//
// 【修法与判据】ignore 分支转调 deleteBlogForAdmin / restoreBlog（与 DELETE、
// `npm run cli -- blog delete/restore` 同一份实现）。本文件打真实 handler
// （不 mock Prisma / service），只 mock 登录态；断言不只看状态码，还看**库里的行**：
// Blog.ignore、审计行数与通知行数 ——「返回 400 但文章已经被软删」这种半截实现
// 必须变红。
//
// 【为什么保留 PATCH 入口而不是删分支】restoreBlog 没有别的 HTTP 入口（全仓仅
// DELETE 路由与 CLI 用 deleteBlogForAdmin，恢复只有 CLI）。删掉 ignore 分支就等于
// 管理员失去网页恢复能力；PATCH 又是仓内零消费者、仓外使用者未知的既有接口
// （docs/ 未登记），留入口 + 补三件套是兼容代价最小的修法。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { token: undefined as string | undefined } }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'raricy_session' && session.token ? { name, value: session.token } : undefined,
    set: () => {},
  }),
}));

import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { createSessionToken } from '@/lib/session';
import { PATCH as patchAdminBlog } from '@/app/api/admin/blogs/[id]/route';

const login = async (userId: string, sv = 0) => {
  session.token = await createSessionToken({ uid: userId, sv });
};

/** Next 15 的 params 是 Promise。 */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown) =>
  new Request('http://localhost/api/admin/blogs/x', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await resetDb();
  session.token = undefined;
});

/** 管理员 + 作者 + 一篇正常文章。 */
async function seed() {
  const admin = await makeUser({ role: 'admin' });
  const author = await makeUser({ role: 'core' });
  const blog = await makeBlog({ authorId: author.id, title: '将被删除的文章' });
  return { admin, author, blog };
}

async function isIgnored(blogId: string): Promise<boolean> {
  const row = await prisma.blog.findUniqueOrThrow({
    where: { id: blogId },
    select: { ignore: true },
  });
  return row.ignore === true;
}

describe('PATCH {ignore:true} —— 缺理由必须 400，且什么都不发生', () => {
  it('不带 reason / reason 只有空白 → 400、文章未软删、无审计、无通知', async () => {
    const { admin, blog } = await seed();
    await login(admin.id);

    // 两种「没填理由」的形态：字段缺席、只有空格。deleteBlogForAdmin 的 trim 是
    // 唯一判据 —— 若路由自己先 Boolean(body.ignore) 就落库，这两种都会变成无痕删。
    for (const body of [{ ignore: true }, { ignore: true, reason: '   ' }]) {
      const res = await patchAdminBlog(patch(body), ctx(blog.id));
      expect(res.status, `${JSON.stringify(body)} 应 400`).toBe(400);
      const data = (await res.json()) as { message?: string };
      expect(data.message).toBe('请填写删除原因');
    }

    expect(await isIgnored(blog.id), '400 之后文章不许已经被软删').toBe(false);
    expect(await prisma.adminActionLog.count(), '不许留半条审计').toBe(0);
    expect(await prisma.notification.count(), '原因都没有，不该通知作者').toBe(0);
  });
});

describe('PATCH {ignore:true, reason} —— 三件套必须齐全', () => {
  it('软删 + 恰好 1 条 delete_blog 审计 + 作者收到 1 条通知', async () => {
    const { admin, author, blog } = await seed();
    await login(admin.id);

    const res = await patchAdminBlog(
      patch({ ignore: true, reason: '内容违规' }),
      ctx(blog.id)
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { code: number; blog?: { id: string; ignore: boolean } };
    expect(data.code).toBe(200);
    // 兼容：成功响应仍是 { blog: { id, ignore } }（旧调用方读的就是这两个字段）
    expect(data.blog?.id).toBe(blog.id);
    expect(data.blog?.ignore).toBe(true);

    expect(await isIgnored(blog.id), '文章应被软删').toBe(true);

    // 审计：恰好一条，且是网页端写的（visibility='public' → 进 /audit 公示页）。
    // 用 findMany 而不是 count 是为了同时钉住 adminId / target / reason —— 一条
    // 内容错位的日志等于没有日志。
    const logs = await prisma.adminActionLog.findMany({
      select: {
        action: true,
        adminId: true,
        targetUserId: true,
        objectType: true,
        objectId: true,
        reason: true,
        visibility: true,
      },
    });
    expect(logs, '管理端删文必须恰好留 1 条审计').toHaveLength(1);
    expect(logs[0]).toEqual({
      action: 'delete_blog',
      adminId: admin.id,
      targetUserId: author.id,
      objectType: 'blog',
      objectId: blog.id,
      reason: '内容违规',
      visibility: 'public',
    });

    // 通知：作者必须收到，且带得上理由（否则「被删了」是通知到了，「为什么」没有）
    const notes = await prisma.notification.findMany({
      select: {
        action: true,
        recipientId: true,
        actorId: true,
        objectType: true,
        objectId: true,
        detail: true,
      },
    });
    expect(notes, '作者必须收到 1 条删除通知').toHaveLength(1);
    expect(notes[0]).toMatchObject({
      action: '文章删除',
      recipientId: author.id,
      actorId: admin.id,
      objectType: 'blog',
      objectId: blog.id,
    });
    expect(notes[0].detail).toContain('内容违规');
    expect(notes[0].detail).toContain('将被删除的文章');
  });
});

describe('PATCH {ignore:false} —— 恢复必须写 restore_blog 审计', () => {
  it('带 reason：ignore 复位 + 1 条 restore_blog 审计', async () => {
    const { admin, author, blog } = await seed();
    await prisma.blog.update({ where: { id: blog.id }, data: { ignore: true } });
    await login(admin.id);

    const res = await patchAdminBlog(
      patch({ ignore: false, reason: '误删补回' }),
      ctx(blog.id)
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { code: number; blog?: { ignore: boolean } };
    expect(data.code).toBe(200);
    expect(data.blog?.ignore, '成功响应里 ignore=false').toBe(false);
    expect(await isIgnored(blog.id)).toBe(false);

    const logs = await prisma.adminActionLog.findMany({
      select: {
        action: true,
        adminId: true,
        targetUserId: true,
        objectType: true,
        objectId: true,
        reason: true,
        visibility: true,
      },
    });
    expect(logs, '恢复也要留 1 条审计').toHaveLength(1);
    expect(logs[0]).toEqual({
      action: 'restore_blog',
      adminId: admin.id,
      targetUserId: author.id,
      objectType: 'blog',
      objectId: blog.id,
      reason: '误删补回',
      visibility: 'public',
    });
  });

  it('不带 reason（旧调用方的 body 形态）→ 仍可恢复，审计 reason 为 null', async () => {
    // restoreBlog 的 reason 是**可选**参数（CLI `blog restore` 同理）。这条钉住的是：
    // 保留 PATCH 入口所承诺的兼容性 —— 旧的 `{ignore:false}` 调用不需要补 reason。
    const { admin, blog } = await seed();
    await prisma.blog.update({ where: { id: blog.id }, data: { ignore: true } });
    await login(admin.id);

    const res = await patchAdminBlog(patch({ ignore: false }), ctx(blog.id));
    expect(res.status).toBe(200);
    expect(await isIgnored(blog.id)).toBe(false);
    const log = await prisma.adminActionLog.findFirstOrThrow({
      where: { action: 'restore_blog' },
      select: { reason: true },
    });
    expect(log.reason, '没给理由就记 null，不编造').toBeNull();
  });
});

describe('PATCH 的字段口径 —— 多字段 / 字符串布尔', () => {
  it('★ 同时带两个可更新字段 → 400，且一个都不执行（不静默只做第一个）', async () => {
    const { admin, blog } = await seed();
    await login(admin.id);

    const res = await patchAdminBlog(
      patch({ isFeatured: true, categoryId: 1 }),
      ctx(blog.id)
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { message?: string };
    expect(data.message).toContain('一次只能更新一个字段');

    // 两个字段都必须**没生效**：精选没开、栏目没动
    const after = await prisma.blog.findUniqueOrThrow({
      where: { id: blog.id },
      select: { isFeatured: true, categoryId: true },
    });
    expect(after.isFeatured).toBe(false);
    expect(after.categoryId).toBeNull();
    expect(await prisma.adminActionLog.count()).toBe(0);
  });

  it('★ 字符串布尔 `"false"` → 400（Boolean("false") 是 true，会真的软删）', async () => {
    const { admin, blog } = await seed();
    await login(admin.id);

    for (const body of [{ ignore: 'false' }, { isFeatured: 'true' }]) {
      const res = await patchAdminBlog(patch(body), ctx(blog.id));
      expect(res.status, `${JSON.stringify(body)} 必须是 400`).toBe(400);
    }
    expect(await isIgnored(blog.id)).toBe(false);
    expect(await prisma.adminActionLog.count(), '被拒的请求不该留审计').toBe(0);
  });
});
