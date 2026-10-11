import type { CommandSpec } from '../types';
import { CliError } from '../types';
import { userSource } from '../sources';

// --help 不加载服务层；款式校验、目录与价格在 run 内读取唯一词汇表。
const username = { name: 'username', flags: [], positional: 0, required: true,
  label: '用户名', help: '目标用户的用户名', prompt: { type: 'search' as const, source: userSource() } };
const key = { name: 'key', flags: [], positional: 1, required: true,
  label: '气泡 key', help: '气泡 key，先用 bubble list 查看', prompt: { type: 'input' as const } };
const reason = { name: 'reason', flags: ['-r', '--reason'], label: '说明', help: '写入审计日志的原因', prompt: { type: 'input' as const } };

export const bubbleCommands: CommandSpec[] = [
  ...(['grant', 'revoke'] as const).map((action): CommandSpec => ({
    name: `bubble ${action}`, group: 'users', order: action === 'grant' ? 90 : 91,
    summary: action === 'grant' ? '授予聊天气泡（可限时）' : '撤销聊天气泡并恢复默认',
    readOnly: false, needsActor: true, danger: action === 'grant' ? 'safe' : 'destructive',
    args: [username, key, ...(action === 'grant' ? [{ name: 'days', flags: ['--days'], kind: 'int' as const,
      label: '有效天数', help: '省略为永久；指定正整数则从现在起 N 天，只延长不缩短',
      validate: (raw: string) => Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? null : 'days 必须是正整数',
      prompt: { type: 'number' as const, min: 1, integer: true } }] : []), reason],
    async describe(ctx) { return [`${action === 'grant' ? '授予' : '撤销'} ${ctx.args.username} 的气泡 ${ctx.args.key}${action === 'revoke' ? '，正在使用时会恢复默认（软删持有行）' : '，用户自行在设置页选择使用'}`]; },
    async run(ctx) {
      const refs = await import('../../../src/lib/bubble-refs');
      const parsed = refs.parseBubbleKey(ctx.args.key);
      if (!parsed) throw new CliError(`未知的气泡（可选：${refs.BUBBLE_KEYS.join(' / ')}）`);
      const user = await ctx.prisma.user.findUnique({ where: { username: String(ctx.args.username) }, select: { id: true } });
      if (!user) throw new CliError('用户不存在');
      const svc = await import('../../../src/lib/bubble-service');
      const { nowForDb } = await import('../../../src/lib/db-time');
      const days = ctx.args.days === undefined ? null : Number(ctx.args.days);
      if (days !== null && (!Number.isSafeInteger(days) || days < 1)) throw new CliError('days 必须是正整数');
      if (action === 'grant' && refs.BUBBLES[parsed].disabled) throw new CliError('这款气泡已停用');
      const result = action === 'grant'
        ? await svc.grantBubble({ userId: user.id, key: parsed, expiresAt: days === null ? null : new Date(nowForDb().getTime() + days * 86400000), source: 'cli' })
        : await svc.revokeBubble(user.id, parsed);
      const { logAdminAction } = await import('../../../src/lib/admin-user-service');
      const audit = 'expiresAt' in result
        ? { action: 'bubble_grant', metadata: { key: parsed, expires_at: result.expiresAt?.toISOString() ?? null, source: 'cli' } }
        : { action: 'bubble_revoke', metadata: { key: parsed, ...result, source: 'cli' } };
      await logAdminAction({ ...audit, adminId: ctx.actor!.id, targetUserId: user.id,
        objectType: 'user_bubble', objectId: parsed, reason: ctx.args.reason ? String(ctx.args.reason) : null,
      });
      return { lines: [`已${action === 'grant' ? '授予' : '撤销'}：${ctx.args.username} ← ${refs.BUBBLES[parsed].label}`], json: result };
    },
  })),
  { name: 'bubble list', group: 'users', order: 92, summary: '列出气泡定义、租金与持有状态', readOnly: true,
    args: [{ ...username, required: false, help: '指定时查看该用户的持有记录；省略时列款式与租金' }],
    async run(ctx) {
      const refs = await import('../../../src/lib/bubble-refs');
      if (ctx.args.username) {
        const user = await ctx.prisma.user.findUnique({ where: { username: String(ctx.args.username) }, select: { id: true } });
        if (!user) throw new CliError('用户不存在');
        const { listMyBubbles } = await import('../../../src/lib/bubble-service');
        const data = await listMyBubbles(user.id);
        return { lines: data.bubbles.map((b) => `${b.label}：${b.expiresAt ?? '永久'}${b.expired ? '（已过期）' : ''}${b.equipped ? '（已选择）' : ''}`), json: data };
      }
      const { RENT_UNITS } = await import('../../../src/lib/shop-refs');
      const rows = refs.BUBBLE_KEYS.map((k) => ({ key: k, ...refs.BUBBLES[k], sale: refs.bubbleSaleOf(k) }));
      return { lines: rows.map((r) => `${r.key} · ${r.label} · ${r.sale ? `${r.sale.price} ${RENT_UNITS[r.sale.unit].priceNoun}` : '停售'} · ${r.disabled ? '停用' : 'CSS 样式，无外部素材'}`), json: rows };
    },
  },
];
