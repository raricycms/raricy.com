// ─────────────────────────────────────────────────────────────────────────────
// audit-log-cli.test.ts —— `npm run cli -- audit log` 的参数语义（R3-410）
//
// 【bug 形状】CLI 把同一个 `--user` 分别传给 listAdminLogs 的 adminUsername 与
// targetUsername 两个字段；Prisma 把这两个**顶层键**当 AND，于是「alice 封禁了 bob」
// 这类只有执行者匹配的行查不出来 —— 运维会据此认为「没发生过」。
//
// 【为什么测在 CLI 这一层】服务层两个字段本身是对的（`/admin/logs` 页面就靠它们做
// 两个独立输入框）；bug 在 CLI 怎么用它们。所以用真命令 + 真库跑一遍 run()，断言
// 返回的 json.total 与行集合，而不是只测 service 的 where 拼装。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { auditCommands } from '../../scripts/cli/commands/audit';
import type { Ctx } from '../../scripts/cli/types';

const io: Ctx['io'] = {
  line: () => {},
  error: () => {},
  red: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  dim: (s) => s,
  width: () => 80,
};

/** 只读命令：actor 恒为 null，直接传真 prisma。 */
const run = (args: Ctx['args']) => {
  const cmd = auditCommands.find((c) => c.name === 'audit log')!;
  return cmd.run({ args, actor: null, prisma, io });
};

async function makeLog(opts: {
  adminId: string;
  targetUserId?: string | null;
  visibility?: string;
  action?: string;
}) {
  await prisma.adminActionLog.create({
    data: {
      action: opts.action ?? 'ban_user',
      adminId: opts.adminId,
      targetUserId: opts.targetUserId ?? null,
      visibility: opts.visibility ?? 'public',
      reason: 'r',
      createdAt: nowForDb(),
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('audit log --user 是「执行者或对象用户」（OR）', () => {
  it('执行者匹配、被处理者匹配的行都要出现；与 alice 无关的行不出现', async () => {
    const alice = await makeUser({ username: 'alice', role: 'admin' });
    const bob = await makeUser({ username: 'bob', role: 'core' });
    await makeLog({ adminId: alice.id, targetUserId: bob.id }); // alice 执行
    await makeLog({ adminId: bob.id, targetUserId: alice.id }); // alice 被处理
    await makeLog({ adminId: bob.id }); // 与 alice 无关

    const out = await run({ user: 'alice' });
    const json = out.json as {
      total: number;
      items: Array<{ admin: { username: string | null }; targetUser: { username: string | null } | null }>;
    };

    // 修复前这里恒为 0（两个顶层键 AND → 要求同一行既以 alice 为执行者又以 alice 为对象）
    expect(json.total).toBe(2);
    expect(json.items).toHaveLength(2);
    const seen = json.items.map(
      (i) => `${i.admin.username ?? '—'}>${i.targetUser?.username ?? '—'}`
    );
    expect(seen).toContain('alice>bob');
    expect(seen).toContain('bob>alice');
  });

  it('不传 --user 时仍列出全部；--action 过滤不受 OR 影响', async () => {
    const alice = await makeUser({ username: 'alice', role: 'admin' });
    const bob = await makeUser({ username: 'bob', role: 'core' });
    await makeLog({ adminId: alice.id, targetUserId: bob.id, action: 'ban_user' });
    await makeLog({ adminId: bob.id, targetUserId: alice.id, action: 'delete_blog' });

    const all = await run({});
    expect((all.json as { total: number }).total).toBe(2);

    const banOnly = await run({ user: 'alice', action: 'ban_user' });
    const json = banOnly.json as { total: number; items: Array<{ action: string }> };
    expect(json.total).toBe(1);
    expect(json.items[0].action).toBe('ban_user');
  });
});
