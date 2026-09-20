// ─────────────────────────────────────────────────────────────────────────────
// frames.ts —— 头像框的运维命令（发放 / 收回 / 盘点）
//
// 【为什么只有站长发放这一条路】框是**授权**，不是商品（第一版）。用户侧只有
// 「戴哪个」（/settings 的面板），「有没有资格戴」由这里决定。第二版会加上鱼干购买，
// 那时 `grantFrame({ source: 'purchase' })` 已经就位，本文件不用改。
//
// 【顶层只 import 了 frame-refs】它是白名单里的**运行时零依赖**模块（见
// tests/unit/cli-guards.test.ts 的 LIB_ALLOWLIST）—— `--help` 与向导菜单在没有
// 数据库的机器上也要能渲染。服务层一律在 run() / describe() 里 `await import()`。
//
// 【退出码】本域**没有远端依赖**，所以 CliError 的 1/2 分得很干净：
//   · 1 = 参数 / 用户错误（key 没登记、用户不存在、本来就没持有……）—— 预检阶段就能判
//   · 2 = 本地事务失败（预检过了、真去写的时候炸了）—— 那是真故障
// 与 fish 域那条「2 = 同步失败」不是一回事（账户服务搬进站内之后那个语义也没了）。
// ─────────────────────────────────────────────────────────────────────────────

import type { CommandSpec, Ctx } from '../types';
import { CliError } from '../types';
import {
  FRAMES,
  FRAME_KEYS,
  parseFrameKey,
  frameLabel,
  type FrameKey,
} from '../../../src/lib/frame-refs';

/** 每个 key 的候选：「显示名（key）」—— 向导里既能认名字、也看得见写到库里的字面量。 */
const KEY_CHOICES = FRAME_KEYS.map((k) => ({
  value: k as string,
  label: FRAMES[k].label,
  hint: k,
}));

const usernameArg = {
  name: 'username',
  flags: [],
  positional: 0,
  required: true,
  label: '用户名',
  help: '目标用户的用户名',
  prompt: { type: 'input' as const },
};

const keyArg = {
  name: 'key',
  flags: [],
  positional: 1,
  required: true,
  label: '头像框',
  help: '框的 key（见 --help 或 frame list --keys）',
  prompt: { type: 'select' as const, choices: KEY_CHOICES },
  // 同步校验：解析要在写库之前发生，且报错里要列出全部合法值 ——
  // 只回一句「未知的头像框」会让人去翻源码
  validate: (raw: string) =>
    parseFrameKey(raw) ? null : `未知的头像框：${raw}（合法值：${FRAME_KEYS.join(' / ')}）`,
};

const reasonArg = {
  name: 'reason',
  flags: ['-r', '--reason'],
  label: '说明',
  help: '写进审计日志的 reason（建议写清为什么发/收回）',
  prompt: { type: 'input' as const, placeholder: '例如：2026 中秋活动' },
};

/** 把「N 天」算成绝对时刻。**必须用 nowForDb()** —— 库里的时间语义是 UTC+8 墙上时间。 */
async function expiryFromDays(days: number): Promise<Date> {
  const { nowForDb } = await import('../../../src/lib/db-time');
  return new Date(nowForDb().getTime() + days * 24 * 60 * 60 * 1000);
}

/** 读回一条持有行（含墓碑），供 describe / run 共用。 */
async function holding(
  prisma: Ctx['prisma'],
  userId: string,
  key: FrameKey
): Promise<{ expiresAt: Date | null; deleted: boolean } | null> {
  return prisma.userFrame.findUnique({
    where: { uq_user_frame: { userId, frameKey: key } },
    select: { expiresAt: true, deleted: true },
  });
}

async function requireUser(prisma: Ctx['prisma'], username: string): Promise<{ id: string }> {
  const u = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!u) throw new CliError(`错误：用户 ${username} 不存在`);
  return u;
}

/** 素材体检的一句话结论。发框时顺手报一下 —— 白名单里有、盘上没图是最常见的坑。 */
async function assetWarning(key: FrameKey): Promise<string | null> {
  const { auditFrameAssets } = await import('../../../src/lib/frame-service');
  const row = auditFrameAssets().find((r) => r.key === key);
  if (!row) return null;
  if (!row.available) {
    return `instance/frames/${key}.png 不存在 —— 授权已经写库成功，但**全站都不会显示这个框**。把素材拷上去即可（不需要重新发放）。`;
  }
  if (row.hasAlpha === false) {
    return `instance/frames/${key}.png **没有透明通道** —— 它会盖住用户的脸。请重新导出一张中间透明的 PNG。`;
  }
  return null;
}

export const frameCommands: CommandSpec[] = [
  // ── frame grant ────────────────────────────────────────────────────────────
  {
    name: 'frame grant',
    summary: '给用户发放头像框（可限时）',
    group: 'frame',
    order: 0,
    readOnly: false,
    needsActor: true,
    // 可逆（frame revoke 收得回来），不设确认闸
    danger: 'safe',
    args: [
      usernameArg,
      keyArg,
      {
        name: 'days',
        flags: ['--days'],
        kind: 'int' as const,
        label: '有效天数',
        help: '留空 = 永久；给了则从现在起 N 天内有效',
        validate: (raw: string) => {
          if (raw === '') return null; // 留空 = 永久
          const n = Number(raw);
          return Number.isInteger(n) && n >= 1 ? null : 'days 必须是正整数（留空 = 永久）';
        },
        prompt: { type: 'number' as const, integer: true, min: 1 },
      },
      reasonArg,
    ],
    details: [
      '把某个头像框授予某个用户。**授予 ≠ 装备** —— 用户自己去 /settings 选择戴不戴。',
      '',
      '幂等且**只延长不缩短**：该用户已持有该框时，取「原到期时刻」与「新的到期时刻」的',
      '较晚者。要缩短或收回，用 `frame revoke`。',
      '',
      '⚠️ 发了但盘上没有素材（instance/frames/<key>.png）时**只打黄色警告，不算失败** ——',
      '   授权本身已经写库成功，素材是运维自己的事，补上即可（不需要重新发放）。',
    ].join('\n'),
    async describe(ctx) {
      const username = String(ctx.args.username);
      const key = parseFrameKey(ctx.args.key);
      if (!key) return [`头像框 ${String(ctx.args.key)} 未登记（合法值：${FRAME_KEYS.join(' / ')}）`];

      const u = await ctx.prisma.user.findUnique({
        where: { username },
        select: { id: true, equippedFrameKey: true },
      });
      if (!u) return [`用户 ${username} 不存在`];

      const days = ctx.args.days === undefined ? null : Number(ctx.args.days);
      const line =
        days === null ? '永久（不过期）' : `从现在起 ${days} 天`;

      const row = await holding(ctx.prisma, u.id, key);
      const out = [`把「${frameLabel(key)}」发给 ${username}（${line}）`];

      if (row && !row.deleted) {
        if (row.expiresAt === null) out.push('⚠️ 他已经是**永久**持有 —— 这次是空操作');
        else out.push(`他当前持有到 ${row.expiresAt.toISOString()}（只会延长，不会缩短）`);
      } else if (row && row.deleted) {
        out.push('他此前持有过、已被收回 —— 会复活那一行（不是新插一行）');
      }
      if (u.equippedFrameKey === key) out.push('他此刻**正戴着**这个框 —— 到期时刻会同步刷新');
      return out;
    },
    async run(ctx) {
      const username = String(ctx.args.username);
      const parsed = parseFrameKey(ctx.args.key);
      if (!parsed) {
        throw new CliError(`错误：未知的头像框 ${String(ctx.args.key)}（合法值：${FRAME_KEYS.join(' / ')}）`);
      }
      const key = parsed;
      const user = await requireUser(ctx.prisma, username);

      const days = ctx.args.days === undefined ? null : Number(ctx.args.days);
      const expiresAt = days === null ? null : await expiryFromDays(days);

      const { grantFrame } = await import('../../../src/lib/frame-service');
      const res = await grantFrame({
        userId: user.id,
        key,
        expiresAt,
        source: 'cli',
      });

      if (!res.ok) {
        // 预检（用户存在 / key 合法）都过了还失败 → 本地事务炸了 = 真故障
        throw new CliError(`发放失败：${res.message}`, 2);
      }

      const { logAdminAction } = await import('../../../src/lib/admin-user-service');
      await logAdminAction({
        action: 'frame_grant',
        adminId: ctx.actor!.id,
        targetUserId: user.id,
        objectType: 'user_frame',
        objectId: key,
        reason: ctx.args.reason ? String(ctx.args.reason) : null,
        metadata: { expires_at: res.expiresAt?.toISOString() ?? null, source: 'cli' },
      });

      const ACTION: Record<string, string> = {
        created: '已发放',
        revived: '已重新发放（复活了此前收回的那一行）',
        extended: '已延长',
        noop: '未变更（只延长不缩短）',
      };
      const warnings: string[] = [];
      const asset = await assetWarning(key);
      if (asset) warnings.push(asset);

      return {
        lines: [
          `${ACTION[res.action]}：${username} ← 「${frameLabel(key) ?? key}」`,
          `到期：${res.expiresAt ? res.expiresAt.toISOString() : '永久'}`,
        ],
        json: {
          username,
          key,
          action: res.action,
          expires_at: res.expiresAt?.toISOString() ?? null,
          refreshed_equip: res.refreshedEquip,
        },
        warnings,
      };
    },
  },

  // ── frame revoke ───────────────────────────────────────────────────────────
  {
    name: 'frame revoke',
    summary: '收回某人的头像框（立即失效，并摘下）',
    group: 'frame',
    order: 1,
    readOnly: false,
    needsActor: true,
    danger: 'destructive',
    args: [usernameArg, keyArg, reasonArg],
    details: [
      '把持有行翻墓碑（**不物理删**，全站口径），且在**同一个事务里**清掉装备指针。',
      '',
      '幂等：没持有过、或已经收回过的，照样成功。',
      '',
      '⚠️ 若该用户正戴着这个框，收回会**顺带把它摘下来** —— 确认屏会明说。',
      '⚠️ 与「到期」不是一回事：到期的框是**懒判定**（列上留值、判定恒 null、无清理），',
      '   而收回会真的翻墓碑。想让它下周失效，用 `frame grant --days 7`，别用 revoke。',
    ].join('\n'),
    async describe(ctx) {
      const username = String(ctx.args.username);
      const key = parseFrameKey(ctx.args.key);
      if (!key) return [`头像框 ${String(ctx.args.key)} 未登记`];

      const u = await ctx.prisma.user.findUnique({
        where: { username },
        select: { id: true, equippedFrameKey: true },
      });
      if (!u) return [`用户 ${username} 不存在`];

      const row = await holding(ctx.prisma, u.id, key);
      const out: string[] = [];
      if (!row || row.deleted) {
        out.push(`⚠️ ${username} 当前**没有**持有「${frameLabel(key)}」—— 这条命令会是空操作`);
        return out;
      }
      out.push(`收回 ${username} 的「${frameLabel(key)}」`);
      out.push(`他当前持有到：${row.expiresAt ? row.expiresAt.toISOString() : '永久'}`);
      if (u.equippedFrameKey === key) out.push('⚠️ 他正戴着它 —— 会顺带摘下');
      return out;
    },
    async run(ctx) {
      const username = String(ctx.args.username);
      const parsed = parseFrameKey(ctx.args.key);
      if (!parsed) throw new CliError(`错误：未知的头像框 ${String(ctx.args.key)}`);
      const key = parsed;
      const user = await requireUser(ctx.prisma, username);

      const { revokeFrame } = await import('../../../src/lib/frame-service');
      const res = await revokeFrame({ userId: user.id, key });

      // 幂等：空操作也写审计吗？**写** —— 账要能回答「谁在什么时候动过这个框」，
      // 而「某人执行了一次没生效的收回」本身也是运维事实（多半是敲错了用户名）。
      const { logAdminAction } = await import('../../../src/lib/admin-user-service');
      await logAdminAction({
        action: 'frame_revoke',
        adminId: ctx.actor!.id,
        targetUserId: user.id,
        objectType: 'user_frame',
        objectId: key,
        reason: ctx.args.reason ? String(ctx.args.reason) : null,
        metadata: { revoked: res.revoked, unequipped: res.unequipped },
      });

      return {
        lines: [
          res.revoked
            ? `已收回：${username} 的「${frameLabel(key) ?? key}」`
            : `${username} 本来就没持有「${frameLabel(key) ?? key}」—— 空操作`,
        ],
        json: { username, key, revoked: res.revoked, unequipped: res.unequipped },
        notes: res.unequipped ? [`已顺带摘下他正戴着的这个框`] : [],
      };
    },
  },

  // ── frame list ─────────────────────────────────────────────────────────────
  {
    name: 'frame list',
    summary: '列出头像框的持有与素材状态',
    group: 'frame',
    order: 2,
    readOnly: true,
    args: [
      {
        ...usernameArg,
        required: false,
        help: '只看某一个人的；留空则列全部持有记录',
      },
      {
        name: 'keys',
        flags: ['--keys'],
        kind: 'boolean' as const,
        label: '只看素材',
        help: '只列白名单里每个框的素材状态（在不在盘上、带不带透明通道）',
        defaultValue: false,
        prompt: { type: 'confirm' as const },
      },
    ],
    details: [
      '★ **这是运维唯一能发现「白名单里有这个框、盘上却没有图」的地方** ——',
      '  那种情况下全站静默不显示框，页面不报任何错（渲染侧由 frame-service 的',
      '  第三道闸挡住，判成「暂时没显示」而不是报错）。',
      '',
      '`--keys` 只体检素材：在不在盘上 / 带不带透明通道 / 多大。',
      '不带透明通道的素材会**盖住用户的脸**，那是全站一起坏的一种。',
    ].join('\n'),
    async run(ctx) {
      const { auditFrameAssets } = await import('../../../src/lib/frame-service');

      // ── 素材体检 ──
      if (ctx.args.keys === true) {
        const rows = auditFrameAssets().map((r) => ({
          key: r.key,
          label: r.label,
          asset: r.available ? '有' : '缺失',
          alpha: r.available ? (r.hasAlpha === true ? '有' : r.hasAlpha === false ? '无' : '?') : '—',
          bytes: r.bytes === null ? '—' : String(r.bytes),
        }));
        const bad = rows.filter((r) => r.asset === '缺失' || r.alpha === '无');
        return {
          lines: rows.map(
            (r) => `${r.key}\t${r.label}\t素材:${r.asset}\t透明通道:${r.alpha}\t${r.bytes} 字节`
          ),
          json: { frames: rows },
          warnings: bad.map((r) =>
            r.asset === '缺失'
              ? `${r.key}：白名单里有、盘上没图 —— 全站都不会显示它`
              : `${r.key}：素材没有透明通道 —— 会盖住用户的脸`
          ),
        };
      }

      // ── 持有记录 ──
      const username = ctx.args.username === undefined ? null : String(ctx.args.username);
      let userId: string | null = null;
      if (username !== null) {
        const u = await ctx.prisma.user.findUnique({
          where: { username },
          select: { id: true },
        });
        if (!u) throw new CliError(`错误：用户 ${username} 不存在`);
        userId = u.id;
      }

      const rows = await ctx.prisma.userFrame.findMany({
        where: userId ? { userId } : {},
        select: {
          userId: true,
          frameKey: true,
          expiresAt: true,
          source: true,
          deleted: true,
          user: { select: { username: true, equippedFrameKey: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });

      const { nowForDb } = await import('../../../src/lib/db-time');
      const { ymdhms } = await import('../../../src/lib/format');
      const now = nowForDb();

      const out = rows.map((r) => {
        const expired = r.expiresAt !== null && now > r.expiresAt;
        const status = r.deleted ? '已收回' : expired ? '已过期' : r.expiresAt ? '有效' : '永久';
        return {
          username: r.user.username,
          key: r.frameKey,
          label: frameLabel(r.frameKey) ?? r.frameKey,
          source: r.source,
          expires_at: r.expiresAt ? (ymdhms(r.expiresAt) ?? '') : '永久',
          status,
          equipped: r.user.equippedFrameKey === r.frameKey && !r.deleted ? '是' : '',
        };
      });

      const notes: string[] = [];
      if (username === null && rows.length === 500) {
        notes.push('结果被截断在 500 行 —— 加个用户名可以看全某个人的');
      }

      return {
        lines: out.map(
          (r) =>
            `${r.username}\t${r.label}(${r.key})\t${r.status}\t到期:${r.expires_at}\t来源:${r.source}` +
            (r.equipped ? '\t佩戴中' : '')
        ),
        json: { rows: out },
        notes,
      };
    },
  },
];
