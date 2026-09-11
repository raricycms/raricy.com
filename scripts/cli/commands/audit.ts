// ─────────────────────────────────────────────────────────────────────────────
// audit.ts —— 审计日志检索
//
// 与公开的 /audit 页不同：这里**看得到 visibility 非 public 的内部日志**，
// 也**没有 30 天窗口** —— 排查陈年问题要能翻到任意久之前。
//
// `--since` 的时间基准必须是 nowForDb()（UTC+8 墙上时间），不能用 Date.now()：
// 库内时间戳是「UTC+8 墙上时间贴 Z 标签」，用真实 UTC 算窗口会整整差 8 小时。
// 所以 db-time 走的是函数内的动态 import（顶层静态 import 会破坏 --help 的惰性加载）。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderTable } from '../output';
import { preview } from '../sources';
import { CliError, type CommandSpec } from '../types';

/** 解析 `7d` / `24h` / `30m` / ISO 日期。返回 null 表示无法解析。 */
function parseSince(raw: string, now: Date): Date | null {
  const t = raw.trim();
  const rel = /^(\d+)\s*([dhm])$/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = rel[2] === 'd' ? 86_400_000 : rel[2] === 'h' ? 3_600_000 : 60_000;
    return new Date(now.getTime() - n * unitMs);
  }
  const abs = new Date(t);
  return Number.isNaN(abs.getTime()) ? null : abs;
}

export const auditCommands: CommandSpec[] = [
  {
    name: 'audit log',
    summary: '检索审计日志（含内部日志与陈年记录）',
    group: 'audit',
    order: 0,
    readOnly: true,
    args: [
      {
        name: 'user',
        flags: ['--user', '-u'],
        label: '涉及的用户',
        help: '按执行者或被处理用户的用户名模糊匹配',
        prompt: { type: 'input' as const },
      },
      {
        name: 'action',
        flags: ['--action', '-a'],
        label: '动作',
        help: '如 change_role / delete_blog / ban_user / restore_comment',
        prompt: { type: 'input' as const },
      },
      {
        name: 'since',
        flags: ['--since'],
        label: '起始时间',
        help: '7d / 24h / 30m，或 2026-01-01 这样的日期；默认不限',
        prompt: { type: 'input' as const },
      },
      {
        name: 'visibility',
        flags: ['--visibility'],
        defaultValue: 'all',
        label: '可见性',
        help: 'all（默认，含内部）| public（公示页可见的）| internal（仅内部）',
        prompt: {
          type: 'select' as const,
          choices: [
            { value: 'all', label: '全部（含内部日志）' },
            { value: 'public', label: '仅公开（/audit 公示的那些）' },
            { value: 'internal', label: '仅内部' },
          ],
        },
        validate: (raw: string) =>
          ['all', 'public', 'internal'].includes(raw) ? null : '只能是 all / public / internal',
      },
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const { nowForDb } = await import('../../../src/lib/db-time');
      const sinceRaw = ctx.args.since ? String(ctx.args.since) : '';
      const since = sinceRaw ? parseSince(sinceRaw, nowForDb()) : null;
      if (sinceRaw && !since) {
        throw new CliError(`错误：无法解析 --since ${sinceRaw}（支持 7d / 24h / 30m 或日期）`);
      }

      const user = ctx.args.user ? String(ctx.args.user) : null;
      const { listAdminLogs } = await import('../../../src/lib/audit-service');
      const r = await listAdminLogs({
        page: Number(ctx.args.page ?? 1),
        perPage: 30,
        action: ctx.args.action ? String(ctx.args.action) : null,
        adminUsername: user,
        targetUsername: user,
        visibility: String(ctx.args.visibility) as 'all' | 'public' | 'internal',
        since,
      });

      const lines = renderTable(
        [
          { key: 'createdAt', title: '时间', maxWidth: 19 },
          { key: 'action', title: '动作', maxWidth: 18 },
          { key: 'admin', title: '执行者', maxWidth: 14 },
          { key: 'target', title: '对象用户', maxWidth: 14 },
          { key: 'object', title: '对象', maxWidth: 24 },
          { key: 'reason', title: '原因', maxWidth: 28 },
          { key: 'flags', title: '标记', maxWidth: 10 },
        ],
        r.items.map((it) => ({
          createdAt: ymdhms(it.createdAt) ?? '—',
          action: it.action,
          admin: it.admin.username ?? it.admin.id,
          target: it.targetUser?.username ?? '—',
          object: it.object ? `${it.object.type ?? '—'}:${preview(it.object.id, 12)}` : '—',
          reason: preview(it.reason, 40),
          flags: [it.visibility !== 'public' ? '内部' : '', it.hasPendingAppeal ? '有申诉' : '']
            .filter(Boolean)
            .join(' '),
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有匹配的日志）' }
      );

      return { lines, notes: [`共 ${r.total} 条，第 ${r.page}/${r.pages} 页`], json: r };
    },
  },
];
