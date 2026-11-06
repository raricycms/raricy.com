// ─────────────────────────────────────────────────────────────────────────────
// fish-credential-list-cli.test.ts —— `fish credential-list` 的到期判断（R3-428）
//
// 【bug 形状】expires_at 由 mintFishToken 用 nowForDb() 写入（库内时间戳是
// 「UTC+8 墙上时间贴 Z」），而 CLI 用 `Date.now()` 比较 → 差 8 小时：凭据真实到期后
// 8 小时内仍显示「有效」，与 validateFishToken / API 的判定相反。运维据此判断
// 「泄露的凭据是否还活着」会得到反向结论。
//
// 【测法】造一张「8 小时时差窗口内已过期」的凭据：expiresAt = nowForDb() - 1h。
// 它的墙钟值比真实 UTC 快 8h，所以修复前会被判成「有效」；修复后「已过期」。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { fishCommands } from '../../scripts/cli/commands/fish';
import type { Ctx } from '../../scripts/cli/types';

const io: Ctx['io'] = {
  line: () => {},
  error: () => {},
  red: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  dim: (s) => s,
  width: () => 200,
};

const run = (args: Ctx['args']) => {
  const cmd = fishCommands.find((c) => c.name === 'fish credential-list')!;
  return cmd.run({ args, actor: null, prisma, io });
};

async function makeToken(userId: string, opts: { expiresAt: Date; label: string; revokedAt?: Date }) {
  await prisma.fishApiToken.create({
    data: {
      userId,
      tokenHash: `hash-${opts.label}`,
      label: opts.label,
      scopes: 'read',
      expiresAt: opts.expiresAt,
      revokedAt: opts.revokedAt ?? null,
      createdAt: nowForDb(),
    },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('fish credential-list 的「有效期」用库内时钟判断', () => {
  it('墙钟上刚过期 1 小时的凭据必须显示「已过期」（Date.now 比较会差 8h 显示有效）', async () => {
    const user = await makeUser({ username: 'fishbot' });
    const now = nowForDb();
    await makeToken(user.id, {
      label: '刚过期',
      // 真实 UTC 角度看这还在「未来 7 小时」，但库内墙钟语义下已经过期
      expiresAt: new Date(now.getTime() - 3_600_000),
    });
    await makeToken(user.id, {
      label: '仍有效',
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    await makeToken(user.id, {
      label: '已吊销',
      expiresAt: new Date(now.getTime() + 3_600_000),
      revokedAt: now,
    });

    const out = await run({ username: 'fishbot' });
    const text = out.lines.join('\n');

    // 修复前：这张「刚过期」的会显示「有效」→ 下面第一条断言变红
    expect(text, '墙钟已过期 1h 的凭据必须是已过期').toContain('已过期');
    expect(text).toContain('有效');
    expect(text).toContain('已吊销');
    // 三张凭据都要列出（别在渲染层被吞掉）
    expect((out.json as { tokens: unknown[] }).tokens).toHaveLength(3);
  });
});
