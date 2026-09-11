// ─────────────────────────────────────────────────────────────────────────────
// comments.ts —— 评论检索、查看、恢复、删除
//
// 站内此前**完全没有评论搜索**（只有按文章取楼中楼、按作者取个人主页），
// 被删的评论也没有任何恢复入口（除了申诉通过时的副作用）。这两件事在这里补齐。
//
// 删除/恢复都复用 comment-service 的既有函数，权限与 reason 口径（删他人评论需
// reason 1..500）与网页端完全一致，不另写一份。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderKv, renderTable } from '../output';
import { commentSource, preview } from '../sources';
import { CliError, type CommandSpec, type Ctx } from '../types';

const idArg = {
  name: 'id',
  flags: [],
  positional: 0,
  required: true,
  label: '评论',
  help: '评论 id，交互模式下可先搜索再选',
  prompt: { type: 'search' as const, source: commentSource() },
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
      { value: 'deleted', label: '仅已删除', hint: '配合 comment restore 使用' },
    ],
  },
  validate: (raw: string) =>
    ['all', 'active', 'deleted'].includes(raw) ? null : '只能是 all / active / deleted',
};

const reasonArg = {
  name: 'reason',
  flags: ['--reason', '-r'],
  label: '原因',
  help: '恢复/删除他人评论时必填（1..500 字），会写进公开审计日志',
  prompt: { type: 'input' as const },
  validate: (raw: string) => (raw.trim().length > 500 ? '原因过长（最多 500 字）' : null),
};

async function lookup(ctx: Ctx, id: string) {
  const c = await ctx.prisma.blogComment.findUnique({
    where: { id },
    select: {
      id: true,
      content: true,
      status: true,
      isDeleted: true,
      authorId: true,
      author: { select: { username: true } },
      blog: { select: { title: true } },
    },
  });
  if (!c) throw new CliError(`错误：评论 ${id} 不存在`);
  return c;
}

/** 恢复/删除他人评论时 reason 必填，与 comment-service 的口径一致。 */
function requireReasonForOthers(ctx: Ctx, authorId: string): string {
  const reason = String(ctx.args.reason ?? '').trim();
  if (authorId !== ctx.actor?.id && !reason) {
    throw new CliError('错误：处理他人评论必须填写原因（--reason）');
  }
  return reason;
}

export const commentCommands: CommandSpec[] = [
  {
    name: 'comment search',
    summary: '搜评论（含已删）',
    group: 'comments',
    order: 0,
    readOnly: true,
    args: [
      {
        name: 'keyword',
        flags: ['--keyword', '-q'],
        positional: 0,
        label: '关键词',
        help: '评论正文 / 作者用户名 / 所属文章标题；留空 = 最近一页',
        prompt: { type: 'input' as const },
      },
      statusArg,
      {
        name: 'blogId',
        flags: ['--blog'],
        label: '限定文章',
        help: '只看某篇文章下的评论（文章 id）',
        prompt: { type: 'input' as const },
      },
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const { listAdminComments } = await import('../../../src/lib/admin-comment-service');
      const r = await listAdminComments({
        page: Number(ctx.args.page ?? 1),
        perPage: 20,
        search: ctx.args.keyword ? String(ctx.args.keyword) : null,
        blogId: ctx.args.blogId ? String(ctx.args.blogId) : null,
        status: String(ctx.args.status) as 'all' | 'active' | 'deleted',
      });

      const lines = renderTable(
        [
          { key: 'content', title: '正文', maxWidth: 40 },
          { key: 'author', title: '作者', maxWidth: 14 },
          { key: 'blog', title: '所属文章', maxWidth: 22 },
          { key: 'createdAt', title: '时间', maxWidth: 19 },
          { key: 'state', title: '状态', maxWidth: 8 },
          { key: 'id', title: 'ID', maxWidth: 36 },
        ],
        r.comments.map((c) => ({
          content: preview(c.content, 60),
          author: c.author?.username ?? '—',
          blog: preview(c.blog?.title, 30),
          createdAt: ymdhms(c.createdAt) ?? '—',
          state: c.isDeleted ? '已删除' : '正常',
          id: c.id,
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有匹配的评论）' }
      );

      return { lines, notes: [`共 ${r.total} 条，第 ${r.page}/${r.pages} 页`], json: r };
    },
  },

  {
    name: 'comment show',
    summary: '查看评论详情',
    group: 'comments',
    order: 1,
    readOnly: true,
    args: [idArg],
    async run(ctx) {
      const id = String(ctx.args.id);
      const c = await ctx.prisma.blogComment.findUnique({
        where: { id },
        select: {
          id: true,
          blogId: true,
          parentId: true,
          content: true,
          status: true,
          isDeleted: true,
          likesCount: true,
          createdAt: true,
          updatedAt: true,
          authorId: true,
          author: { select: { username: true } },
          blog: { select: { title: true, ignore: true } },
        },
      });
      if (!c) throw new CliError(`错误：评论 ${id} 不存在`);

      const lines = renderKv([
        ['评论 ID', c.id],
        ['作者', c.author?.username ?? '—'],
        ['所属文章', `${c.blog?.title ?? '—'}${c.blog?.ignore ? '（已删除）' : ''}`],
        ['文章 ID', c.blogId],
        ['楼层关系', c.parentId ? `回复 ${c.parentId}` : '顶层'],
        ['状态', c.isDeleted ? '已删除' : '正常'],
        ['审核状态', c.status ?? '—'],
        ['点赞数', c.likesCount ?? 0],
        ['发布时间', ymdhms(c.createdAt)],
        ['正文', preview(c.content, 200)],
      ]);

      return { lines, json: c };
    },
  },

  {
    name: 'comment restore',
    summary: '恢复被删除的评论',
    group: 'comments',
    order: 2,
    needsActor: true,
    danger: 'destructive',
    args: [idArg, reasonArg],
    async describe(ctx) {
      const c = await lookup(ctx, String(ctx.args.id));
      if (!c.isDeleted) throw new CliError('错误：该评论未被删除');
      const lines = [
        `评论作者：${c.author?.username ?? '—'}`,
        `所属文章：《${c.blog?.title ?? '—'}》`,
        `正文预览：${preview(c.content, 60)}`,
        '变更：BlogComment.isDeleted → false；重算文章评论计数与最后评论时间。',
      ];
      if (c.status && c.status !== 'approved') {
        // status 是正交的另一个闸门，恢复 isDeleted 不会让它出现 —— 必须说清楚
        lines.push(`⚠️ 该评论的审核状态是 ${c.status}（非 approved），恢复后仍不会出现在评论区。`);
      }
      lines.push('本次操作会写入审计日志（公开可见）。');
      return lines;
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const c = await lookup(ctx, id);
      const reason = requireReasonForOthers(ctx, c.authorId);
      const { restoreComment } = await import('../../../src/lib/comment-service');
      const r = await restoreComment(id, ctx.actor!, reason);
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green('成功：已恢复该评论')], json: { id } };
    },
  },

  {
    name: 'comment delete',
    summary: '删除评论（软删）',
    group: 'comments',
    order: 3,
    needsActor: true,
    danger: 'destructive',
    args: [idArg, reasonArg],
    async describe(ctx) {
      const c = await lookup(ctx, String(ctx.args.id));
      if (c.isDeleted) throw new CliError('错误：该评论已被删除');
      const mine = c.authorId === ctx.actor?.id;
      return [
        `评论作者：${c.author?.username ?? '—'}${mine ? '（就是你自己）' : ''}`,
        `所属文章：《${c.blog?.title ?? '—'}》`,
        `正文预览：${preview(c.content, 60)}`,
        '变更：BlogComment.isDeleted → true（软删，随时可用 comment restore 找回）。',
        '删除后正文与附件在接口上一并抹掉；有子评论时该楼会显示为「该评论已删除」占位。',
        mine ? '删自己的评论不写审计日志。' : '本次操作会写入审计日志（公开可见），对方可以申诉。',
      ];
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const c = await lookup(ctx, id);
      const reason = requireReasonForOthers(ctx, c.authorId);
      const { softDeleteComment } = await import('../../../src/lib/comment-service');
      const r = await softDeleteComment(id, ctx.actor!, reason);
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green('成功：已删除该评论')], json: { id } };
    },
  },
];
