// ─────────────────────────────────────────────────────────────────────────────
// actor.ts —— 审计主体解析
//
// 【为什么不能用「虚拟 owner」】admin_action_logs.admin_id 与 user_bans.admin_id 都是
// 指向 users.id 的**真实外键**（schema.prisma 里分别是 LogAdmin / BanAdmin 两个
// relation）。伪造一个 id 会直接被外键约束打回，就算绕过去了，审计日志也会指向
// 一个不存在的用户 —— 那比没有日志更糟。
//
// 所以：主体必须落到一个**真实用户**上；库内一个站长都没有时，需要审计的命令
// 直接拒绝执行（而不是自动造号或静默跳过审计）。
//
// 【分层】本文件只负责「是谁」，权限判定留在各个 service 里 —— setRole / banUser /
// adjudicate 都自带权限分档，在 CLI 里再判一遍会变成两份会漂移的规则。唯一的例外
// 是在 describe() 里做「快速失败」，让操作者先看到人话提示而不是 service 的 403。
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import { CliError, type Output } from './types';
import type { SafeUser } from '../../src/lib/auth';

export interface ActorOptions {
  /** --as <username>：显式指定审计身份。 */
  as: string | null;
}

/**
 * 解析审计主体。
 *   1. --as 指定 → 用它（非站长也放行，但告警；权限交给 service 判）
 *   2. 否则取库内最早的站长
 *   3. 都没有 → 报错，并说明外键约束（绝不自动建号、绝不用合成 id）
 */
export async function resolveActor(
  prisma: PrismaClient,
  io: Output,
  opts: ActorOptions
): Promise<SafeUser> {
  const { loadSafeUserByUsername, loadDefaultOwner } = await import('../../src/lib/admin-user-service');

  if (opts.as) {
    const u = await loadSafeUserByUsername(opts.as);
    if (!u) throw new CliError(`错误：用户 ${opts.as} 不存在`);
    if (u.role !== 'owner') {
      // 不是站长也放行：身份解析只管「是谁」。多数写命令会被 service 挡下，
      // 但报错会来自 service（例如「仅站长可变更管理员/站长角色」），那是对的。
      io.error(io.yellow(`⚠️  ${u.username} 不是站长，多数写操作会被拒绝。`));
    }
    return u;
  }

  const owner = await loadDefaultOwner();
  if (owner) return owner;

  throw new CliError('错误：库内没有站长用户，无法确定审计主体', 1, [
    '  admin_action_logs.admin_id 与 user_bans.admin_id 是指向 users.id 的外键，不能用伪造 ID。',
    '  请用 --as <username> 指定一个真实用户，或先建一个站长账号。',
  ]);
}

/** 确认屏上那一行「执行者」。 */
export function describeActor(actor: SafeUser | null): string {
  if (!actor) return '（只读操作，无审计主体）';
  return `${actor.role} ${actor.username}（审计 admin_id = ${actor.id}）`;
}

/** 给 ctx 用：只有需要主体的命令才解析，只读命令恒 null。 */
export async function actorFor(
  cmd: { needsActor?: boolean },
  prisma: PrismaClient,
  io: Output,
  opts: ActorOptions
): Promise<SafeUser | null> {
  return cmd.needsActor ? resolveActor(prisma, io, opts) : null;
}
