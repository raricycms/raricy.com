// ─────────────────────────────────────────────────────────────────────────────
// stats.ts —— 站点概览
//
// 交互式向导打开时先看到的那个屏。回答「现在站点是什么状态」：
// 多少人、多少内容、**多少被删的东西**（那些是可以找回的）、多少待处理申诉、
// 多少鱼干账目没对上（那些是 fail-closed 留下的、要跑 fish sync-retry 收敛的）。
// ─────────────────────────────────────────────────────────────────────────────

import { renderKv } from '../output';
import type { CommandSpec } from '../types';

/** 字节数转成人看的。 */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const statsCommands: CommandSpec[] = [
  {
    name: 'stats overview',
    summary: '站点概览（人数 / 内容 / 待处理事项）',
    group: 'stats',
    order: 0,
    readOnly: true,
    args: [],
    async run(ctx) {
      const { getSiteStats } = await import('../../../src/lib/admin-stats-service');
      const s = await getSiteStats();

      const lines = [
        ctx.io.dim('── 用户 ──────────────────────────────'),
        ...renderKv([
          ['总数', s.users.total],
          ['分档', `user ${s.users.byRole.user} · core ${s.users.byRole.core} · admin ${s.users.byRole.admin} · owner ${s.users.byRole.owner}`],
          ['禁言中', s.users.banned],
          ['今日新增', s.users.newToday],
          ['近 7 日新增', s.users.new7d],
        ]),
        '',
        ctx.io.dim('── 内容 ──────────────────────────────'),
        ...renderKv([
          ['文章', `${s.blogs.total} 篇（已删 ${s.blogs.deleted}，今日 ${s.blogs.newToday}）`],
          ['评论', `${s.comments.total} 条（已删 ${s.comments.deleted}，今日 ${s.comments.newToday}）`],
          ['剪贴板', `${s.clips.total} 条（已删 ${s.clips.deleted}，私有 ${s.clips.private}）`],
          ['图床', `${s.images.total} 张（已删 ${s.images.deleted}）`],
          ['图床占用', humanBytes(s.images.storageBytes)],
          ['投票', `${s.votes.total} 个（已删 ${s.votes.deleted}），共 ${s.votes.records} 票`],
        ]),
        '',
        ctx.io.dim('── 待处理 ────────────────────────────'),
        ...renderKv([
          ['待审申诉', s.appeals.pending],
          ['鱼干待同步', s.fish.ledgerPending],
          ['鱼干同步失败', s.fish.ledgerFailed],
          ['鱼干已补偿', s.fish.ledgerCompensated],
        ]),
      ];

      const warnings: string[] = [];
      if (s.fish.ledgerPending > 0 || s.fish.ledgerFailed > 0) {
        warnings.push(
          `⚠️  有 ${s.fish.ledgerPending + s.fish.ledgerFailed} 条鱼干账目未同步 —— 跑 \`fish sync-retry\` 收敛。`
        );
      }
      if (s.appeals.pending > 0) {
        warnings.push(`⚠️  有 ${s.appeals.pending} 条待审申诉 —— 申诉积压会让被处罚的用户一直等。`);
      }

      const deletedTotal = s.blogs.deleted + s.comments.deleted + s.clips.deleted + s.images.deleted;
      const notes =
        deletedTotal > 0
          ? [`已删内容共 ${deletedTotal} 项，都可以用对应的 search + restore 找回来。`]
          : [];

      return { lines, warnings, notes, json: s };
    },
  },
];
