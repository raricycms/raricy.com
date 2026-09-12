// ─────────────────────────────────────────────────────────────────────────────
// blogs.ts —— 文章检索、查看、恢复、删除
//
// 「找回被误删的文章」是这套工具最主要的用途之一，所以 search 默认
// `status: 'all'`（含已删）且用 `searchScope: 'all'`（搜正文）——
// 运维常常只记得正文里的某个词，记不得标题。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderKv, renderTable } from '../output';
import { blogSource, preview } from '../sources';
import { CliError, type CommandSpec, type Ctx } from '../types';

const idArg = {
  name: 'id',
  flags: [],
  positional: 0,
  required: true,
  label: '文章',
  help: '文章 id（UUID），交互模式下可先搜索再选',
  prompt: { type: 'search' as const, source: blogSource() },
};

const statusArg = {
  name: 'status',
  flags: ['--status'],
  defaultValue: 'all',
  label: '状态',
  help: 'all（含已删除，默认）| active（仅未删）| deleted（仅已删）',
  prompt: {
    type: 'select' as const,
    choices: [
      { value: 'all', label: '全部（含已删除）' },
      { value: 'active', label: '仅未删除' },
      { value: 'deleted', label: '仅已删除', hint: '配合 blog restore 使用' },
    ],
  },
  validate: (raw: string) =>
    ['all', 'active', 'deleted'].includes(raw) ? null : '只能是 all / active / deleted',
};

const deleteReasonArg = {
  name: 'reason',
  flags: ['--reason', '-r'],
  required: true,
  label: '删除原因（会通知作者）',
  help: '1..500 字；会写进审计日志并通知作者',
  prompt: { type: 'input' as const },
  validate: (raw: string) => (raw.trim() ? (raw.trim().length > 500 ? '原因过长' : null) : '必须填写删除原因'),
};

async function lookup(ctx: Ctx, id: string) {
  const blog = await ctx.prisma.blog.findUnique({
    where: { id },
    select: { id: true, title: true, ignore: true, authorId: true, author: { select: { username: true } } },
  });
  if (!blog) throw new CliError(`错误：文章 ${id} 不存在`);
  return blog;
}

export const blogCommands: CommandSpec[] = [
  {
    name: 'blog search',
    summary: '搜文章（含已删，可搜正文）',
    group: 'blogs',
    order: 0,
    readOnly: true,
    args: [
      {
        name: 'keyword',
        flags: ['--keyword', '-q'],
        positional: 0,
        label: '关键词',
        help: '标题 / 描述 / 正文 / 作者用户名；留空 = 最近一页',
        prompt: { type: 'input' as const },
      },
      statusArg,
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const { listAdminBlogs } = await import('../../../src/lib/admin-blog-service');
      const r = await listAdminBlogs({
        page: Number(ctx.args.page ?? 1),
        perPage: 20,
        search: ctx.args.keyword ? String(ctx.args.keyword) : null,
        status: String(ctx.args.status) as 'all' | 'active' | 'deleted',
        // 运维搜文章要能搜正文 —— 只记得「正文里写过某个词」是常态
        searchScope: 'all',
      });

      const lines = renderTable(
        [
          { key: 'title', title: '标题', maxWidth: 32 },
          { key: 'author', title: '作者', maxWidth: 14 },
          { key: 'createdAt', title: '发布时间', maxWidth: 19 },
          { key: 'comments', title: '评论', align: 'right' },
          { key: 'state', title: '状态', maxWidth: 8 },
          { key: 'id', title: 'ID', maxWidth: 36 },
        ],
        r.blogs.map((b) => ({
          title: b.title,
          author: b.author?.username ?? '—',
          createdAt: ymdhms(b.createdAt) ?? '—',
          comments: b.commentsCount ?? 0,
          state: b.ignore ? '已删除' : '正常',
          id: b.id,
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有匹配的文章）' }
      );

      return { lines, notes: [`共 ${r.total} 篇，第 ${r.page}/${r.pages} 页`], json: r };
    },
  },

  {
    name: 'blog show',
    summary: '查看文章详情（含正文摘要）',
    group: 'blogs',
    order: 1,
    readOnly: true,
    args: [idArg],
    async run(ctx) {
      const id = String(ctx.args.id);
      const blog = await ctx.prisma.blog.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          description: true,
          ignore: true,
          isFeatured: true,
          createdAt: true,
          likesCount: true,
          commentsCount: true,
          fishCount: true,
          authorId: true,
          author: { select: { username: true } },
          category: { select: { name: true } },
          content: { select: { content: true, updatedAt: true } },
        },
      });
      if (!blog) throw new CliError(`错误：文章 ${id} 不存在`);

      const body = blog.content?.content ?? '';
      const lines = renderKv([
        ['标题', blog.title],
        ['文章 ID', blog.id],
        ['作者', blog.author?.username ?? '—'],
        ['状态', blog.ignore ? '已删除' : '正常'],
        ['栏目', blog.category?.name ?? '未分类'],
        ['精选', blog.isFeatured ? '是' : '否'],
        ['发布时间', ymdhms(blog.createdAt)],
        ['正文更新', ymdhms(blog.content?.updatedAt)],
        ['点赞 / 评论 / 鱼干', `${blog.likesCount ?? 0} / ${blog.commentsCount ?? 0} / ${blog.fishCount ?? 0}`],
        ['描述', blog.description || '—'],
        ['正文长度', `${body.length} 字`],
        ['正文开头', preview(body, 80)],
      ]);

      return { lines, json: { ...blog, content: body } };
    },
  },

  {
    name: 'blog restore',
    summary: '恢复被删除的文章',
    group: 'blogs',
    order: 2,
    needsActor: true,
    danger: 'destructive',
    args: [
      idArg,
      {
        name: 'reason',
        flags: ['--reason', '-r'],
        label: '恢复原因',
        help: '可选，会写进审计日志',
        prompt: { type: 'input' as const },
      },
    ],
    async describe(ctx) {
      const blog = await lookup(ctx, String(ctx.args.id));
      if (!blog.ignore) throw new CliError(`错误：文章《${blog.title}》未被删除`);
      return [
        `文章：《${blog.title}》`,
        `作者：${blog.author?.username ?? '—'}`,
        '变更：Blog.ignore → false（重新出现在列表与详情页）',
        '注：评论从未被删过，随文章一起恢复可见，不需要额外操作。',
        '本次操作会写入审计日志（公开可见）。',
      ];
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const { restoreBlog } = await import('../../../src/lib/admin-blog-service');
      const r = await restoreBlog(
        id,
        ctx.actor!,
        ctx.args.reason ? String(ctx.args.reason) : undefined
      );
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { id } };
    },
  },

  {
    name: 'blog delete',
    summary: '删除文章（软删，会通知作者）',
    group: 'blogs',
    order: 3,
    needsActor: true,
    danger: 'destructive',
    args: [idArg, deleteReasonArg],
    async describe(ctx) {
      const blog = await lookup(ctx, String(ctx.args.id));
      if (blog.ignore) throw new CliError(`错误：文章《${blog.title}》已被删除`);
      const notify =
        blog.authorId === ctx.actor?.id
          ? '作者就是你自己，不会发通知。'
          : `会通知作者 ${blog.author?.username ?? '—'}（对方可以就此申诉）。`;
      return [
        `文章：《${blog.title}》`,
        `作者：${blog.author?.username ?? '—'}`,
        `原因：${String(ctx.args.reason)}`,
        `变更：Blog.ignore → true（软删，随时可用 blog restore 找回）`,
        notify,
        '本次操作会写入审计日志（公开可见）。',
      ];
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const { deleteBlogForAdmin } = await import('../../../src/lib/admin-blog-service');
      const r = await deleteBlogForAdmin(id, ctx.actor!, String(ctx.args.reason));
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { id } };
    },
  },
];
