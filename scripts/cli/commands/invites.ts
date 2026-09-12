// ─────────────────────────────────────────────────────────────────────────────
// invites.ts —— 邀请码生成、列表、撤销
//
// 【码值绝不进审计日志】logAdminAction 默认 visibility:'public'，而 /audit 是公开页。
// 把 12 位邀请码写进 reason/metadata 等于把注册凭证发给所有 core 用户。
// 撤销那条路径只记数字 id（见 src/lib/invite-code.ts 的说明）。
// 列表里显示码值是没问题的 —— 那是操作者自己的屏幕。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderTable } from '../output';
import { CliError, type CommandSpec } from '../types';

export const inviteCommands: CommandSpec[] = [
  {
    name: 'invite generate',
    summary: '生成邀请码（填了即升 core）',
    group: 'invites',
    order: 0,
    args: [
      {
        name: 'count',
        flags: ['-n', '--count'],
        kind: 'int',
        defaultValue: 1,
        label: '生成几个',
        help: '正整数，默认 1；一次最多 20 个',
        prompt: { type: 'number' as const, integer: true, min: 1 },
        validate: (raw) => {
          const n = Number.parseInt(raw, 10);
          if (!Number.isInteger(n) || n < 1) return '数量必须是正整数';
          return n > 20 ? '一次最多生成 20 个' : null;
        },
      },
    ],
    async run(ctx) {
      const { generateInviteCode } = await import('../../../src/lib/invite-code');
      const count = Number(ctx.args.count ?? 1);
      const codes: string[] = [];
      for (let i = 0; i < count; i++) codes.push(await generateInviteCode());

      return {
        lines: [ctx.io.green(`成功：已生成 ${codes.length} 个邀请码`), '', ...codes.map((c) => `  ${c}`)],
        notes: ['把码交给对方，注册时填在邀请码一栏即可升为 core。'],
        json: { codes },
      };
    },
  },

  {
    name: 'invite list',
    summary: '列出邀请码',
    group: 'invites',
    order: 1,
    readOnly: true,
    args: [
      {
        name: 'filter',
        flags: ['--filter'],
        defaultValue: 'all',
        label: '筛选',
        help: 'all | unused（未使用）| used（已使用）',
        prompt: {
          type: 'select' as const,
          choices: [
            { value: 'all', label: '全部' },
            { value: 'unused', label: '仅未使用', hint: '这些还可以发出去' },
            { value: 'used', label: '仅已使用' },
          ],
        },
        validate: (raw) => (['all', 'unused', 'used'].includes(raw) ? null : '只能是 all / unused / used'),
      },
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const { listInviteCodes } = await import('../../../src/lib/invite-code');
      const r = await listInviteCodes({
        page: Number(ctx.args.page ?? 1),
        perPage: 20,
        filter: String(ctx.args.filter) as 'all' | 'unused' | 'used',
      });

      const lines = renderTable(
        [
          { key: 'code', title: '邀请码', maxWidth: 14 },
          { key: 'state', title: '状态', maxWidth: 8 },
          { key: 'usedBy', title: '使用者', maxWidth: 18 },
          { key: 'createdAt', title: '生成时间', maxWidth: 19 },
          { key: 'id', title: 'ID', align: 'right' },
        ],
        r.codes.map((c) => ({
          code: c.code,
          state: c.isUsed ? '已使用' : '未使用',
          usedBy: c.usedByName ?? '—',
          createdAt: ymdhms(c.createdAt) ?? '—',
          id: c.id,
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有邀请码）' }
      );

      return { lines, notes: [`共 ${r.total} 个，第 ${r.page}/${r.pages} 页`], json: r };
    },
  },

  {
    name: 'invite revoke',
    summary: '撤销未使用的邀请码（不可逆）',
    group: 'invites',
    order: 2,
    needsActor: true,
    danger: 'irreversible',
    details: [
      '⚠️ 这是物理删除 —— InviteCode 没有软删列，撤销就是把这行删掉，删了找不回来。',
      '已使用的邀请码**会被拒绝撤销**：used_by 是「谁邀请了谁」的唯一记录，',
      '删掉就永久丢失（审计日志也重建不出来）。',
    ].join('\n'),
    args: [
      {
        name: 'code',
        flags: [],
        positional: 0,
        required: true,
        label: '邀请码或 ID',
        help: '12 位邀请码，或列表里的数字 ID',
        prompt: { type: 'input' as const },
        validate: (raw) => (raw.trim() ? null : '请填邀请码或 ID'),
      },
    ],
    async describe(ctx) {
      const key = String(ctx.args.code).trim();
      const { listInviteCodes } = await import('../../../src/lib/invite-code');

      // 先在库里找出来，好在确认屏上把「要删的是哪个」摆清楚
      const asId = Number.parseInt(key, 10);
      const page = await listInviteCodes({ page: 1, perPage: 100, filter: 'all' });
      const row =
        page.codes.find((c) => c.code === key) ??
        (Number.isInteger(asId) ? page.codes.find((c) => c.id === asId) : undefined);

      if (!row) throw new CliError(`错误：找不到邀请码 ${key}`);
      if (row.isUsed) {
        throw new CliError(
          `错误：邀请码已被 ${row.usedByName ?? '某用户'} 使用，不能撤销（撤销会丢失邀请来源记录）`
        );
      }
      return [
        `邀请码：${row.code}（ID ${row.id}）`,
        `生成时间：${ymdhms(row.createdAt) ?? '—'}`,
        '变更：**物理删除**该行，不可恢复。',
        '后果：拿到这个码的人将无法再注册；已经注册的人不受影响。',
        '本次操作会写入审计日志（只记数字 ID，**不记码值**）。',
      ];
    },
    async run(ctx) {
      const { revokeInviteCode } = await import('../../../src/lib/invite-code');
      const r = await revokeInviteCode(String(ctx.args.code).trim(), ctx.actor!);
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { code: String(ctx.args.code).trim() } };
    },
  },
];
