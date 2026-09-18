// ─────────────────────────────────────────────────────────────────────────────
// users.ts —— 用户检索、详情、重置密码、禁言、强制下线
//
// 权限分档一律交给服务层（banUser / unbanUser / resetUserPassword / forceLogout
// 各自带自己的判定）。CLI 这边只做两件事：把参数收齐、把「做不到」的原因在
// 确认之前用人话讲出来（describe）。
// ─────────────────────────────────────────────────────────────────────────────

import { ymdhms } from '../../../src/lib/format';
import { renderKv, renderTable } from '../output';
import { userSource } from '../sources';
import { CliError, type CommandSpec, type Ctx } from '../types';

/** 取目标用户；不存在即报错。 */
async function lookup(ctx: Ctx, username: string) {
  const user = await ctx.prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, role: true, isBanned: true, banUntil: true },
  });
  if (!user) throw new CliError(`错误：用户 ${username} 不存在`);
  return user;
}

/** 指定一个真实用户当审计主体 —— 命令自己要先确认这个人在。 */
function requireActor(ctx: Ctx) {
  if (!ctx.actor) throw new CliError('错误：该命令需要审计主体');
  return ctx.actor;
}

const usernameArg = {
  name: 'username',
  flags: [],
  positional: 0,
  required: true,
  label: '用户名',
  help: '目标用户的用户名',
  prompt: { type: 'search' as const, source: userSource() },
};

const reasonArg = {
  name: 'reason',
  flags: ['--reason', '-r'],
  required: true,
  label: '原因（写进审计日志）',
  help: '1..200 字，会写进内部审计日志（不进 /audit 公示页）',
  prompt: { type: 'input' as const },
  validate: (raw: string) => {
    const t = raw.trim();
    if (!t) return '必须填写原因';
    return t.length > 200 ? '原因过长（最多 200 字）' : null;
  },
};

export const userCommands: CommandSpec[] = [
  {
    name: 'user search',
    summary: '按用户名 / 邮箱搜索用户',
    group: 'users',
    order: 0,
    readOnly: true,
    args: [
      {
        name: 'keyword',
        flags: ['--keyword', '-q'],
        positional: 0,
        label: '关键词',
        help: '用户名或邮箱片段；留空 = 最近 50 个',
        prompt: { type: 'input' as const },
      },
      { name: 'page', flags: ['--page'], kind: 'int', label: '页码', help: '默认 1' },
    ],
    async run(ctx) {
      const { listUsers } = await import('../../../src/lib/admin-user-service');
      const r = await listUsers({
        page: Number(ctx.args.page ?? 1),
        perPage: 50,
        search: ctx.args.keyword ? String(ctx.args.keyword) : null,
      });

      const lines = renderTable(
        [
          { key: 'username', title: '用户名', maxWidth: 20 },
          { key: 'role', title: '角色', maxWidth: 6 },
          { key: 'email', title: '邮箱', maxWidth: 28 },
          { key: 'state', title: '状态', maxWidth: 12 },
          { key: 'createdAt', title: '注册时间', maxWidth: 19 },
          { key: 'lastLogin', title: '最后登录', maxWidth: 19 },
        ],
        r.users.map((u) => ({
          username: u.username,
          role: u.role,
          email: u.email,
          state: u.currentlyBanned ? '禁言中' : '正常',
          createdAt: ymdhms(u.createdAt ? new Date(u.createdAt) : null) ?? '—',
          lastLogin: ymdhms(u.lastLogin ? new Date(u.lastLogin) : null) ?? '—',
        })),
        { maxWidth: ctx.io.width(), emptyText: '（没有匹配的用户）' }
      );

      return { lines, notes: [`共 ${r.total} 人，第 ${r.page}/${r.pages} 页`], json: r };
    },
  },

  {
    name: 'user show',
    summary: '查看单个用户的详情（角色 / 禁言 / 余额 / 内容量）',
    group: 'users',
    order: 1,
    readOnly: true,
    args: [usernameArg],
    async run(ctx) {
      const username = String(ctx.args.username);
      const user = await ctx.prisma.user.findUnique({
        where: { username },
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          isBanned: true,
          banUntil: true,
          banReason: true,
          createdAt: true,
          lastLogin: true,
          sessionVersion: true,
          driedFish: true,
          _count: { select: { blogs: true, comments: true } },
        },
      });
      if (!user) throw new CliError(`错误：用户 ${username} 不存在`);

      const { isCurrentlyBanned } = await import('../../../src/lib/auth');
      const { unitsToFish } = await import('../../../src/lib/fish-units');
      const banned = isCurrentlyBanned(user);

      const lines = renderKv([
        ['用户名', user.username],
        ['用户 ID', user.id],
        ['邮箱', user.email],
        ['角色', user.role],
        ['状态', banned ? `禁言中（至 ${ymdhms(user.banUntil)}）` : '正常'],
        ['禁言原因', user.banReason],
        ['鱼干余额', unitsToFish(user.driedFish)],
        ['文章数', user._count.blogs],
        ['评论数', user._count.comments],
        ['注册时间', ymdhms(user.createdAt)],
        ['最后登录', ymdhms(user.lastLogin)],
        ['会话版本', user.sessionVersion],
      ]);

      return {
        lines,
        json: { ...user, driedFish: unitsToFish(user.driedFish), currentlyBanned: banned },
      };
    },
  },

  {
    name: 'user reset-password',
    summary: '重置某用户的密码（旧会话全部失效）',
    group: 'users',
    order: 2,
    needsActor: true,
    danger: 'destructive',
    details: [
      '站长专属。默认生成 16 位随机密码，执行后**仅显示一次**。',
      '不校验原密码 —— 这正是它与网页端「修改密码」的区别（用户忘了密码 / 邮箱被盗时用），',
      '也是它仅限站长、且不允许对自己用的原因。',
    ].join('\n'),
    args: [
      usernameArg,
      {
        name: 'mode',
        flags: [],
        positional: 1,
        label: '密码来源',
        help: 'generate（生成随机密码）| manual（用 --password 传入）',
        defaultValue: 'generate',
        prompt: {
          type: 'select',
          choices: [
            { value: 'generate', label: '生成随机密码', hint: '推荐：不会留在 shell 历史里' },
            { value: 'manual', label: '手动输入', hint: '会留在 shell 历史 / CI 日志里' },
          ],
        },
        validate: (raw) => (['generate', 'manual'].includes(raw) ? null : '只能是 generate 或 manual'),
      },
      {
        name: 'password',
        flags: ['--password'],
        secret: true,
        requiredIf: (a) => a.mode === 'manual',
        label: '新密码',
        help: '至少 8 位；⚠️ 会留在 shell 历史里',
        prompt: { type: 'password' as const },
        validate: (raw) => (raw.trim().length >= 8 ? null : '新密码长度至少为 8 位'),
      },
      reasonArg,
    ],
    async describe(ctx) {
      const target = await lookup(ctx, String(ctx.args.username));
      const actor = requireActor(ctx);
      if (target.id === actor.id) throw new CliError('错误：不能重置自己的密码，请用网页端「修改密码」');
      return [
        `目标用户：${target.username}（${target.role}）`,
        '后果：该用户所有已登录会话立即失效，必须用新密码重新登录。',
        ctx.args.mode === 'manual'
          ? '新密码：使用 --password 传入的值。'
          : '新密码：随机生成，命令结束后仅显示一次。',
        '本次操作会写入审计日志（**不含密码**；内部留痕，不进 /audit 公示页）。',
      ];
    },
    async run(ctx) {
      const target = await lookup(ctx, String(ctx.args.username));
      const { resetUserPassword } = await import('../../../src/lib/admin-user-service');

      const r = await resetUserPassword({
        actor: requireActor(ctx),
        targetId: target.id,
        newPassword: ctx.args.mode === 'manual' ? String(ctx.args.password) : null,
        reason: String(ctx.args.reason),
      });
      if (!r.ok) throw new CliError(`错误：${r.message}`);

      return {
        lines: [
          ctx.io.green(`成功：已重置 ${target.username} 的密码（旧会话已全部失效）`),
          '',
          `  新密码：${r.password}`,
          '',
        ],
        warnings: ['⚠️  新密码仅此一次显示，请立即通过安全渠道转交。'],
        json: { username: target.username, password: r.password, sessionVersion: r.sessionVersion },
      };
    },
  },

  {
    name: 'user ban',
    summary: '禁言用户（可设时长与原因）',
    group: 'users',
    order: 3,
    needsActor: true,
    danger: 'destructive',
    args: [
      usernameArg,
      {
        name: 'hours',
        flags: ['--hours'],
        positional: 1,
        required: true,
        kind: 'int',
        label: '禁言小时数',
        help: '正整数',
        prompt: { type: 'number' as const, integer: true, min: 1 },
        validate: (raw) => (Number.parseInt(raw, 10) > 0 ? null : '禁言时长必须大于 0'),
      },
      reasonArg,
    ],
    async describe(ctx) {
      const target = await lookup(ctx, String(ctx.args.username));
      const actor = requireActor(ctx);
      if (target.id === actor.id) throw new CliError('错误：不能禁言自己');
      if (target.role === 'admin' || target.role === 'owner') {
        throw new CliError('错误：不能禁言管理员');
      }
      const hours = Number(ctx.args.hours);
      return [
        `目标用户：${target.username}（当前 ${target.role}${target.isBanned ? '，已处于禁言中' : ''}）`,
        `禁言 ${hours} 小时`,
        '后果：立即踢下线 + 断开讨论长连接；期间不能发文、评论、讨论。',
        '本次操作会写入审计日志（内部留痕，不进 /audit 公示页），并通知被禁言者。',
        '⚠️ 公示页上看不到这条日志 —— 对方因此**无法在网页上申诉**（申诉入口挂在公示日志上）。',
        '   要保留申诉渠道，改用网页后台的用户管理禁言。',
      ];
    },
    async run(ctx) {
      const target = await lookup(ctx, String(ctx.args.username));
      const { banUser } = await import('../../../src/lib/admin-user-service');
      const r = await banUser({
        actor: requireActor(ctx),
        targetId: target.id,
        hours: Number(ctx.args.hours),
        reason: String(ctx.args.reason),
      });
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { banId: r.banId } };
    },
  },

  {
    name: 'user unban',
    summary: '解除禁言',
    group: 'users',
    order: 4,
    needsActor: true,
    args: [
      usernameArg,
      {
        name: 'reason',
        flags: ['--reason', '-r'],
        label: '解除原因',
        help: '可选',
        prompt: { type: 'input' as const },
      },
    ],
    // 解除禁言不是危险操作（它在**放宽**限制），所以不设 danger，也就没有 describe ——
    // executeCommand 只在危险命令上跑预检。
    async run(ctx) {
      const target = await lookup(ctx, String(ctx.args.username));
      const { unbanUser } = await import('../../../src/lib/admin-user-service');
      const r = await unbanUser({
        actor: requireActor(ctx),
        targetId: target.id,
        reason: ctx.args.reason ? String(ctx.args.reason) : undefined,
      });
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { username: target.username } };
    },
  },

  {
    name: 'user force-logout',
    summary: '强制某用户下线（会话立即失效）',
    group: 'users',
    order: 5,
    needsActor: true,
    danger: 'destructive',
    details: [
      '比禁言轻一档：只让当前会话失效，用户重新登录即可继续。',
      '站内此前**没有任何入口**能做这件事（唯一的办法是重置密码或禁言）。',
    ].join('\n'),
    args: [
      usernameArg,
      {
        name: 'reason',
        flags: ['--reason', '-r'],
        label: '原因',
        help: '可选，会写进审计日志',
        prompt: { type: 'input' as const },
      },
    ],
    async describe(ctx) {
      const target = await lookup(ctx, String(ctx.args.username));
      const actor = requireActor(ctx);
      if (target.id === actor.id) throw new CliError('错误：不能强制自己下线');
      return [
        `目标用户：${target.username}（${target.role}）`,
        '后果：该用户所有已登录会话立即失效，并断开讨论长连接；重新登录即可继续。',
        '本次操作会写入审计日志（内部留痕，不进 /audit 公示页），并通知本人。',
      ];
    },
    async run(ctx) {
      const target = await lookup(ctx, String(ctx.args.username));
      const { forceLogout } = await import('../../../src/lib/admin-user-service');
      const r = await forceLogout({
        actor: requireActor(ctx),
        targetId: target.id,
        reason: ctx.args.reason ? String(ctx.args.reason) : undefined,
      });
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return { lines: [ctx.io.green(`成功：${r.message}`)], json: { username: target.username } };
    },
  },

  {
    name: 'user create',
    summary: '新建账号（站长专属，跳过人机验证，直接是 core）',
    group: 'users',
    order: 6,
    needsActor: true,
    danger: 'destructive',
    details: [
      '生产机到 Cloudflare 的出口不通、Turnstile 的服务端校验不可用，站长改用这个入口',
      '手动给自己认可的人开号。人机验证只在网页注册的路由层，这里天然不涉及。',
      '',
      '不消耗邀请码 —— 角色直接给 core，而不是走「邀请码升级」那条路。',
      '密码必须由你指定并转告对方；它不会写进审计日志（那里只记 create_user 这个动作）。',
    ].join('\n'),
    args: [
      {
        name: 'username',
        flags: [],
        positional: 0,
        required: true,
        label: '用户名',
        help: '3-20 位，字母 / 数字 / 下划线 / 连字符（可以是中文）',
        // ⚠️ 不能复用上面那个 usernameArg：它带 search 源（userSource），而这个号
        // 还不存在，向导会列出一张空表让人无从选起。
        prompt: { type: 'input' as const },
      },
      {
        name: 'password',
        flags: ['--password'],
        required: true,
        secret: true,
        label: '初始密码',
        help: '至少 8 位。由你转告对方；⚠️ 会留在 shell 历史里',
        prompt: { type: 'password' as const },
        validate: (raw: string) => (raw.length >= 8 ? null : '密码长度至少为 8 位'),
      },
      {
        name: 'email',
        flags: ['--email'],
        label: '邮箱',
        help: '留空 = 自动合成 <用户名>@users.invalid（不可投递，仅占位）',
        prompt: { type: 'input' as const },
      },
      {
        name: 'reason',
        flags: ['--reason', '-r'],
        label: '原因（写进审计日志）',
        help: '可选，默认「站长手动建号」',
        prompt: { type: 'input' as const },
        validate: (raw: string) => (raw.trim().length > 200 ? '原因过长（最多 200 字）' : null),
      },
    ],
    async describe(ctx) {
      const username = String(ctx.args.username);
      const email = ctx.args.email ? String(ctx.args.email).trim() : '';

      // 只读预检：重名要在确认之前就说清楚，别让人确认完才收到「已存在」
      const existing = await ctx.prisma.user.findUnique({
        where: { username },
        select: { id: true },
      });
      if (existing) throw new CliError(`错误：用户名 ${username} 已被占用`);

      const { buildPlaceholderEmail } = await import('../../../src/lib/user-service');
      return [
        `新用户：${username}（角色 core）`,
        `邮箱：${email || `${buildPlaceholderEmail(username)}（自动合成，不可投递）`}`,
        '不消耗邀请码，也不经过人机验证。',
        '密码取自 --password，会留在 shell 历史里 —— 建完请转告对方。',
        '本次操作会写入审计日志（**不含密码**；内部留痕，不进 /audit 公示页）。',
      ];
    },
    async run(ctx) {
      const { adminCreateUser } = await import('../../../src/lib/admin-user-service');
      const r = await adminCreateUser({
        actor: requireActor(ctx),
        username: String(ctx.args.username),
        password: String(ctx.args.password),
        email: ctx.args.email ? String(ctx.args.email) : null,
        reason: ctx.args.reason ? String(ctx.args.reason) : null,
      });
      // 账户服务同步失败用 exit 2（与 fish grant/deduct 的既有语义一致）
      if (!r.ok) throw new CliError(`错误：${r.message}`, r.code === 503 ? 2 : 1);

      const warnings: string[] = ['⚠️  请通过安全渠道把初始密码转告对方。'];
      if (r.emailSynthesized) {
        warnings.push('⚠️  邮箱是自动合成的，这个账号收不到任何邮件。');
      }

      return {
        lines: [
          ctx.io.green(`成功：已创建 ${r.user.username}（${r.user.role}）`),
          '',
          ...renderKv([
            ['用户 ID', r.user.id],
            ['用户名', r.user.username],
            ['角色', r.user.role],
            ['邮箱', r.email + (r.emailSynthesized ? '（自动合成，不可投递）' : '')],
          ]),
        ],
        warnings,
        json: { ...r.user, email: r.email, emailSynthesized: r.emailSynthesized },
      };
    },
  },
];
