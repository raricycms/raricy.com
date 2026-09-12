// ─────────────────────────────────────────────────────────────────────────────
// appeals.ts —— 申诉列表与裁决
//
// 裁决是最需要「看清后果再动手」的操作：通过一条申诉会**自动撤回原处罚**
// （解禁 / 恢复文章 / 恢复评论）。所以 describe 会把「这次通过会撤销什么」写明，
// 而不是笼统地说「确定吗」。
//
// ★ 自裁禁令：不能裁决「针对自己」的申诉。这道闸在 src/lib/admin-appeal-service.ts
//   的 adjudicate 里（网页与 CLI 共用），这里在 describe 里提前拦一道，
//   好让操作者在确认之前就看到原因，而不是确认完才被 service 拒绝。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderTable } from '../output';
import { preview } from '../sources';
import { CliError, type CommandSpec, type Ctx } from '../types';

/** 取申诉；不存在即报错。 */
async function lookup(ctx: Ctx, id: number) {
  const { getAppeal } = await import('../../../src/lib/admin-appeal-service');
  const a = await getAppeal(id);
  if (!a) throw new CliError(`错误：申诉 #${id} 不存在`);
  return a;
}

/** 「通过这条申诉会撤销什么」。 */
function reversalFor(action: string | null | undefined): string {
  switch (action) {
    case 'ban_user':
      return '通过后会**自动解除该用户的禁言**。';
    case 'delete_blog':
      return '通过后会**自动恢复被删的文章**（ignore=false）。';
    case 'delete_comment':
      return '通过后会**自动恢复被删的评论**，并回补文章评论计数。';
    default:
      return '原操作不在自动撤回范围内 —— 通过只会改变申诉状态，**不会撤销任何数据**。';
  }
}

export const appealCommands: CommandSpec[] = [
  {
    name: 'appeal list',
    summary: '列出申诉',
    group: 'appeals',
    order: 0,
    readOnly: true,
    args: [
      {
        name: 'status',
        flags: ['--status'],
        defaultValue: 'pending',
        label: '状态',
        help: 'pending（待处理，默认）| accepted | rejected | all',
        prompt: {
          type: 'select' as const,
          choices: [
            { value: 'pending', label: '待处理' },
            { value: 'accepted', label: '已通过' },
            { value: 'rejected', label: '已驳回' },
            { value: 'all', label: '全部' },
          ],
        },
        validate: (raw: string) =>
          ['pending', 'accepted', 'rejected', 'all'].includes(raw) ? null : '无效的状态',
      },
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const status = String(ctx.args.status);
      const { listAppeals } = await import('../../../src/lib/admin-appeal-service');
      const r = await listAppeals({
        page: Number(ctx.args.page ?? 1),
        status: status === 'all' ? null : status,
      });

      const lines = renderTable(
        [
          { key: 'id', title: '#', align: 'right' },
          { key: 'appellant', title: '申诉人', maxWidth: 14 },
          { key: 'action', title: '针对操作', maxWidth: 18 },
          { key: 'content', title: '申诉正文', maxWidth: 34 },
          { key: 'createdAt', title: '提交时间', maxWidth: 19 },
          { key: 'status', title: '状态', maxWidth: 8 },
        ],
        r.items.map((a) => ({
          id: a.id,
          appellant: a.appellant.username ?? '—',
          action: a.log?.action ?? '（无关联日志）',
          content: preview(a.content, 50),
          // AppealRow 把时间戳映射成 ISO 字符串（service 层对外契约），这里转回 Date
          createdAt: ymdhms(a.createdAt ? new Date(a.createdAt) : null) ?? '—',
          status: a.status,
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有申诉）' }
      );

      return { lines, notes: [`共 ${r.total} 条，第 ${r.page}/${r.pages} 页`], json: r };
    },
  },

  {
    name: 'appeal decide',
    summary: '裁决申诉（通过时会自动撤回原处罚）',
    group: 'appeals',
    order: 1,
    needsActor: true,
    danger: 'destructive',
    details: [
      '仅站长可裁决。通过时会尽力撤回原操作：解禁 / 恢复文章 / 恢复评论。',
      '不能裁决「针对自己」的申诉 —— 申诉是对管理权力的制衡，自裁会让这道闸失效。',
    ].join('\n'),
    args: [
      {
        name: 'id',
        flags: [],
        positional: 0,
        required: true,
        kind: 'int',
        label: '申诉编号',
        help: '数字 id',
        prompt: { type: 'input' as const },
        validate: (raw) => (/^\d+$/.test(raw.trim()) ? null : '申诉编号是数字'),
      },
      {
        name: 'decision',
        flags: [],
        positional: 1,
        required: true,
        label: '裁决结果',
        help: 'accept（通过并撤回原操作）| reject（驳回）',
        prompt: {
          type: 'select' as const,
          choices: [
            { value: 'accept', label: '通过', hint: '会按原操作自动撤销' },
            { value: 'reject', label: '驳回' },
          ],
        },
        validate: (raw) => (['accept', 'reject'].includes(raw) ? null : '只能是 accept 或 reject'),
      },
      {
        name: 'note',
        flags: ['--note', '-n'],
        requiredIf: (a) => a.decision === 'reject',
        label: '裁决说明（会通知申诉人）',
        help: '驳回时必填；通过时可选',
        prompt: { type: 'input' as const },
        validate: (raw, a) =>
          a.decision === 'reject' && !raw.trim() ? '驳回必须写明理由' : null,
      },
    ],
    async describe(ctx) {
      const appeal = await lookup(ctx, Number(ctx.args.id));
      if (appeal.status !== 'pending') {
        throw new CliError(`错误：申诉 #${appeal.id} 已处理（${appeal.status}）`);
      }
      // 与 service 层同一道闸，提前拦是为了让操作者先看到人话原因
      if (appeal.log?.targetUser && appeal.log.targetUser.id === ctx.actor?.id) {
        throw new CliError('错误：不能裁决针对自己的申诉');
      }

      const decision = String(ctx.args.decision);
      return [
        `申诉 #${appeal.id} · 申诉人 ${appeal.appellant.username ?? '—'} · ${appeal.status}`,
        `针对操作：${appeal.log?.action ?? '（无关联日志）'} · 对象 ${appeal.log?.objectId ?? '—'}`,
        `申诉正文：${preview(appeal.content, 120)}`,
        `裁决：${decision === 'accept' ? '通过' : '驳回'}`,
        decision === 'accept' ? reversalFor(appeal.log?.action) : '驳回不改变任何数据。',
        '本次裁决会写入审计日志，并通知申诉人。',
      ];
    },
    async run(ctx) {
      const { adjudicate } = await import('../../../src/lib/admin-appeal-service');
      const id = Number(ctx.args.id);
      const decision = String(ctx.args.decision) as 'accept' | 'reject';
      const note = ctx.args.note ? String(ctx.args.note) : '';

      const r = await adjudicate({ actor: ctx.actor!, appealId: id, decision, note });
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { appealId: id, decision } };
    },
  },
];
