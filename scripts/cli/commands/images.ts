// ─────────────────────────────────────────────────────────────────────────────
// images.ts —— 图床检索、查看、恢复
//
// **刻意不提供物理删除**。CLAUDE.md：「永不物理删除（站长手动例外）」。
// 恢复已经覆盖了可逆的那一半，而加一个不可逆的 CLI flag 是纯粹的脚枪 ——
// 收益为零（真要物理删，站长手动去 instance/images/ 删文件即可）。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderKv, renderTable } from '../output';
import { imageSource } from '../sources';
import { CliError, type CommandSpec } from '../types';

/** 字节数转成人看的（存储占用动辄几十上百 MB）。 */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const idArg = {
  name: 'id',
  flags: [],
  positional: 0,
  required: true,
  label: '图片',
  help: '10 位短 id，交互模式下可先搜索再选',
  prompt: { type: 'search' as const, source: imageSource() },
};

export const imageCommands: CommandSpec[] = [
  {
    name: 'image search',
    summary: '搜图床（含已删）',
    group: 'images',
    order: 0,
    readOnly: true,
    args: [
      {
        name: 'keyword',
        flags: ['--keyword', '-q'],
        positional: 0,
        label: '关键词',
        help: '文件名 / 作者 / 10 位 id；留空 = 最近一页',
        prompt: { type: 'input' as const },
      },
      {
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
      },
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const { listAdminImages } = await import('../../../src/lib/admin-image-service');
      const r = await listAdminImages({
        page: Number(ctx.args.page ?? 1),
        perPage: 20,
        search: ctx.args.keyword ? String(ctx.args.keyword) : null,
        status: String(ctx.args.status) as 'all' | 'active' | 'deleted',
      });

      const lines = renderTable(
        [
          { key: 'filename', title: '文件名', maxWidth: 30 },
          { key: 'author', title: '作者', maxWidth: 14 },
          { key: 'size', title: '大小', align: 'right' },
          { key: 'createdAt', title: '上传时间', maxWidth: 19 },
          { key: 'state', title: '状态', maxWidth: 8 },
          { key: 'id', title: 'ID', maxWidth: 10 },
        ],
        r.images.map((i) => ({
          filename: i.filename,
          author: i.author?.username ?? '—',
          size: humanBytes(i.fileSize),
          createdAt: ymdhms(i.createdAt) ?? '—',
          state: i.ignore ? '已删除' : '正常',
          id: i.id,
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有匹配的图片）' }
      );

      return { lines, notes: [`共 ${r.total} 张，第 ${r.page}/${r.pages} 页`], json: r };
    },
  },

  {
    name: 'image show',
    summary: '查看图床记录详情（含磁盘文件是否还在）',
    group: 'images',
    order: 1,
    readOnly: true,
    args: [idArg],
    async run(ctx) {
      const id = String(ctx.args.id);
      const { getImageForAdmin } = await import('../../../src/lib/admin-image-service');
      const img = await getImageForAdmin(id);
      if (!img) throw new CliError(`错误：图片 ${id} 不存在`);

      const warnings: string[] = [];
      if (!img.fileExists) {
        warnings.push('⚠️  磁盘上找不到这个文件：即使恢复记录，页面上也会是坏图。');
      }

      const lines = renderKv([
        ['文件名', img.filename],
        ['图片 ID', img.id],
        ['作者', img.author?.username ?? '—'],
        ['类型 / 大小', `${img.mimeType} · ${humanBytes(img.fileSize)}`],
        ['公开', img.isPublic ? '是' : '否'],
        ['状态', img.ignore ? '已删除' : '正常'],
        ['上传时间', ymdhms(img.createdAt)],
        ['磁盘文件', img.fileExists ? '在' : '不在'],
        ['直链', `/api/images/${img.id}/raw`],
      ]);

      return { lines, warnings, json: img };
    },
  },

  {
    name: 'image restore',
    summary: '恢复被删除的图片记录',
    group: 'images',
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
      const id = String(ctx.args.id);
      const { getImageForAdmin } = await import('../../../src/lib/admin-image-service');
      const img = await getImageForAdmin(id);
      if (!img) throw new CliError(`错误：图片 ${id} 不存在`);
      if (!img.ignore) throw new CliError('错误：该图片未被删除');

      const lines = [
        `文件名：${img.filename}`,
        `作者：${img.author?.username ?? '—'}`,
        '变更：ImageHosting.ignore → false',
        '本次操作会写入审计日志（公开可见）。',
      ];
      if (!img.fileExists) {
        // 这条必须在动手之前说 —— 恢复完才发现是坏图就晚了
        lines.push(
          '⚠️ 磁盘上**找不到**这个文件（软删不删文件，可能是被手工清理过或数据从别处还原）。',
          '   恢复后记录有效但图片打不开 —— 除非你确定文件还会回来，否则没必要恢复。'
        );
      }
      return lines;
    },
    async run(ctx) {
      const id = String(ctx.args.id);
      const { restoreImage } = await import('../../../src/lib/admin-image-service');
      const r = await restoreImage(
        id,
        ctx.actor!,
        ctx.args.reason ? String(ctx.args.reason) : undefined
      );
      if (!r.ok) throw new CliError(`错误：${r.message}`);

      const warnings = r.fileExists
        ? []
        : ['⚠️  记录已恢复，但磁盘上没有对应文件 —— 页面上会是坏图。'];
      return { lines: [ctx.io.green(`成功：${r.message}`)], warnings, json: { id, fileExists: r.fileExists } };
    },
  },
];
