// ─────────────────────────────────────────────────────────────────────────────
// clips.ts —— 云剪贴板检索、查看、恢复、删除
//
// 站内此前既没有剪贴板搜索，也没有恢复入口（deleteClip 的注释写着「站长可恢复」，
// 但没有任何代码实现它）。这里补齐。
//
// 注意列表**不显示正文**（ClipText 上限 5 万字，一页就是近一兆）——
// 正文只在 clip show 里单独取。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderKv, renderTable } from '../output';
import { clipSource, preview } from '../sources';
import { CliError, type CommandSpec, type Ctx } from '../types';

const idArg = {
  name: 'id',
  flags: [],
  positional: 0,
  required: true,
  label: '剪贴板',
  help: '8 位短 id，交互模式下可先搜索再选',
  prompt: { type: 'search' as const, source: clipSource() },
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
      { value: 'deleted', label: '仅已删除', hint: '配合 clip restore 使用' },
    ],
  },
  validate: (raw: string) =>
    ['all', 'active', 'deleted'].includes(raw) ? null : '只能是 all / active / deleted',
};

const reasonArg = {
  name: 'reason',
  flags: ['--reason', '-r'],
  label: '原因',
  help: '会写进公开审计日志',
  prompt: { type: 'input' as const },
};

async function lookup(ctx: Ctx, id: string) {
  const clip = await ctx.prisma.clipBoard.findUnique({
    where: { id },
    select: { id: true, title: true, ignore: true, publicity: true, authorId: true, author: { select: { username: true } } },
  });
  if (!clip) throw new CliError(`错误：剪贴板 ${id} 不存在`);
  return clip;
}

export const clipCommands: CommandSpec[] = [
  {
    name: 'clip search',
    summary: '搜云剪贴板（含已删与私有）',
    group: 'clips',
    order: 0,
    readOnly: true,
    args: [
      {
        name: 'keyword',
        flags: ['--keyword', '-q'],
        positional: 0,
        label: '关键词',
        help: '标题 / 正文 / 作者 / 8 位 id；留空 = 最近一页',
        prompt: { type: 'input' as const },
      },
      statusArg,
      {
        name: 'publicity',
        flags: ['--publicity'],
        defaultValue: 'all',
        label: '可见性',
        help: 'all（默认）| public（公开）| private（仅作者与站长可见）',
        prompt: {
          type: 'select' as const,
          choices: [
            { value: 'all', label: '全部' },
            { value: 'public', label: '仅公开' },
            { value: 'private', label: '仅私有', hint: '网页端不会列出的那些' },
          ],
        },
        validate: (raw: string) =>
          ['all', 'public', 'private'].includes(raw) ? null : '只能是 all / public / private',
      },
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const { listAdminClips } = await import('../../../src/lib/admin-clipboard-service');
      const r = await listAdminClips({
        page: Number(ctx.args.page ?? 1),
        perPage: 20,
        search: ctx.args.keyword ? String(ctx.args.keyword) : null,
        status: String(ctx.args.status) as 'all' | 'active' | 'deleted',
        publicity: String(ctx.args.publicity) as 'all' | 'public' | 'private',
      });

      const lines = renderTable(
        [
          { key: 'title', title: '标题', maxWidth: 30 },
          { key: 'author', title: '作者', maxWidth: 14 },
          { key: 'createdAt', title: '创建时间', maxWidth: 19 },
          { key: 'visibility', title: '可见性', maxWidth: 8 },
          { key: 'state', title: '状态', maxWidth: 8 },
          { key: 'id', title: 'ID', maxWidth: 8 },
        ],
        r.clips.map((c) => ({
          title: c.title,
          author: c.author?.username ?? '—',
          createdAt: ymdhms(c.createdAt) ?? '—',
          visibility: c.publicity ? '公开' : '私有',
          state: c.ignore ? '已删除' : '正常',
          id: c.id,
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有匹配的剪贴板）' }
      );

      return {
        lines,
        notes: [`共 ${r.total} 条，第 ${r.page}/${r.pages} 页`, '用 clip show <id> 看正文'],
        json: r,
      };
    },
  },

  {
    name: 'clip show',
    summary: '查看剪贴板详情（含正文）',
    group: 'clips',
    order: 1,
    readOnly: true,
    args: [
      idArg,
      {
        name: 'full',
        flags: ['--full'],
        kind: 'boolean' as const,
        label: '显示完整正文',
        help: '默认只显示开头 200 字（正文上限 5 万字）',
        prompt: { type: 'confirm' as const },
      },
    ],
    async run(ctx) {
      const id = String(ctx.args.id);
      const { getClipForAdmin } = await import('../../../src/lib/admin-clipboard-service');
      const clip = await getClipForAdmin(id);
      if (!clip) throw new CliError(`错误：剪贴板 ${id} 不存在`);

      const body = clip.content?.content ?? '';
      const lines = renderKv([
        ['标题', clip.title],
        ['剪贴板 ID', clip.id],
        ['作者', clip.author?.username ?? '—'],
        ['可见性', clip.publicity ? '公开' : '私有（仅作者与站长可见）'],
        ['状态', clip.ignore ? '已删除' : '正常'],
        ['创建时间', ymdhms(clip.createdAt)],
        ['正文更新', ymdhms(clip.content?.updatedAt)],
        ['正文长度', `${body.length} 字`],
      ]);

      lines.push('', ctx.args.full ? body : preview(body, 200));
      if (!ctx.args.full && body.length > 200) {
        lines.push('', ctx.io.dim('（已截断，加 --full 看完整正文）'));
      }

      return { lines, json: { ...clip, content: body } };
    },
  },

  {
    name: 'clip restore',
    summary: '恢复被删除的剪贴板',
    group: 'clips',
    order: 2,
    needsActor: true,
    danger: 'destructive',
    args: [idArg, reasonArg],
    async describe(ctx) {
      const clip = await lookup(ctx, String(ctx.args.id));
      if (!clip.ignore) throw new CliError('错误：该剪贴板未被删除');
      return [
        `标题：${clip.title}`,
        `作者：${clip.author?.username ?? '—'}`,
        `可见性：${clip.publicity ? '公开' : '私有'}`,
        '变更：ClipBoard.ignore → false（作者可重新在自己的列表里看到）',
        clip.publicity
          ? '恢复后它是**公开**的：任何 core 用户都能通过链接访问。'
          : '它是私有剪贴板，恢复后仍只有作者与站长可见。',
        '本次操作会写入审计日志（公开可见）。',
      ];
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const { restoreClip } = await import('../../../src/lib/admin-clipboard-service');
      const r = await restoreClip(
        id,
        ctx.actor!,
        ctx.args.reason ? String(ctx.args.reason) : undefined
      );
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { id } };
    },
  },

  {
    name: 'clip delete',
    summary: '删除剪贴板（软删）',
    group: 'clips',
    order: 3,
    needsActor: true,
    danger: 'destructive',
    args: [idArg, reasonArg],
    async describe(ctx) {
      const clip = await lookup(ctx, String(ctx.args.id));
      if (clip.ignore) throw new CliError('错误：该剪贴板已被删除');
      return [
        `标题：${clip.title}`,
        `作者：${clip.author?.username ?? '—'}`,
        '变更：ClipBoard.ignore → true（软删，随时可用 clip restore 找回）',
        '本次操作会写入审计日志（公开可见）。',
      ];
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const { softDeleteClip } = await import('../../../src/lib/admin-clipboard-service');
      const r = await softDeleteClip(id, ctx.actor!, String(ctx.args.reason ?? ''));
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { id } };
    },
  },
];
