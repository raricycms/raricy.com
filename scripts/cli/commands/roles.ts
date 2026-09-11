// ─────────────────────────────────────────────────────────────────────────────
// roles.ts —— 角色升降（user ↔ core ↔ admin ↔ owner）
//
// 【为什么走 setRole 而不是直写 users.role】入口的直接写库是 Flask 时代的遗留：
// 它绕过审计日志、不踢已建立的连接、也不校验「不能改自己」。同一个操作走网页后台
// 有记录、走 CLI 没有，审计日志于是有个大洞。setRole 把权限分档（谁能任命管理员）、
// 审计、kickUser 都收在一处，CLI 与网页共用同一份不变量。
//
// ⚠️ 行为变化：setRole 拒绝「修改自己的角色」。所以站点只有一个站长时，他不能
//    用 CLI 把自己降级（--as 指定别人，或先加第二个站长）。
//
// 文案仍逐字照抄 Flask（包括「提示：xxx 已是管理员」这类 no-op 分支）——
// 它们是脚本判定「有没有真的改」的依据，退出码也保持 0。
// ─────────────────────────────────────────────────────────────────────────────

import { CliError, type CommandSpec, type Ctx } from '../types';

const ROLE_VALUES = ['user', 'core', 'admin', 'owner'] as const;

/** 角色命令的动作：notice = 无需变更的提示；set = 落到新角色；error = 拒绝执行。 */
type RoleAction =
  | { kind: 'notice'; msg: (u: string) => string }
  | { kind: 'set'; to: string; msg: (u: string) => string }
  | { kind: 'error'; msg: (u: string) => string };

const TABLE: Record<string, { summary: string; run: (role: string) => RoleAction }> = {
  'promote-admin': {
    summary: '授予管理员（已是 admin/owner 则提示）',
    // 已是 admin/owner → 提示；owner 不降级（Flask: `if role != 'owner': role = 'admin'`）
    run: (role) =>
      ['admin', 'owner'].includes(role)
        ? { kind: 'notice', msg: (u) => `提示：${u} 已是管理员` }
        : { kind: 'set', to: 'admin', msg: (u) => `成功：已授予 ${u} 管理员权限` },
  },
  'demote-admin': {
    summary: '移除管理员（降为核心用户）',
    run: (role) =>
      role === 'owner'
        ? { kind: 'error', msg: (u) => `错误：${u} 是站长，请先使用 demote-owner` }
        : role !== 'admin'
          ? { kind: 'notice', msg: (u) => `提示：${u} 不是管理员` }
          : {
              kind: 'set',
              to: 'core',
              msg: (u) => `成功：已移除 ${u} 的管理员权限（降级为核心用户）`,
            },
  },
  'promote-core': {
    summary: '授予核心用户（已是 core 或更高则提示）',
    run: (role) =>
      ['core', 'admin', 'owner'].includes(role)
        ? { kind: 'notice', msg: (u) => `提示：${u} 已是核心用户（或更高角色）` }
        : { kind: 'set', to: 'core', msg: (u) => `成功：已授予 ${u} 核心用户权限` },
  },
  'demote-core': {
    summary: '移除核心用户（降为普通用户）',
    run: (role) =>
      role !== 'core'
        ? { kind: 'notice', msg: (u) => `提示：${u} 不是核心用户（或已超出该角色范围）` }
        : { kind: 'set', to: 'user', msg: (u) => `成功：已移除 ${u} 的核心用户权限` },
  },
  'promote-owner': {
    summary: '授予站长',
    run: (role) =>
      role === 'owner'
        ? { kind: 'notice', msg: (u) => `提示：${u} 已是站长` }
        : { kind: 'set', to: 'owner', msg: (u) => `成功：已授予 ${u} 站长权限` },
  },
  'demote-owner': {
    summary: '移除站长（保留管理员）',
    // 站长降为 admin（保留管理员），对齐 Flask
    run: (role) =>
      role !== 'owner'
        ? { kind: 'notice', msg: (u) => `提示：${u} 不是站长` }
        : { kind: 'set', to: 'admin', msg: (u) => `成功：已移除 ${u} 的站长权限（保留管理员）` },
  },
};

const usernameArg = {
  name: 'username',
  flags: [],
  positional: 0,
  required: true,
  label: '用户名',
  help: '目标用户的用户名',
  prompt: { type: 'input' as const },
};

/** 取目标用户的当前角色；不存在直接报错。 */
async function lookup(ctx: Ctx, username: string): Promise<{ id: string; role: string }> {
  const user = await ctx.prisma.user.findUnique({
    where: { username },
    select: { id: true, role: true },
  });
  if (!user) throw new CliError(`错误：用户 ${username} 不存在`);
  return { id: user.id, role: user.role ?? 'user' };
}

/** 预检：把「做不到」的原因在确认之前讲清楚，返回变更说明（空数组 = 无需变更）。 */
async function describeRoleChange(
  ctx: Ctx,
  username: string,
  action: RoleAction,
  to: string
): Promise<string[]> {
  if (action.kind === 'error') throw new CliError(action.msg(username));
  if (action.kind === 'notice') return []; // 没有实际变更 → 不必确认
  const user = await lookup(ctx, username);
  // setRole 会拒绝，但让操作者在确认之前就看到原因，而不是确认完才被拒
  if (user.id === ctx.actor?.id) throw new CliError('错误：不能修改自己的角色');
  return [
    `目标用户：${username}（当前 ${user.role}）`,
    `变更：${user.role} → ${to}`,
    '后果：该用户已建立的聊天长连接会被踢掉，角色在下次请求时生效。',
    '本次操作会写入审计日志（默认公开可见，见 /audit 公示页）。',
  ];
}

/** 真正执行角色变更。notice 分支原样返回提示，退出码 0。 */
async function applyRoleChange(
  ctx: Ctx,
  username: string,
  action: RoleAction
): Promise<{ lines: string[]; json: unknown }> {
  if (action.kind === 'error') throw new CliError(action.msg(username));
  if (action.kind === 'notice') {
    const user = await lookup(ctx, username);
    return {
      lines: [ctx.io.yellow(action.msg(username))],
      json: { username, changed: false, role: user.role },
    };
  }

  const user = await lookup(ctx, username);
  const { setRole } = await import('../../../src/lib/admin-user-service');
  const r = await setRole({ actor: ctx.actor!, targetId: user.id, newRole: action.to });
  if (!r.ok) throw new CliError(`错误：${r.message}`);

  return {
    lines: [ctx.io.green(action.msg(username))],
    json: { username, changed: true, from: user.role, to: action.to },
  };
}

const legacyRoleCommands: CommandSpec[] = Object.entries(TABLE).map(([name, def], i) => ({
  name,
  summary: def.summary,
  group: 'roles',
  order: i,
  needsActor: true,
  danger: 'destructive',
  args: [usernameArg],
  async describe(ctx) {
    const username = String(ctx.args.username);
    const user = await lookup(ctx, username);
    const action = def.run(user.role);
    return describeRoleChange(ctx, username, action, action.kind === 'set' ? action.to : '');
  },
  async run(ctx) {
    const username = String(ctx.args.username);
    const user = await lookup(ctx, username);
    return applyRoleChange(ctx, username, def.run(user.role));
  },
}));

export const roleCommands: CommandSpec[] = [
  ...legacyRoleCommands,
  {
    name: 'role set',
    summary: '把用户设为指定角色（user / core / admin / owner）',
    group: 'roles',
    order: 100,
    needsActor: true,
    danger: 'destructive',
    details: [
      '统一入口，交互式向导用的就是它。六条语法糖命令（promote-admin 等）',
      '只是它的固定参数特例，走的是同一个 setRole。',
      '',
      '权限分档：涉及 admin / owner 的任何方向都只有站长能做；user ↔ core 归管理员。',
    ].join('\n'),
    args: [
      usernameArg,
      {
        name: 'role',
        flags: [],
        positional: 1,
        required: true,
        label: '目标角色',
        help: 'user（普通）| core（认证）| admin（管理员）| owner（站长）',
        prompt: {
          type: 'select',
          choices: [
            { value: 'core', label: 'core', hint: '核心用户：能发文、进聊天' },
            { value: 'user', label: 'user', hint: '普通用户：取消认证' },
            { value: 'admin', label: 'admin', hint: '管理员：可禁言、管内容（仅站长可设）' },
            { value: 'owner', label: 'owner', hint: '站长：全权限（仅站长可设）' },
          ],
        },
        validate: (raw) =>
          (ROLE_VALUES as readonly string[]).includes(raw)
            ? null
            : '无效的角色（只能是 user / core / admin / owner）',
      },
    ],
    async describe(ctx) {
      const username = String(ctx.args.username);
      const target = String(ctx.args.role);
      const user = await lookup(ctx, username);
      if (user.role === target) return []; // 无需变更，跳过确认
      if (user.id === ctx.actor?.id) throw new CliError('错误：不能修改自己的角色');
      return [
        `目标用户：${username}（当前 ${user.role}）`,
        `变更：${user.role} → ${target}`,
        '后果：该用户已建立的聊天长连接会被踢掉，角色在下次请求时生效。',
        '本次操作会写入审计日志（默认公开可见，见 /audit 公示页）。',
      ];
    },
    async run(ctx) {
      const username = String(ctx.args.username);
      const target = String(ctx.args.role);
      const user = await lookup(ctx, username);
      if (user.role === target) {
        return {
          lines: [ctx.io.yellow(`提示：${username} 已是 ${target}`)],
          json: { username, changed: false, role: target },
        };
      }
      const { setRole } = await import('../../../src/lib/admin-user-service');
      const r = await setRole({ actor: ctx.actor!, targetId: user.id, newRole: target });
      if (!r.ok) throw new CliError(`错误：${r.message}`);
      return {
        lines: [ctx.io.green(`成功：已将 ${username} 设为 ${target}`)],
        json: { username, changed: true, from: user.role, to: target },
      };
    },
  },
];
