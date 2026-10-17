import { ymdhms } from '../../../src/lib/format';
import { renderTable } from '../output';
import { userSource } from '../sources';
import { CliError, type CommandSpec } from '../types';

const usernameArg = {
  name: 'username', flags: [], positional: 0, required: true, label: '用户名', help: '目标用户名',
  prompt: { type: 'search' as const, source: userSource() },
};
const reasonArg = {
  name: 'reason', flags: ['--reason', '-r'], required: true, label: '原因', help: '1..200 字，记入内部审计',
  prompt: { type: 'input' as const },
  validate(raw: string) { return !raw.trim() || raw.trim().length > 200 ? '原因须为 1..200 字' : null; },
};

export const userArchiveCommands: CommandSpec[] = [
  {
    name: 'user archived', summary: '查看已归档用户（仅后台 CLI）', group: 'users', order: 1.1, readOnly: true,
    args: [{ name: 'keyword', flags: [], positional: 0, label: '用户名关键词', help: '留空列出全部归档用户', prompt: { type: 'input' as const } }],
    async run(ctx) {
      const users = await ctx.prisma.user.findMany({
        where: { archivedAt: { not: null }, ...(ctx.args.keyword ? { username: { contains: String(ctx.args.keyword) } } : {}) },
        select: { id: true, username: true, role: true, archivedAt: true, archiveReason: true }, orderBy: { archivedAt: 'desc' },
      });
      return { lines: renderTable([
        { key: 'username', title: '用户名', maxWidth: 20 }, { key: 'role', title: '角色', maxWidth: 8 },
        { key: 'at', title: '归档时间', maxWidth: 19 }, { key: 'archiveReason', title: '原因', maxWidth: 40 },
      ], users.map(u => ({ ...u, at: ymdhms(u.archivedAt) })), { maxWidth: ctx.io.width(), emptyText: '（没有归档用户）' }), json: users };
    },
  },
  ...[true, false].map((archive): CommandSpec => ({
    name: archive ? 'user archive' : 'user unarchive',
    summary: archive ? '归档用户、撤销点赞并清空钱包（仅 CLI）' : '恢复归档用户（不返还余额、点赞与凭据）',
    group: 'users', order: archive ? 1.2 : 1.3, needsActor: true, danger: 'destructive',
    args: [usernameArg, reasonArg],
    async describe(ctx) {
      const user = await ctx.prisma.user.findUnique({ where: { username: String(ctx.args.username) }, select: { id: true, username: true, driedFish: true, archivedAt: true } });
      if (!user) throw new CliError('用户不存在');
      if (!ctx.actor || ctx.actor.role !== 'owner' || ctx.actor.archivedAt) throw new CliError('需要有效的站长审计主体');
      if (user.id === ctx.actor.id) throw new CliError('不能归档或恢复自己');
      const { unitsToFish } = await import('../../../src/lib/fish-units');
      return archive ? [
        `归档 ${user.username}；当前余额 ${unitsToFish(user.driedFish)} 条鱼干将全额扣除并记账。`,
        '撤销全部文章/评论点赞；未结清仓位作废且不退款。',
        '所有会话及接口凭据失效；网站（含管理页）不能查看或修改该用户及原文。',
        '文章、评论、讨论和上传内容保留在库内，仅后台 CLI 可查询；原有删除状态保留。',
        `原因：${ctx.args.reason}`,
      ] : [`恢复 ${user.username}；原来未删除的内容重新可见。`, '已清空的余额、撤销的点赞、接口凭据和已作废仓位不恢复。', `原因：${ctx.args.reason}`];
    },
    async run(ctx) {
      const { archiveUser, unarchiveUser } = await import('../../../src/lib/user-archive-service');
      const result = await (archive ? archiveUser : unarchiveUser)({ actor: ctx.actor!, username: String(ctx.args.username), reason: String(ctx.args.reason) });
      if (!result.ok) throw new CliError(result.message);
      return { lines: [result.message], json: result };
    },
  })),
];
