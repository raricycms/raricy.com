// ─────────────────────────────────────────────────────────────────────────────
// roles.ts —— 角色升降（user ↔ core ↔ admin ↔ owner）
//
// 语义表逐条对齐原 Flask app/cli.py，文案逐字照抄（包括「提示：xxx 已是管理员」
// 这类 no-op 分支 —— 它们是脚本判定「有没有真的改」的依据）。
//
// ⚠️ 本文件目前**直写 users.role**，与 Flask 时代的 cli.mjs 一致：不写审计日志、
//    不踢会话、不校验「不能改自己」。这是刻意的 —— 移植阶段先保证行为不变。
//    改成走 setRole（从而带上审计与 kickUser）是下一步的事，见
//    src/lib/admin-user-service.ts 的 setRole。
// ─────────────────────────────────────────────────────────────────────────────

import { CliError, type CommandSpec } from '../types';

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

export const roleCommands: CommandSpec[] = Object.entries(TABLE).map(([name, def], i) => ({
  name,
  summary: def.summary,
  group: 'roles',
  order: i,
  args: [
    {
      name: 'username',
      flags: [],
      positional: 0,
      required: true,
      label: '用户名',
      help: '目标用户的用户名',
      prompt: { type: 'input' },
    },
  ],
  async run(ctx) {
    const username = String(ctx.args.username);
    const user = await ctx.prisma.user.findUnique({
      where: { username },
      select: { id: true, role: true },
    });
    if (!user) throw new CliError(`错误：用户 ${username} 不存在`);

    const action = def.run(user.role ?? 'user');
    if (action.kind === 'error') throw new CliError(action.msg(username));

    if (action.kind === 'notice') {
      return {
        lines: [ctx.io.yellow(action.msg(username))],
        json: { username, changed: false, role: user.role },
      };
    }

    await ctx.prisma.user.update({ where: { id: user.id }, data: { role: action.to } });
    return {
      lines: [ctx.io.green(action.msg(username))],
      json: { username, changed: true, from: user.role, to: action.to },
    };
  },
}));
