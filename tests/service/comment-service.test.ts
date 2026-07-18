// comment-service.ts —— 评论业务逻辑（对齐 Flask app/web/blog/services/comment_service.py）
//
// 【为什么测这些】评论是全站唯一的「楼中楼 + 软删除 + 冗余计数」三合一模块，
// 三条规则互相纠缠，任何一条写错都不会报错，只会静默丢数据：
//
//   1. 楼中楼：parent_id（直接父级）+ root_id（根评论串）。root_id 算错 →
//      整条回复链归错串，前端折叠/定位全乱。
//   2. _filter_deleted_leaves：已删除且无子评论的叶子要从树里摘掉，但「已删除
//      却仍有存活子评论」的节点必须保留（否则整棵子树连带消失 —— 用户的评论
//      被别人的删除行为顺手抹掉）。这条最容易写反。
//   3. Blog.commentsCount / lastCommentAt 是冗余字段，靠每次评论操作手工维护，
//      对不上就是列表页显示「3 条评论」点进去只有 1 条。
//
// 这里跑真实 SQLite（tests/.tmp/test.db），不 mock Prisma —— 计数/唯一约束/
// 外键这些正是要验的东西，mock 掉就什么也没测。

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeBlog, prisma } from '../helpers/db';
import { rateLimit, RULES } from '@/lib/rate-limit';
import {
  listCommentsForBlog,
  createComment,
  softDeleteComment,
  toggleCommentLike,
  toContentHtml,
  type CommentNode,
} from '@/lib/comment-service';

beforeEach(async () => {
  await resetDb();
});

// ── 本地工具 ────────────────────────────────────────────────────────────────

// 直接落库造评论：createComment 用 new Date() 打点，毫秒级并发下会撞车，
// 而排序断言必须要有确定的 createdAt，所以建树相关用例一律用这个显式造。
let clock = 0;
async function makeComment(opts: {
  blogId: string;
  authorId: string;
  parentId?: string | null;
  rootId?: string | null;
  content?: string;
  status?: string | null;
  isDeleted?: boolean;
  createdAt?: Date;
}) {
  const id = crypto.randomUUID();
  const content = opts.content ?? 'c';
  return prisma.blogComment.create({
    data: {
      id,
      blogId: opts.blogId,
      authorId: opts.authorId,
      parentId: opts.parentId ?? null,
      rootId: opts.rootId ?? null,
      content,
      contentHtml: toContentHtml(content),
      // 注意用 in 判断而非 ??：用例需要显式造 status=NULL 的历史数据
      status: 'status' in opts ? opts.status : 'approved',
      isDeleted: opts.isDeleted ?? false,
      likesCount: 0,
      // 单调递增，保证 order by created_at asc 结果唯一
      createdAt: opts.createdAt ?? new Date(1700000000000 + ++clock * 1000),
      updatedAt: new Date(),
    },
  });
}

/** 把树压成 id → 子 id 列表的扁平映射，方便断言结构 */
function shape(nodes: CommentNode[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (ns: CommentNode[]) => {
    for (const n of ns) {
      out[n.content_html] = n.children.map((c) => c.content_html);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

async function seedBlog() {
  const author = await makeUser({ role: 'core' });
  const blog = await makeBlog({ authorId: author.id });
  return { author, blog };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 内容转义（不渲染 Markdown，对齐 markupsafe.escape + \n → <br>）
// ─────────────────────────────────────────────────────────────────────────────

describe('toContentHtml：评论不支持 Markdown，只转义 + 换行', () => {
  it('转义 & < > " \' 五个字符（顺序不能反 —— 先转 < 再转 & 会二次转义）', () => {
    expect(toContentHtml(`<script>alert("x")&'`)).toBe(
      '&lt;script&gt;alert(&#34;x&#34;)&amp;&#39;'
    );
  });

  it('& 先于其它字符转义，不会把已生成的实体再转一遍', () => {
    // 若实现里把 & 放最后转，结果会是 &amp;lt;（二次转义，前端显示成字面 &lt;）
    expect(toContentHtml('<'), '<' ).toBe('&lt;');
    expect(toContentHtml('&lt;'), '字面量 &lt; 应变成 &amp;lt;').toBe('&amp;lt;');
  });

  it('换行转 <br>（且 <br> 本身是转义后才插入的，不会被当成用户输入）', () => {
    expect(toContentHtml('a\nb\nc')).toBe('a<br>b<br>c');
    expect(toContentHtml('<br>'), '用户打的 <br> 字面量必须被转义').toBe('&lt;br&gt;');
  });

  it('Markdown 语法原样保留（评论区不渲染）', () => {
    expect(toContentHtml('**bold** `code`')).toBe('**bold** `code`');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 楼中楼建树：parent_id + root_id
// ─────────────────────────────────────────────────────────────────────────────

describe('楼中楼：root_id 归属', () => {
  it('顶层评论 root_id = null，parent_id = null', async () => {
    const { author, blog } = await seedBlog();
    const r = await createComment({ blogId: blog.id, authorId: author.id, content: 'top' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.comment.parent_id, '顶层评论无父级').toBeNull();
    expect(r.comment.root_id, '顶层评论 root_id 为 null（对齐 Flask：root_id 不自指）').toBeNull();
  });

  it('回复顶层评论：root_id 指向该顶层评论', async () => {
    const { author, blog } = await seedBlog();
    const top = await createComment({ blogId: blog.id, authorId: author.id, content: 'top' });
    if (!top.ok) throw new Error('前置失败');

    const reply = await createComment({
      blogId: blog.id,
      authorId: author.id,
      content: 'reply',
      parentId: top.comment.id,
    });
    if (!reply.ok) throw new Error('前置失败');
    expect(reply.comment.parent_id).toBe(top.comment.id);
    expect(reply.comment.root_id, 'parent.root_id 为空时取 parent.id').toBe(top.comment.id);
  });

  it('多层回复：所有后代共享同一个 root_id（不是指向直接父级）', async () => {
    const { author, blog } = await seedBlog();
    const l1 = await createComment({ blogId: blog.id, authorId: author.id, content: 'L1' });
    if (!l1.ok) throw new Error('前置失败');
    const l2 = await createComment({
      blogId: blog.id, authorId: author.id, content: 'L2', parentId: l1.comment.id,
    });
    if (!l2.ok) throw new Error('前置失败');
    const l3 = await createComment({
      blogId: blog.id, authorId: author.id, content: 'L3', parentId: l2.comment.id,
    });
    if (!l3.ok) throw new Error('前置失败');
    const l4 = await createComment({
      blogId: blog.id, authorId: author.id, content: 'L4', parentId: l3.comment.id,
    });
    if (!l4.ok) throw new Error('前置失败');

    // parent_id 逐级挂，root_id 全部锚在 L1 —— 这正是「楼中楼」折叠成一个楼层的依据
    expect(l3.comment.parent_id).toBe(l2.comment.id);
    expect(l4.comment.parent_id).toBe(l3.comment.id);
    for (const [name, c] of [['L2', l2], ['L3', l3], ['L4', l4]] as const) {
      expect(c.comment.root_id, `${name}.root_id 必须锚定 L1`).toBe(l1.comment.id);
    }
  });
});

describe('楼中楼：树形结构与顺序', () => {
  it('嵌套结构按 parent_id 正确还原层级', async () => {
    const { author, blog } = await seedBlog();
    const a = await makeComment({ blogId: blog.id, authorId: author.id, content: 'A' });
    const b = await makeComment({ blogId: blog.id, authorId: author.id, content: 'B' });
    const a1 = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'A1', parentId: a.id, rootId: a.id,
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'A1a', parentId: a1.id, rootId: a.id,
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'B1', parentId: b.id, rootId: b.id,
    });

    const tree = await listCommentsForBlog(blog.id);
    expect(tree.map((n) => n.content_html), '顶层只应有 A、B').toEqual(['A', 'B']);
    expect(shape(tree)).toEqual({
      A: ['A1'],
      A1: ['A1a'],
      A1a: [],
      B: ['B1'],
      B1: [],
    });
  });

  it('同层按 createdAt 升序（对齐原站 order_by created_at asc）', async () => {
    const { author, blog } = await seedBlog();
    const root = await makeComment({ blogId: blog.id, authorId: author.id, content: 'root' });
    // 故意乱序插入，靠 createdAt 而非插入顺序决定展示顺序
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'third',
      parentId: root.id, rootId: root.id, createdAt: new Date(3_000_000),
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'first',
      parentId: root.id, rootId: root.id, createdAt: new Date(1_000_000),
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'second',
      parentId: root.id, rootId: root.id, createdAt: new Date(2_000_000),
    });

    const tree = await listCommentsForBlog(blog.id);
    expect(
      tree[0].children.map((c) => c.content_html),
      '同层必须按时间升序，而非数据库返回的物理顺序'
    ).toEqual(['first', 'second', 'third']);
  });

  it('顶层也按 createdAt 升序', async () => {
    const { author, blog } = await seedBlog();
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'later', createdAt: new Date(9_000_000) });
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'earlier', createdAt: new Date(1_000_000) });
    const tree = await listCommentsForBlog(blog.id);
    expect(tree.map((n) => n.content_html)).toEqual(['earlier', 'later']);
  });

  it('孤儿评论（父级不在结果集内）降级为顶层，不会整条丢失', async () => {
    // 对齐 Flask：`if c.parent_id and c.parent_id in id_to_node` else roots.append
    const { author, blog } = await seedBlog();
    const hidden = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'hidden-parent', status: 'hidden',
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'orphan', parentId: hidden.id, rootId: hidden.id,
    });

    const tree = await listCommentsForBlog(blog.id);
    expect(tree.map((n) => n.content_html), '父级被过滤掉时子评论上浮为顶层').toEqual(['orphan']);
    expect(tree[0].parent_id, '注意：parent_id 字段仍保留原值（前端不能据此找父节点）').toBe(hidden.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 已删叶子过滤 —— 最容易写反的一条
// ─────────────────────────────────────────────────────────────────────────────

describe('_filter_deleted_leaves：已删叶子过滤', () => {
  it('已删除 + 无子评论 → 从树中移除', async () => {
    const { author, blog } = await seedBlog();
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'alive' });
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'dead', isDeleted: true });

    const tree = await listCommentsForBlog(blog.id);
    expect(tree.map((n) => n.content_html), '已删的光杆评论不该出现').toEqual(['alive']);
  });

  it('★已删除 + 仍有存活子评论 → 必须保留（否则子评论被连带抹掉）', async () => {
    const { author, blog } = await seedBlog();
    const dead = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'dead-parent', isDeleted: true,
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'alive-child', parentId: dead.id, rootId: dead.id,
    });

    const tree = await listCommentsForBlog(blog.id);
    expect(tree.length, '删掉的父级是子评论的唯一挂载点，必须留作占位').toBe(1);
    expect(tree[0].is_deleted).toBe(true);
    expect(tree[0].content_html, '保留的已删节点内容显示为占位文案，不泄露原文').toBe('[该评论已删除]');
    expect(tree[0].children.map((c) => c.content_html)).toEqual(['alive-child']);
  });

  it('★保留的已删节点不泄露原文（即使 contentHtml 还在库里）', async () => {
    const { author, blog } = await seedBlog();
    const dead = await makeComment({
      blogId: blog.id, authorId: author.id, content: '机密原文-不该被看到', isDeleted: true,
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'child', parentId: dead.id, rootId: dead.id,
    });

    const tree = await listCommentsForBlog(blog.id);
    expect(JSON.stringify(tree), '软删除只是标记，序列化时必须替换成占位').not.toContain('机密原文');
  });

  it('★已删父 + 已删子（子无孙）→ 自下而上整串塌陷，父子都消失', async () => {
    const { author, blog } = await seedBlog();
    const dead = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'dead-parent', isDeleted: true,
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'dead-child',
      parentId: dead.id, rootId: dead.id, isDeleted: true,
    });

    const tree = await listCommentsForBlog(blog.id);
    // 关键：过滤是递归的 —— 先摘掉已删的子叶子，父级随之变成「已删且无子」也被摘掉。
    // 若实现只做一层过滤，这里会残留一个孤零零的 [该评论已删除]。
    expect(tree, '递归过滤应让整串已删链条完全塌陷').toEqual([]);
  });

  it('★三层：已删祖父 → 已删父 → 存活孙，三层全保留', async () => {
    const { author, blog } = await seedBlog();
    const gp = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'GP', isDeleted: true,
    });
    const p = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'P', parentId: gp.id, rootId: gp.id, isDeleted: true,
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'GC', parentId: p.id, rootId: gp.id,
    });

    // 这里两个已删节点的 content_html 都是占位文案，shape() 会键冲突，故按 id 断言
    const tree = await listCommentsForBlog(blog.id);
    expect(tree.map((n) => n.id), '存活的孙子把整条已删祖链都「撑住」了').toEqual([gp.id]);
    expect(tree[0].is_deleted).toBe(true);
    expect(tree[0].content_html).toBe('[该评论已删除]');
    expect(tree[0].children.map((n) => n.id)).toEqual([p.id]);
    expect(tree[0].children[0].is_deleted).toBe(true);
    expect(tree[0].children[0].content_html).toBe('[该评论已删除]');
    expect(tree[0].children[0].children.map((n) => n.content_html)).toEqual(['GC']);
  });

  it('★已删父有两个子：一个存活一个已删 → 父保留，只剩存活的子', async () => {
    const { author, blog } = await seedBlog();
    const dead = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'dead-parent', isDeleted: true,
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'dead-child',
      parentId: dead.id, rootId: dead.id, isDeleted: true, createdAt: new Date(1_000_000),
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'alive-child',
      parentId: dead.id, rootId: dead.id, createdAt: new Date(2_000_000),
    });

    const tree = await listCommentsForBlog(blog.id);
    expect(tree.length).toBe(1);
    expect(tree[0].children.map((c) => c.content_html)).toEqual(['alive-child']);
  });

  it('存活父 + 已删子 → 父保留，已删子被摘掉', async () => {
    const { author, blog } = await seedBlog();
    const alive = await makeComment({ blogId: blog.id, authorId: author.id, content: 'alive' });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'dead-child',
      parentId: alive.id, rootId: alive.id, isDeleted: true,
    });

    const tree = await listCommentsForBlog(blog.id);
    expect(shape(tree)).toEqual({ alive: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 软删除
// ─────────────────────────────────────────────────────────────────────────────

describe('软删除：权限与落库', () => {
  it('作者本人可删自己的评论，行仍在库里（isDeleted=true，不物理删除）', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });

    const r = await softDeleteComment(c.id, { id: author.id, role: 'core' });
    expect(r.ok).toBe(true);

    const row = await prisma.blogComment.findUnique({ where: { id: c.id } });
    expect(row, '软删除绝不能物理删行（审计/建树都依赖它还在）').not.toBeNull();
    expect(row!.isDeleted).toBe(true);
    expect(row!.content, '原文保留在库里供审计，只是不再序列化出去').toBe('c');
  });

  it.each(['admin', 'owner'] as const)('%s 删他人评论：给了原因 → 成功', async (role) => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    const admin = await makeUser({ role });

    const r = await softDeleteComment(c.id, { id: admin.id, role }, '违反社区规则');
    expect(r.ok).toBe(true);
  });

  // 对齐 Flask delete_comment：管理员删他人评论必须给原因（1..500）。
  // 这条日志是 /audit 公示与申诉的数据来源 —— 不填原因就不该放行。
  it.each(['admin', 'owner'] as const)('%s 删他人评论：未给原因 → 拒绝', async (role) => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    const admin = await makeUser({ role });

    for (const bad of [undefined, '', '   ']) {
      const c2 = await makeComment({ blogId: blog.id, authorId: author.id });
      const r = await softDeleteComment(c2.id, { id: admin.id, role }, bad);
      expect(r.ok, `reason=${JSON.stringify(bad)} 应被拒绝`).toBe(false);
      if (!r.ok) expect(r.error).toBe('reasonRequired');
    }
    // 评论未被删掉
    const row = await prisma.blogComment.findUnique({ where: { id: c.id } });
    expect(row!.isDeleted).toBe(false);
  });

  it.each(['admin', 'owner'] as const)('%s 删他人评论：原因超 500 字 → 拒绝', async (role) => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    const admin = await makeUser({ role });

    const r = await softDeleteComment(c.id, { id: admin.id, role }, 'x'.repeat(501));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('reasonTooLong');

    // 恰好 500 放行
    const r2 = await softDeleteComment(c.id, { id: admin.id, role }, 'x'.repeat(500));
    expect(r2.ok).toBe(true);
  });

  it('作者删自己的评论：不需要原因', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });

    const r = await softDeleteComment(c.id, { id: author.id, role: 'user' });
    expect(r.ok, '作者删自己评论不该要求原因').toBe(true);
  });

  it('管理员删他人评论会写 AdminActionLog（申诉流程依赖它）', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    const admin = await makeUser({ role: 'admin' });

    await softDeleteComment(c.id, { id: admin.id, role: 'admin' }, '广告内容');

    const log = await prisma.adminActionLog.findFirst({
      where: { action: 'delete_comment', objectId: c.id },
    });
    expect(log, '未写审计日志 → 用户无法对被删评论发起申诉').not.toBeNull();
    expect(log!.adminId).toBe(admin.id);
    expect(log!.targetUserId).toBe(author.id);
    expect(log!.objectType).toBe('comment');
    expect(log!.reason).toBe('广告内容');
  });

  it('作者删自己评论不写审计日志（对齐 Flask：只记管理员删他人）', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });

    await softDeleteComment(c.id, { id: author.id, role: 'user' });

    const log = await prisma.adminActionLog.findFirst({ where: { objectId: c.id } });
    expect(log).toBeNull();
  });

  it.each(['user', 'core'] as const)('%s 删他人评论 → forbidden', async (role) => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    const other = await makeUser({ role });

    const r = await softDeleteComment(c.id, { id: other.id, role });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('forbidden');
    expect(r.message).toBe('无权删除该评论');

    const row = await prisma.blogComment.findUnique({ where: { id: c.id } });
    expect(row!.isDeleted, '越权尝试不能落库').toBe(false);
  });

  it('重复删除 → notFound（幂等保护：避免计数被扣两次）', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });

    expect((await softDeleteComment(c.id, { id: author.id, role: 'core' })).ok).toBe(true);
    const again = await softDeleteComment(c.id, { id: author.id, role: 'core' });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toBe('notFound');
  });

  it('删不存在的评论 → notFound（不抛异常）', async () => {
    const u = await makeUser({ role: 'admin' });
    const r = await softDeleteComment('no-such-comment', { id: u.id, role: 'admin' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('notFound');
  });

  it('软删除的评论仍能作为父节点撑住子树（软删除 ↔ 建树的联动）', async () => {
    const { author, blog } = await seedBlog();
    const parent = await makeComment({ blogId: blog.id, authorId: author.id, content: 'P' });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'C', parentId: parent.id, rootId: parent.id,
    });

    await softDeleteComment(parent.id, { id: author.id, role: 'core' });

    const tree = await listCommentsForBlog(blog.id);
    expect(shape(tree), '删父不该连坐删子').toEqual({ '[该评论已删除]': ['C'], C: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 冗余计数：Blog.commentsCount / lastCommentAt
// ─────────────────────────────────────────────────────────────────────────────

describe('冗余计数：新增评论', () => {
  it('每次创建都刷新 commentsCount 与 lastCommentAt', async () => {
    const { author, blog } = await seedBlog();
    const before = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(before!.commentsCount).toBe(0);
    expect(before!.lastCommentAt).toBeNull();

    for (let i = 1; i <= 3; i++) {
      const r = await createComment({ blogId: blog.id, authorId: author.id, content: `c${i}` });
      expect(r.ok, `第 ${i} 条应创建成功`).toBe(true);
      const b = await prisma.blog.findUnique({ where: { id: blog.id } });
      expect(b!.commentsCount, `创建 ${i} 条后计数应为 ${i}`).toBe(i);
      expect(b!.lastCommentAt, 'lastCommentAt 每条都要刷新').not.toBeNull();
    }
  });

  it('回复也计入 commentsCount（楼中楼不是「不算数的」）', async () => {
    const { author, blog } = await seedBlog();
    const top = await createComment({ blogId: blog.id, authorId: author.id, content: 'top' });
    if (!top.ok) throw new Error('前置失败');
    await createComment({
      blogId: blog.id, authorId: author.id, content: 'reply', parentId: top.comment.id,
    });

    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(b!.commentsCount).toBe(2);
  });

  it('lastCommentAt 与最新评论的 createdAt 一致', async () => {
    const { author, blog } = await seedBlog();
    const r = await createComment({ blogId: blog.id, authorId: author.id, content: 'x' });
    if (!r.ok) throw new Error('前置失败');

    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    const c = await prisma.blogComment.findUnique({ where: { id: r.comment.id } });
    expect(b!.lastCommentAt!.getTime()).toBe(c!.createdAt!.getTime());
  });

  it('创建失败（文章不存在）不会误伤其它文章的计数', async () => {
    const { author, blog } = await seedBlog();
    await createComment({ blogId: blog.id, authorId: author.id, content: 'ok' });
    await createComment({ blogId: 'ghost-blog', authorId: author.id, content: 'boom' });

    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(b!.commentsCount).toBe(1);
  });

  it('计数只统计未删除的：已存在的软删评论不会被算进新增后的总数', async () => {
    const { author, blog } = await seedBlog();
    // 库里先放一条已删的
    await makeComment({ blogId: blog.id, authorId: author.id, isDeleted: true });
    const r = await createComment({ blogId: blog.id, authorId: author.id, content: 'new' });
    expect(r.ok).toBe(true);

    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(b!.commentsCount, '按未删除数重算 → 只有新建的这 1 条').toBe(1);
  });

  it('计数不串文章（只统计本文章的评论）', async () => {
    const { author, blog } = await seedBlog();
    const other = await makeBlog({ authorId: author.id });
    await makeComment({ blogId: other.id, authorId: author.id });
    await makeComment({ blogId: other.id, authorId: author.id });

    await createComment({ blogId: blog.id, authorId: author.id, content: 'mine' });

    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(b!.commentsCount, '不能把别的文章的评论算进来').toBe(1);
  });
});

describe('冗余计数：软删除评论', () => {
  it('删一条 → commentsCount 减一', async () => {
    const { author, blog } = await seedBlog();
    const ids: string[] = [];
    for (const t of ['a', 'b', 'c']) {
      const r = await createComment({ blogId: blog.id, authorId: author.id, content: t });
      if (!r.ok) throw new Error('前置失败');
      ids.push(r.comment.id);
    }
    expect((await prisma.blog.findUnique({ where: { id: blog.id } }))!.commentsCount).toBe(3);

    await softDeleteComment(ids[0], { id: author.id, role: 'core' });
    expect((await prisma.blog.findUnique({ where: { id: blog.id } }))!.commentsCount).toBe(2);
  });

  it('删光所有评论 → commentsCount 归 0 且 lastCommentAt 回 null', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    await prisma.blog.update({
      where: { id: blog.id },
      data: { commentsCount: 1, lastCommentAt: c.createdAt },
    });

    await softDeleteComment(c.id, { id: author.id, role: 'core' });
    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(b!.commentsCount).toBe(0);
    expect(b!.lastCommentAt, '没有存活评论时 lastCommentAt 应清空').toBeNull();
  });

  it('删掉最新一条 → lastCommentAt 回退到剩下的最新存活评论', async () => {
    const { author, blog } = await seedBlog();
    const older = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'older', createdAt: new Date(1_000_000),
    });
    const newer = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'newer', createdAt: new Date(2_000_000),
    });
    await prisma.blog.update({
      where: { id: blog.id },
      data: { commentsCount: 2, lastCommentAt: newer.createdAt },
    });

    await softDeleteComment(newer.id, { id: author.id, role: 'core' });
    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(b!.commentsCount).toBe(1);
    expect(
      b!.lastCommentAt!.getTime(),
      'lastCommentAt 应重算为剩余最新存活评论的时间，而非停在已删那条上'
    ).toBe(older.createdAt!.getTime());
  });

  it('删除失败（越权）不改动计数', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    await prisma.blog.update({ where: { id: blog.id }, data: { commentsCount: 1 } });
    const stranger = await makeUser({ role: 'core' });

    await softDeleteComment(c.id, { id: stranger.id, role: 'core' });
    expect((await prisma.blog.findUnique({ where: { id: blog.id } }))!.commentsCount).toBe(1);
  });

  it('计数与 listCommentsForBlog 可见节点数在纯扁平场景下自洽', async () => {
    const { author, blog } = await seedBlog();
    for (const t of ['a', 'b', 'c']) {
      await createComment({ blogId: blog.id, authorId: author.id, content: t });
    }
    const tree = await listCommentsForBlog(blog.id);
    const b = await prisma.blog.findUnique({ where: { id: blog.id } });
    expect(tree.length, '显示「3 条评论」点进去就该有 3 条').toBe(b!.commentsCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 审核状态过滤
// ─────────────────────────────────────────────────────────────────────────────

describe('审核状态：pending / approved / hidden', () => {
  it('新建评论默认 approved（当前站点策略：免审）', async () => {
    const { author, blog } = await seedBlog();
    const r = await createComment({ blogId: blog.id, authorId: author.id, content: 'x' });
    if (!r.ok) throw new Error('前置失败');
    expect(r.comment.status).toBe('approved');
  });

  it.each(['pending', 'hidden'] as const)('%s 的评论不出现在列表里', async (status) => {
    const { author, blog } = await seedBlog();
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'shown' });
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'x', status });

    const tree = await listCommentsForBlog(blog.id);
    expect(tree.map((n) => n.content_html)).toEqual(['shown']);
  });

  it('status 为 NULL 的历史数据不出现在列表里（严格等值过滤）', async () => {
    // 注意：schema 里 status 可空。Flask 侧 filter_by(status="approved") 同样不匹配 NULL，
    // 语义一致 —— 但迁移历史数据时 status 必须显式写成 "approved"，否则评论集体消失。
    const { author, blog } = await seedBlog();
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'null-status', status: null });
    expect(await listCommentsForBlog(blog.id)).toEqual([]);
  });

  it('pending 的子评论被过滤，但存活的 approved 兄弟不受影响', async () => {
    const { author, blog } = await seedBlog();
    const top = await makeComment({ blogId: blog.id, authorId: author.id, content: 'top' });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'pending-child',
      parentId: top.id, rootId: top.id, status: 'pending',
    });
    await makeComment({
      blogId: blog.id, authorId: author.id, content: 'ok-child', parentId: top.id, rootId: top.id,
    });

    const tree = await listCommentsForBlog(blog.id);
    expect(shape(tree)).toEqual({ top: ['ok-child'], 'ok-child': [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 边界与异常输入
// ─────────────────────────────────────────────────────────────────────────────

describe('边界：createComment 的异常输入', () => {
  it('不存在的 blogId → notFound', async () => {
    const u = await makeUser({ role: 'core' });
    const r = await createComment({ blogId: 'ghost', authorId: u.id, content: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('notFound');
    expect(r.message).toBe('文章不存在');
  });

  it('已下架（ignore=true）的文章不能评论', async () => {
    const u = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: u.id, ignore: true });
    const r = await createComment({ blogId: blog.id, authorId: u.id, content: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('notFound');
  });

  it.each([['空串', ''], ['纯空格', '   '], ['纯换行/制表', '\n\t \n']])(
    '%s 内容 → empty',
    async (_label, content) => {
      const { author, blog } = await seedBlog();
      const r = await createComment({ blogId: blog.id, authorId: author.id, content });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('empty');
      expect(r.message).toBe('评论内容不能为空');
    }
  );

  it('内容前后空白被 trim（落库的是 trim 后的）', async () => {
    const { author, blog } = await seedBlog();
    const r = await createComment({ blogId: blog.id, authorId: author.id, content: '  hi  ' });
    if (!r.ok) throw new Error('前置失败');
    expect(r.comment.content_html).toBe('hi');
    const row = await prisma.blogComment.findUnique({ where: { id: r.comment.id } });
    expect(row!.content).toBe('hi');
  });

  it('2000 字边界：恰好 2000 通过，2001 拒绝', async () => {
    const { author, blog } = await seedBlog();
    const ok = await createComment({ blogId: blog.id, authorId: author.id, content: 'a'.repeat(2000) });
    expect(ok.ok, '恰好 2000 字应放行（上限是闭区间）').toBe(true);

    const bad = await createComment({ blogId: blog.id, authorId: author.id, content: 'a'.repeat(2001) });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBe('tooLong');
    expect(bad.message).toBe('评论内容不能超过2000字');
  });

  it('长度按 trim 后计算（2000 字 + 首尾空格仍应通过）', async () => {
    const { author, blog } = await seedBlog();
    const r = await createComment({ blogId: blog.id, authorId: author.id, content: `  ${'a'.repeat(2000)}  ` });
    expect(r.ok).toBe(true);
  });
});

describe('边界：parentId 相关', () => {
  it('不存在的 parentId → parentInvalid（不会静默降级成顶层评论）', async () => {
    const { author, blog } = await seedBlog();
    const r = await createComment({
      blogId: blog.id, authorId: author.id, content: 'x', parentId: 'ghost-parent',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('parentInvalid');
    expect(r.message).toBe('父评论不存在或已删除');
    expect(await prisma.blogComment.count(), '失败时不该落库').toBe(0);
  });

  it('★跨文章回复 → parentInvalid（parent.blogId 必须与目标文章一致）', async () => {
    const { author, blog } = await seedBlog();
    const otherBlog = await makeBlog({ authorId: author.id });
    const foreign = await makeComment({ blogId: otherBlog.id, authorId: author.id });

    const r = await createComment({
      blogId: blog.id, authorId: author.id, content: 'x', parentId: foreign.id,
    });
    expect(r.ok, '不校验会造成评论挂到另一篇文章的楼里').toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('parentInvalid');
  });

  it('回复已软删除的评论 → parentInvalid', async () => {
    const { author, blog } = await seedBlog();
    const dead = await makeComment({ blogId: blog.id, authorId: author.id, isDeleted: true });
    const r = await createComment({
      blogId: blog.id, authorId: author.id, content: 'x', parentId: dead.id,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('parentInvalid');
  });

  it('parentId 传 null / undefined / 空串 一律按顶层评论处理', async () => {
    const { author, blog } = await seedBlog();
    for (const parentId of [null, undefined, ''] as const) {
      const r = await createComment({ blogId: blog.id, authorId: author.id, content: 'top', parentId });
      expect(r.ok, `parentId=${JSON.stringify(parentId)}`).toBe(true);
      if (!r.ok) continue;
      expect(r.comment.parent_id).toBeNull();
      expect(r.comment.root_id).toBeNull();
    }
  });

  it('回复一条 pending 的评论是允许的（parent 校验不看 status）', async () => {
    // 记录当前语义：Flask 与 TS 都只校验 存在 / 同文章 / 未删除，不校验 status。
    // 后果：回复挂到 pending 父级上，列表里会因父级被过滤而上浮成顶层。
    const { author, blog } = await seedBlog();
    const pending = await makeComment({
      blogId: blog.id, authorId: author.id, content: 'pending', status: 'pending',
    });
    const r = await createComment({
      blogId: blog.id, authorId: author.id, content: 'reply', parentId: pending.id,
    });
    expect(r.ok).toBe(true);
  });
});

describe('边界：listCommentsForBlog', () => {
  it('不存在的 blogId → 空数组（不抛异常）', async () => {
    await expect(listCommentsForBlog('ghost')).resolves.toEqual([]);
  });

  it('无评论的文章 → 空数组', async () => {
    const { blog } = await seedBlog();
    await expect(listCommentsForBlog(blog.id)).resolves.toEqual([]);
  });

  it('只返回本文章的评论', async () => {
    const { author, blog } = await seedBlog();
    const other = await makeBlog({ authorId: author.id });
    await makeComment({ blogId: blog.id, authorId: author.id, content: 'mine' });
    await makeComment({ blogId: other.id, authorId: author.id, content: 'theirs' });

    const tree = await listCommentsForBlog(blog.id);
    expect(tree.map((n) => n.content_html)).toEqual(['mine']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. 序列化形状（前端契约）
// ─────────────────────────────────────────────────────────────────────────────

describe('序列化：snake_case 字段与作者信息', () => {
  it('字段名与 Flask API JSON 形状一致', async () => {
    const { author, blog } = await seedBlog();
    const r = await createComment({ blogId: blog.id, authorId: author.id, content: 'x' });
    if (!r.ok) throw new Error('前置失败');
    expect(Object.keys(r.comment).sort()).toEqual([
      'author', 'blog_id', 'children', 'content_html', 'created_at',
      'id', 'is_deleted', 'likes_count', 'parent_id', 'root_id', 'status', 'updated_at',
    ]);
  });

  it('作者是管理员时 is_admin=true，普通用户 false', async () => {
    const blogOwner = await makeUser({ role: 'core' });
    const blog = await makeBlog({ authorId: blogOwner.id });
    for (const [role, want] of [['user', false], ['core', false], ['admin', true], ['owner', true]] as const) {
      const u = await makeUser({ role });
      const r = await createComment({ blogId: blog.id, authorId: u.id, content: role });
      if (!r.ok) throw new Error('前置失败');
      expect(r.comment.author.is_admin, `role=${role}`).toBe(want);
      expect(r.comment.author.id).toBe(u.id);
      expect(r.comment.author.username).toBe(u.username);
      expect(r.comment.author.avatar_url).toBe(`/api/avatar/${u.id}`);
    }
  });

  it('created_at / updated_at 序列化为 ISO 字符串', async () => {
    const { author, blog } = await seedBlog();
    const r = await createComment({ blogId: blog.id, authorId: author.id, content: 'x' });
    if (!r.ok) throw new Error('前置失败');
    expect(r.comment.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. 频率限制（1200 条/天，对齐 RULES.commentDaily）
// ─────────────────────────────────────────────────────────────────────────────

describe('频率限制：每日 1200 条', () => {
  it('打满配额后 → rateLimited', async () => {
    const { author, blog } = await seedBlog();
    // 直接把该用户的桶灌满（1200 次真实建评论太慢），key 与 service 内部约定一致
    const key = `comment:d:${author.id}`;
    for (let i = 0; i < RULES.commentDaily.limit; i++) rateLimit(key, RULES.commentDaily);

    const r = await createComment({ blogId: blog.id, authorId: author.id, content: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('rateLimited');
    expect(r.message).toContain('1200');
    expect(await prisma.blogComment.count(), '超限时不该落库').toBe(0);
  });

  it('限流按用户隔离：A 打满不影响 B', async () => {
    const { blog } = await seedBlog();
    const a = await makeUser({ role: 'core' });
    const b = await makeUser({ role: 'core' });
    for (let i = 0; i < RULES.commentDaily.limit; i++) rateLimit(`comment:d:${a.id}`, RULES.commentDaily);

    expect((await createComment({ blogId: blog.id, authorId: a.id, content: 'x' })).ok).toBe(false);
    expect((await createComment({ blogId: blog.id, authorId: b.id, content: 'x' })).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. 评论点赞（likesCount 冗余字段）
// ─────────────────────────────────────────────────────────────────────────────

describe('评论点赞：toggle 与 likesCount', () => {
  it('点赞 → 取消 → 再点赞，likesCount 跟随', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    const liker = await makeUser({ role: 'core' });

    expect(await toggleCommentLike(c.id, liker.id)).toEqual({ liked: true, likesCount: 1 });
    expect(await toggleCommentLike(c.id, liker.id)).toEqual({ liked: false, likesCount: 0 });
    expect(await toggleCommentLike(c.id, liker.id)).toEqual({ liked: true, likesCount: 1 });

    const row = await prisma.blogComment.findUnique({ where: { id: c.id } });
    expect(row!.likesCount, '冗余字段必须与 comment_likes 实际行数一致').toBe(1);
  });

  it('多用户点赞累加，且每人只算一票（唯一约束 commentId+userId）', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id });
    const u1 = await makeUser({ role: 'core' });
    const u2 = await makeUser({ role: 'core' });

    await toggleCommentLike(c.id, u1.id);
    const r = await toggleCommentLike(c.id, u2.id);
    expect(r).toEqual({ liked: true, likesCount: 2 });
    expect(await prisma.commentLike.count({ where: { commentId: c.id } })).toBe(2);
  });

  it('点赞不存在 / 已删除的评论 → notFound', async () => {
    const { author, blog } = await seedBlog();
    const dead = await makeComment({ blogId: blog.id, authorId: author.id, isDeleted: true });
    const u = await makeUser({ role: 'core' });

    expect(await toggleCommentLike('ghost', u.id)).toEqual({ notFound: true });
    expect(await toggleCommentLike(dead.id, u.id)).toEqual({ notFound: true });
  });

  it('likes_count 出现在序列化结果里', async () => {
    const { author, blog } = await seedBlog();
    const c = await makeComment({ blogId: blog.id, authorId: author.id, content: 'x' });
    const u = await makeUser({ role: 'core' });
    await toggleCommentLike(c.id, u.id);

    const tree = await listCommentsForBlog(blog.id);
    expect(tree[0].likes_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 评论通知（对齐 Flask CommentService.create_comment 的 send_notification）
//
// 这块此前在 TS 侧完全缺失（测试补齐时发现）：Flask 会在有人评论/回复时通知
// 文章作者或被回复者，否则用户永远不知道自己收到了互动。
// ─────────────────────────────────────────────────────────────────────────────
describe('评论通知', () => {
  it('顶层评论 → 通知文章作者（action=文章评论）', async () => {
    const { author, blog } = await seedBlog();
    const commenter = await makeUser({ role: 'core' });

    const r = await createComment({ blogId: blog.id, authorId: commenter.id, content: '好文' });
    expect(r.ok).toBe(true);

    const n = await prisma.notification.findFirst({ where: { recipientId: author.id } });
    expect(n, '文章作者未收到评论通知').not.toBeNull();
    expect(n!.action).toBe('文章评论');
    expect(n!.actorId).toBe(commenter.id);
    expect(n!.objectType).toBe('blog');
    expect(n!.objectId).toBe(blog.id);
    expect(n!.detail).toContain(blog.title);
  });

  it('回复 → 通知被回复者（action=评论回复），而不是文章作者', async () => {
    const { author, blog } = await seedBlog();
    const first = await makeUser({ role: 'core' });
    const replier = await makeUser({ role: 'core' });

    const c1 = await createComment({ blogId: blog.id, authorId: first.id, content: '沙发' });
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    // 清掉「文章评论」通知，只观察回复产生的那条
    await prisma.notification.deleteMany({});

    const r = await createComment({
      blogId: blog.id,
      authorId: replier.id,
      content: '回复你',
      parentId: c1.comment.id,
    });
    expect(r.ok).toBe(true);

    const toFirst = await prisma.notification.findFirst({ where: { recipientId: first.id } });
    expect(toFirst, '被回复者未收到通知').not.toBeNull();
    expect(toFirst!.action).toBe('评论回复');
    expect(toFirst!.actorId).toBe(replier.id);

    const toAuthor = await prisma.notification.findFirst({ where: { recipientId: author.id } });
    expect(toAuthor, '回复不应额外通知文章作者（对齐 Flask 的 if/elif）').toBeNull();
  });

  it('自己评论自己的文章 → 不通知（排除自己）', async () => {
    const { author, blog } = await seedBlog();
    await createComment({ blogId: blog.id, authorId: author.id, content: '自评' });
    const n = await prisma.notification.findFirst({ where: { recipientId: author.id } });
    expect(n, '不该给自己发通知').toBeNull();
  });

  it('回复自己的评论 → 不通知（排除自己）', async () => {
    const { blog } = await seedBlog();
    const u = await makeUser({ role: 'core' });
    const c1 = await createComment({ blogId: blog.id, authorId: u.id, content: '一楼' });
    if (!c1.ok) return;
    await prisma.notification.deleteMany({});

    await createComment({ blogId: blog.id, authorId: u.id, content: '自我回复', parentId: c1.comment.id });
    const n = await prisma.notification.findFirst({ where: { recipientId: u.id } });
    expect(n).toBeNull();
  });

  // 注：「通知失败不影响评论」这条未写用例 —— Blog.authorId / BlogComment.authorId 都有
  // 外键非空约束，无法自然构造出「通知目标不存在」的场景；强测需要 mock
  // notification-service，那会连带把本组另外 4 条「真实校验通知落库」的用例架空。
  // 该行为由 createComment 里 sendNotification 外层的 try/catch 保证（对齐 Flask try/except pass）。
});
