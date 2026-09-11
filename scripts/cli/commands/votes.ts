// ─────────────────────────────────────────────────────────────────────────────
// votes.ts —— 投票检索、查看、恢复、删除
//
// 与剪贴板同构。投票没有正文（只有标题 + 选项），所以搜索面窄。
// Vote 的两个状态位别混：ignore 是软删除（这里管的），isLocked 是「停止投票但内容仍可见」。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderKv, renderTable } from '../output';
import { voteSource } from '../sources';
import { CliError, type CommandSpec, type Ctx } from '../types';

const idArg = {
  name: 'id',
  flags: [],
  positional: 0,
  required: true,
  label: '投票',
  help: '9 位短 id，交互模式下可先搜索再选',
  prompt: { type: 'search' as const, source: voteSource() },
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
      { value: 'deleted', label: '仅已删除' },
    ],
  },
  validate: (raw: string) =>
    ['all', 'active', 'deleted'].includes(raw) ? null : '只能是 all / active / deleted',
};

async function lookup(ctx: Ctx, id: string) {
  const vote = await ctx.prisma.vote.findUnique({
    where: { id },
    select: { id: true, title: true, ignore: true, authorId: true, author: { select: { username: true } } },
  });
  if (!vote) throw new CliError(`错误：投票 ${id} 不存在`);
  return vote;
}

export const voteCommands: CommandSpec[] = [
  {
    name: 'vote search',
    summary: '搜投票（含已删）',
    group: 'votes',
    order: 0,
    readOnly: true,
    args: [
      {
        name: 'keyword',
        flags: ['--keyword', '-q'],
        positional: 0,
        label: '关键词',
        help: '标题 / 作者 / 9 位 id；留空 = 最近一页',
        prompt: { type: 'input' as const },
      },
      statusArg,
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const { listAdminVotes } = await import('../../../src/lib/admin-vote-service');
      const r = await listAdminVotes({
        page: Number(ctx.args.page ?? 1),
        perPage: 20,
        search: ctx.args.keyword ? String(ctx.args.keyword) : null,
        status: String(ctx.args.status) as 'all' | 'active' | 'deleted',
      });

      const lines = renderTable(
        [
          { key: 'title', title: '标题', maxWidth: 34 },
          { key: 'author', title: '作者', maxWidth: 14 },
          { key: 'createdAt', title: '创建时间', maxWidth: 19 },
          { key: 'records', title: '票数', align: 'right' },
          { key: 'state', title: '状态', maxWidth: 10 },
          { key: 'id', title: 'ID', maxWidth: 9 },
        ],
        r.votes.map((v) => ({
          title: v.title,
          author: v.author?.username ?? '—',
          createdAt: ymdhms(v.createdAt) ?? '—',
          records: v._count.records,
          state: v.ignore ? '已删除' : v.isLocked ? '已锁定' : '正常',
          id: v.id,
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有匹配的投票）' }
      );

      return { lines, notes: [`共 ${r.total} 个，第 ${r.page}/${r.pages} 页`], json: r };
    },
  },

  {
    name: 'vote show',
    summary: '查看投票详情与各选项票数',
    group: 'votes',
    order: 1,
    readOnly: true,
    args: [idArg],
    async run(ctx) {
      const id = String(ctx.args.id);
      const { getVoteForAdmin } = await import('../../../src/lib/admin-vote-service');
      const v = await getVoteForAdmin(id);
      if (!v) throw new CliError(`错误：投票 ${id} 不存在`);

      const lines = renderKv([
        ['标题', v.title],
        ['投票 ID', v.id],
        ['作者', v.author?.username ?? '—'],
        ['状态', v.ignore ? '已删除' : '正常'],
        ['锁定', v.isLocked ? '是（停止投票）' : '否'],
        ['创建时间', ymdhms(v.createdAt)],
        ['总票数', v._count.records],
      ]);

      lines.push('', '选项：');
      lines.push(
        ...renderTable(
          [
            { key: 'label', title: '选项', maxWidth: 40 },
            { key: 'votes', title: '票数', align: 'right' },
          ],
          v.options.map((o) => ({ label: o.label, votes: o.voteCount ?? 0 })),
          { emptyText: '（没有选项）' }
        )
      );

      return { lines, json: v };
    },
  },

  {
    name: 'vote restore',
    summary: '恢复被删除的投票',
    group: 'votes',
    order: 2,
    needsActor: true,
    danger: 'destructive',
    args: [
      idArg,
      {
        name: 'reason',
        flags: ['--reason', '-r'],
        label: '恢复原因',
        help: '可选',
        prompt: { type: 'input' as const },
      },
    ],
    async describe(ctx) {
      const vote = await lookup(ctx, String(ctx.args.id));
      if (!vote.ignore) throw new CliError('错误：该投票未被删除');
      return [
        `标题：${vote.title}`,
        `作者：${vote.author?.username ?? '—'}`,
        '变更：Vote.ignore → false',
        '票数与选项从未被动过，恢复后计票原样可用。',
        '本次操作会写入审计日志（公开可见）。',
      ];
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const { restoreVote } = await import('../../../src/lib/admin-vote-service');
      const r = await restoreVote(
        id,
        ctx.actor!,
        ctx.args.reason ? String(ctx.args.reason) : undefined
      );
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { id } };
    },
  },

  {
    name: 'vote delete',
    summary: '删除投票（软删）',
    group: 'votes',
    order: 3,
    needsActor: true,
    danger: 'destructive',
    args: [
      idArg,
      {
        name: 'reason',
        flags: ['--reason', '-r'],
        required: true,
        label: '删除原因',
        help: '会写进公开审计日志',
        prompt: { type: 'input' as const },
        validate: (raw: string) => (raw.trim() ? null : '必须填写删除原因'),
      },
    ],
    async describe(ctx) {
      const vote = await lookup(ctx, String(ctx.args.id));
      if (vote.ignore) throw new CliError('错误：该投票已被删除');
      return [
        `标题：${vote.title}`,
        `作者：${vote.author?.username ?? '—'}`,
        '变更：Vote.ignore → true（软删，随时可用 vote restore 找回）',
        '本次操作会写入审计日志（公开可见）。',
      ];
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const { softDeleteVote } = await import('../../../src/lib/admin-vote-service');
      const r = await softDeleteVote(id, ctx.actor!, String(ctx.args.reason));
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { id } };
    },
  },
];
