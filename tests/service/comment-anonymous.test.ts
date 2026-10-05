// 匿名评论（化名）—— comment-service 的匿名路径
//
// 【为什么单独一份】匿名是一条**承诺**，靠四件必须同时成立的事实现：
//   1. 署名换成化名（且真 id 不下发 —— 否则 /u/<id> 一点就认出来了）；
//   2. 同一人同一篇恒定同名、不同人必不同名（blog_anon_identities + 发号器）；
//   3. 通知与审计日志**不能**把真身漏出去；
//   4. 作者本人仍然删得掉自己的评论。
// 任何一条破了都不报错 —— 页面照常渲染，只是匿名不再是匿名。
// 名字表本身的边界（Alice / Angry Alice / You Win #677）在
// tests/unit/anon-identity.test.ts。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { listCommentsForBlog, createComment, softDeleteComment } from '@/lib/comment-service';

beforeEach(async () => {
  await resetDb();
});

async function seedBlog() {
  const author = await makeUser({ role: 'core' });
  const blog = await makeBlog({ authorId: author.id });
  return { author, blog };
}

describe('匿名评论：化名分配', () => {
  it('署名是化名，author.id / is_admin / frame_url 全被抹掉', async () => {
    const { blog } = await seedBlog();
    const commenter = await makeUser({ role: 'admin' }); // 管理员发匿名也不该露身份

    const r = await createComment({
      blogId: blog.id,
      authorId: commenter.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');

    expect(r.comment.anonymous).toBe(true);
    expect(r.comment.author.username).toBe('Alice');
    expect(r.comment.author.id, '真 id 一落地，/u/<id> 就把人认出来了').toBeNull();
    expect(r.comment.author.is_admin, '管理员发匿名不该被标出来').toBe(false);
    expect(r.comment.author.frame_url, '头像框也是身份指纹').toBeNull();
    expect(r.comment.author.avatar_url).toContain('/api/avatar/anon~');
  });

  it('同一人在同一篇文章下多次匿名 → 化名恒定', async () => {
    const { blog } = await seedBlog();
    const u = await makeUser({ role: 'core' });

    const a = await createComment({ blogId: blog.id, authorId: u.id, content: '1', anonymous: true });
    const b = await createComment({ blogId: blog.id, authorId: u.id, content: '2', anonymous: true });
    if (!a.ok || !b.ok) throw new Error('前置失败');

    expect(a.comment.author.username).toBe('Alice');
    expect(b.comment.author.username, '同一个人第二次匿名必须还是 Alice').toBe('Alice');
  });

  it('不同人按首次匿名评论的先后拿号：Alice → Bob → Carol', async () => {
    const { blog } = await seedBlog();
    const u1 = await makeUser({ role: 'core' });
    const u2 = await makeUser({ role: 'core' });
    const u3 = await makeUser({ role: 'core' });

    const c1 = await createComment({ blogId: blog.id, authorId: u2.id, content: 'x', anonymous: true });
    const c2 = await createComment({ blogId: blog.id, authorId: u1.id, content: 'x', anonymous: true });
    const c3 = await createComment({ blogId: blog.id, authorId: u3.id, content: 'x', anonymous: true });
    if (!c1.ok || !c2.ok || !c3.ok) throw new Error('前置失败');

    // 顺序按「谁先匿名评论」，与用户 id 大小、注册先后都无关
    expect(c1.comment.author.username).toBe('Alice');
    expect(c2.comment.author.username).toBe('Bob');
    expect(c3.comment.author.username).toBe('Carol');
  });

  it('实名评论不占号（号只发给匿名的人）', async () => {
    const { blog } = await seedBlog();
    const u1 = await makeUser({ role: 'core' });
    const u2 = await makeUser({ role: 'core' });

    await createComment({ blogId: blog.id, authorId: u1.id, content: '实名' });
    const anon = await createComment({
      blogId: blog.id,
      authorId: u2.id,
      content: '匿名',
      anonymous: true,
    });
    if (!anon.ok) throw new Error('前置失败');

    expect(anon.comment.author.username, '实名那条不该把 Alice 抢走').toBe('Alice');
  });

  it('化名按文章隔离：同一个人在两篇文章里都从 Alice 开始', async () => {
    const a = await seedBlog();
    const b = await seedBlog();
    const u = await makeUser({ role: 'core' });

    const ca = await createComment({ blogId: a.blog.id, authorId: u.id, content: 'x', anonymous: true });
    const cb = await createComment({ blogId: b.blog.id, authorId: u.id, content: 'x', anonymous: true });
    if (!ca.ok || !cb.ok) throw new Error('前置失败');

    expect(ca.comment.author.username).toBe('Alice');
    expect(cb.comment.author.username).toBe('Alice');
  });

  it('化名不会跨文章被关联：同一个人在两篇里都是 Alice，头像却各自按化名算', async () => {
    const a = await seedBlog();
    const u = await makeUser({ role: 'core' });
    const r = await createComment({
      blogId: a.blog.id,
      authorId: u.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');
    // 头像种子只吃化名 —— 所以**不**含真实 id 的任何可关联痕迹
    expect(r.comment.author.avatar_url ?? '').not.toContain(u.id);
  });

  it('is_mine 按查看者算：本人 true、别人 false（匿名也一样）', async () => {
    const { blog } = await seedBlog();
    const me = await makeUser({ role: 'core' });
    const other = await makeUser({ role: 'core' });

    const r = await createComment({
      blogId: blog.id,
      authorId: me.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');

    const mineList = await listCommentsForBlog(blog.id, me.id);
    const otherList = await listCommentsForBlog(blog.id, other.id);
    expect(mineList[0].is_mine, '匿名作者必须删得掉自己的评论').toBe(true);
    expect(otherList[0].is_mine).toBe(false);
    expect(otherList[0].author.id, '别人拿到的仍是化名 + 无 id').toBeNull();
  });

  it('anonSeq 落库、且与化名一致；真身仍落在 author_id 上', async () => {
    const { blog } = await seedBlog();
    const u = await makeUser({ role: 'core' });
    const r = await createComment({
      blogId: blog.id,
      authorId: u.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');

    const row = await prisma.blogComment.findUnique({
      where: { id: r.comment.id },
      select: { anonSeq: true, authorId: true },
    });
    expect(row?.anonSeq).toBe(1);
    expect(row?.authorId, '删除日志与申诉要用真身').toBe(u.id);
  });
});

describe('匿名评论：服务端闸门（作者可关）', () => {
  it('作者关掉后，匿名提交被拒（接口才是边界，前端藏按钮不算）', async () => {
    const owner = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: owner.id, allowAnonymousComments: false });
    const commenter = await makeUser({ role: 'core' });

    const r = await createComment({
      blogId: blog.id,
      authorId: commenter.id,
      content: 'x',
      anonymous: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('不该成功');
    expect(r.error).toBe('anonymousDisabled');

    // 同一个人**实名**评论仍然可以 —— 关的是匿名，不是评论
    const real = await createComment({ blogId: blog.id, authorId: commenter.id, content: 'x' });
    expect(real.ok).toBe(true);
  });

  it('默认允许（列默认值 true，存量文章一律如此）', async () => {
    const { blog } = await seedBlog();
    const u = await makeUser({ role: 'core' });
    const r = await createComment({
      blogId: blog.id,
      authorId: u.id,
      content: 'x',
      anonymous: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe('匿名评论：不许从通知里漏出真身', () => {
  it('匿名回复 → 通知 actorId 为 null，改为在正文里交代化名', async () => {
    const { blog } = await seedBlog();
    const target = await makeUser({ role: 'core' });
    const anon = await makeUser({ role: 'core' });

    const parent = await createComment({ blogId: blog.id, authorId: target.id, content: '父' });
    if (!parent.ok) throw new Error('前置失败');
    // 清掉父评论产生的「文章评论」通知，只观察回复那条
    await prisma.notification.deleteMany({});

    const reply = await createComment({
      blogId: blog.id,
      authorId: anon.id,
      content: '回复',
      parentId: parent.comment.id,
      anonymous: true,
    });
    if (!reply.ok) throw new Error('前置失败');

    const n = await prisma.notification.findFirst({ where: { recipientId: target.id } });
    expect(n, '回复仍要通知到人（不能静默）').toBeTruthy();
    expect(n!.actorId, 'actorId 一落地，收件人点开就是真名 + /u/<id>').toBeNull();
    expect(n!.detail).toContain('Alice');
    expect(n!.detail ?? '', '正文里绝不能出现真实用户名').not.toContain(anon.username);
  });

  it('匿名顶层评论 → 也不把 actorId 交给文章作者', async () => {
    const { author, blog } = await seedBlog();
    const anon = await makeUser({ role: 'core' });

    const r = await createComment({
      blogId: blog.id,
      authorId: anon.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');

    const n = await prisma.notification.findFirst({ where: { recipientId: author.id } });
    expect(n).toBeTruthy();
    expect(n!.actorId).toBeNull();
    expect(n!.detail ?? '').not.toContain(anon.username);
  });
});

describe('匿名评论：删除日志留真身、公示面不留', () => {
  it('管理员删匿名评论 → 日志 targetUserId 是真身，且标了 hideTarget', async () => {
    const { blog } = await seedBlog();
    const anon = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });

    const r = await createComment({
      blogId: blog.id,
      authorId: anon.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');

    const del = await softDeleteComment(r.comment.id, { id: admin.id, role: 'admin' }, '违规');
    expect(del.ok).toBe(true);

    const log = await prisma.adminActionLog.findFirst({
      where: { action: 'delete_comment', objectId: r.comment.id },
      select: { targetUserId: true, hideTarget: true, visibility: true },
    });
    expect(log, '★ 需求：管理员能从日志里查到原作者').toBeTruthy();
    expect(log!.targetUserId).toBe(anon.id);
    expect(log!.hideTarget, '公示面必须抹掉当事人（/audit 是 core+ 都能看的）').toBe(true);
    expect(log!.visibility, '日志本身照旧公示，当事人仍可申诉').toBe('public');
  });

  it('实名评论被删的日志不带 hideTarget（回归：别一刀切）', async () => {
    const { blog } = await seedBlog();
    const u = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });

    const r = await createComment({ blogId: blog.id, authorId: u.id, content: 'x' });
    if (!r.ok) throw new Error('前置失败');
    await softDeleteComment(r.comment.id, { id: admin.id, role: 'admin' }, '违规');

    const log = await prisma.adminActionLog.findFirst({
      where: { action: 'delete_comment', objectId: r.comment.id },
      select: { hideTarget: true },
    });
    expect(log!.hideTarget).toBe(false);
  });

  it('作者自己删匿名评论 → 不写公示日志（作者删自己的不进 /audit）', async () => {
    const { blog } = await seedBlog();
    const u = await makeUser({ role: 'core' });

    const r = await createComment({
      blogId: blog.id,
      authorId: u.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');

    const del = await softDeleteComment(r.comment.id, { id: u.id, role: 'core' });
    expect(del.ok, '匿名作者必须删得掉自己的评论').toBe(true);
    expect(await prisma.adminActionLog.count({ where: { objectId: r.comment.id } })).toBe(0);
  });
});

// ── 公示面与个人主页：真身一个都不许露 ──────────────────────────────────────
// 上面那条删的是「服务端把 hideTarget 写进日志了」；这里删的是「读口把当事人交出去了」。
// 两件事分开测，因为它们是两条独立的代码路径 —— 只写不抹，页面照样把真名印出来。

describe('匿名评论：公示面（/audit 与 GET /api/audit 的共同读口）不交当事人', () => {
  it('listPublicLogs：匿名评论的处置日志 targetUser 为 null', async () => {
    const { listPublicLogs } = await import('@/lib/audit-service');
    const { blog } = await seedBlog();
    const anon = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });

    const r = await createComment({ blogId: blog.id, authorId: anon.id, content: 'x', anonymous: true });
    if (!r.ok) throw new Error('前置失败');
    await softDeleteComment(r.comment.id, { id: admin.id, role: 'admin' }, '违规');

    const { items } = await listPublicLogs({ action: 'delete_comment' });
    const row = items.find((i) => i.object?.id === r.comment.id);
    expect(row, '日志本身照旧出现在公示页（透明性不能被匿名吃掉）').toBeTruthy();
    expect(row!.targetUser, '匿名被删者的用户名不能出现在公示里').toBeNull();
  });

  it('getLogDetail：详情页同样抹掉（连 id 一起 —— /u/<id> 是可达的）', async () => {
    const { getLogDetail } = await import('@/lib/audit-service');
    const { blog } = await seedBlog();
    const anon = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });

    const r = await createComment({ blogId: blog.id, authorId: anon.id, content: 'x', anonymous: true });
    if (!r.ok) throw new Error('前置失败');
    await softDeleteComment(r.comment.id, { id: admin.id, role: 'admin' }, '违规');
    const logRow = await prisma.adminActionLog.findFirst({
      where: { objectId: r.comment.id },
      select: { id: true },
    });

    const detail = await getLogDetail(logRow!.id);
    expect(detail).toBeTruthy();
    expect(detail!.targetUserId).toBeNull();
    expect(detail!.targetUserName).toBeNull();
    expect(detail!.targetHidden, '页面靠它把「不公开」与「本来就没有当事人」分开').toBe(true);
  });

  it('实名评论被删的日志照旧公开当事人（回归：别一刀切）', async () => {
    const { listPublicLogs } = await import('@/lib/audit-service');
    const { blog } = await seedBlog();
    const u = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });

    const r = await createComment({ blogId: blog.id, authorId: u.id, content: 'x' });
    if (!r.ok) throw new Error('前置失败');
    await softDeleteComment(r.comment.id, { id: admin.id, role: 'admin' }, '违规');

    const { items } = await listPublicLogs({ action: 'delete_comment' });
    const row = items.find((i) => i.object?.id === r.comment.id);
    expect(row!.targetUser?.id).toBe(u.id);
  });

  it('★ 按当事人用户名搜**不会**命中匿名处置日志（否则一次搜索就把匿名作者认出来）', async () => {
    const { listPublicLogs } = await import('@/lib/audit-service');
    const { logAdminAction } = await import('@/lib/admin-user-service');
    const { blog } = await seedBlog();
    const victim = await makeUser({ role: 'core', username: 'victim_under_test' });
    const admin = await makeUser({ role: 'admin' });
    const owner = await makeUser({ role: 'owner' });

    // 一条**公开**日志，当事人是 victim（hideTarget 缺省 false）。
    await logAdminAction({
      action: 'delete_blog',
      adminId: owner.id,
      targetUserId: victim.id,
      objectType: 'blog',
      objectId: blog.id,
      reason: '测试',
    });
    // 一条**隐藏**日志，当事人同样是 victim（匿名评论被删）。
    const r = await createComment({
      blogId: blog.id,
      authorId: victim.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');
    await softDeleteComment(r.comment.id, { id: admin.id, role: 'admin' }, '违规');

    // 按用户名搜：只能拿到那条公开的 —— 命中隐藏行等于公开「victim 写过被处置的匿名评论」。
    const byName = await listPublicLogs({ targetUsername: 'victim_under_test' });
    expect(byName.total).toBe(1);
    expect(byName.items[0].action).toBe('delete_blog');

    // 默认列表两条都在：隐藏行只是抹掉当事人，**不从公示里消失**（透明性不能被匿名吃掉）。
    const all = await listPublicLogs({});
    expect(all.total).toBe(2);
    const hidden = all.items.find((i) => i.action === 'delete_comment');
    expect(hidden!.targetUser, '默认列表里当事人照旧为 null').toBeNull();
    expect(hidden!.targetHidden, '页面靠它区分「被隐去」与「本来没有当事人」').toBe(true);

    // 关键词 q **绝不**按用户名命中（只搜 reason / objectId）。
    const byQ = await listPublicLogs({ q: 'victim_under_test' });
    expect(byQ.total).toBe(0);

    // 「只看我相关的」：victim 自己看得到两条（含自己那条匿名的）—— 这是他自己的数据，不是泄露。
    const mine = await listPublicLogs({ mine: victim.id });
    expect(mine.total).toBe(2);
  });

  it('★ getLogDetail：隐藏日志的申诉人身份一并抹掉（否则匿名作者一申诉就自曝）', async () => {
    const { getLogDetail, createAppeal } = await import('@/lib/audit-service');
    const { blog } = await seedBlog();
    const anon = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });

    const r = await createComment({
      blogId: blog.id,
      authorId: anon.id,
      content: 'x',
      anonymous: true,
    });
    if (!r.ok) throw new Error('前置失败');
    await softDeleteComment(r.comment.id, { id: admin.id, role: 'admin' }, '违规');

    const logRow = await prisma.adminActionLog.findFirst({
      where: { objectId: r.comment.id },
      select: { id: true },
    });

    // 申诉只能由当事人本人提起 —— 所以隐藏日志的申诉人就是那个匿名作者。
    const appeal = await createAppeal({
      logId: logRow!.id,
      appellantId: anon.id,
      content: '我不是故意的',
    });
    expect(appeal.ok, '当事人本人必须申诉得了').toBe(true);

    const detail = await getLogDetail(logRow!.id);
    expect(detail!.appeals).toHaveLength(1);
    expect(
      detail!.appeals[0].appellantName,
      '申诉人就是当事人：只抹 target 而放着申诉人，等于匿名作者一申诉就把自己交出去'
    ).toBeNull();
    expect(detail!.appeals[0].appellantId, 'id 一起抹（/u/<id> 可达）').toBeNull();
    expect(detail!.appeals[0].content, '申诉内容照旧公示（透明性不能被匿名吃掉）').toBe(
      '我不是故意的'
    );
  });

  it('getLogDetail：实名日志的申诉人照旧公开（回归：别一刀切）', async () => {
    const { getLogDetail, createAppeal } = await import('@/lib/audit-service');
    const { logAdminAction } = await import('@/lib/admin-user-service');
    const { blog } = await seedBlog();
    const author = await makeUser({ role: 'core' });
    const admin = await makeUser({ role: 'admin' });

    const logId = await logAdminAction({
      action: 'delete_blog',
      adminId: admin.id,
      targetUserId: author.id,
      objectType: 'blog',
      objectId: blog.id,
      reason: '测试',
    });
    const appeal = await createAppeal({ logId, appellantId: author.id, content: '申诉' });
    expect(appeal.ok).toBe(true);

    const detail = await getLogDetail(logId);
    expect(detail!.targetHidden).toBe(false);
    expect(detail!.appeals[0].appellantName, '非匿名的申诉人姓名照旧公开').toBe(author.username);
  });
});

describe('匿名评论：不进个人主页（否则拿正文一比就认出人了）', () => {
  it('getPublicProfile 的 recentComments 滤掉匿名评论', async () => {
    const { getPublicProfile } = await import('@/lib/user-service');
    const { blog } = await seedBlog();
    const u = await makeUser({ role: 'core' });

    const real = await createComment({ blogId: blog.id, authorId: u.id, content: '实名的' });
    const anon = await createComment({ blogId: blog.id, authorId: u.id, content: '匿名的', anonymous: true });
    if (!real.ok || !anon.ok) throw new Error('前置失败');

    const profile = await getPublicProfile(u.id, { id: u.id, isCore: true });
    const contents = profile!.recentComments.map((c) => c.content);
    expect(contents).toContain('实名的');
    expect(contents, '匿名评论列在主页 = 读者一比对就知道化名背后是谁').not.toContain('匿名的');
  });
});

