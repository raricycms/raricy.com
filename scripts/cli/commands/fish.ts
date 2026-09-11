// ─────────────────────────────────────────────────────────────────────────────
// fish.ts —— 小鱼干（对齐 Flask `flask fish ...`）
//
// 写路径 fail-closed：远端账户服务失败 → 本地写入被补偿事务精确撤销（对用户等价于
// 回滚）→ **退出码 2**。绝不静默成功。详见 src/lib/fish-admin.ts 与 CLAUDE.md。
//
// ⚠️ 这里不写审计日志：adminGrantFish/adminDeductFish 内部有本地事务 + 远端 HTTP +
//    补偿事务三段结构，logAdminAction 绝不能挤进那个事务里（会占满 SQLite 写锁）。
//    fish 有自己的账本（fish_transactions + account_sync_ledger）可查。
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import { CliError, type CommandSpec } from '../types';

/** 从 catch 的 unknown 里取错误名（strict 下 catch 变量是 unknown，不能直接读字段）。 */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : '';
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 解析用户；不存在即报错（原实现同样如此）。driedFish 只在失败路径用来报余额。 */
async function requireUser(prisma: PrismaClient, username: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, driedFish: true },
  });
  if (!user) throw new CliError(`错误：用户 ${username} 不存在`);
  return user;
}

const usernameArg = {
  name: 'username',
  flags: [],
  positional: 0,
  required: true,
  label: '用户名',
  help: '目标用户的用户名',
  prompt: { type: 'input' as const },
};

export const fishCommands: CommandSpec[] = [
  {
    name: 'fish balance',
    summary: '查询小鱼干余额',
    group: 'fish',
    order: 0,
    readOnly: true,
    args: [usernameArg],
    async run(ctx) {
      const username = String(ctx.args.username);
      const user = await requireUser(ctx.prisma, username);
      const { getBalance } = await import('../../../src/lib/fish-service');
      const balance = await getBalance(user.id);
      return {
        lines: [`${username} 的小鱼干余额：${balance}`],
        json: { username, balance },
      };
    },
  },
  ...(['grant', 'deduct'] as const).map(
    (kind, i): CommandSpec => ({
      name: `fish ${kind}`,
      summary: kind === 'grant' ? '赠送小鱼干（fail-closed）' : '扣减小鱼干（fail-closed）',
      group: 'fish',
      order: i + 1,
      args: [
        usernameArg,
        {
          name: 'amount',
          flags: [],
          positional: 1,
          required: true,
          kind: 'int',
          label: '数量',
          help: '正整数，单位是整个小鱼干（不是内部 0.1 单位）',
          prompt: { type: 'number', integer: true, min: 1 },
          validate: (raw) => (Number.parseInt(raw, 10) > 0 ? null : 'amount 必须为正整数'),
        },
        {
          name: 'description',
          flags: ['-d', '--description'],
          label: '说明',
          help: '写进鱼干流水的说明',
          defaultValue: kind === 'grant' ? '管理员手动赠送' : '管理员手动扣减',
          prompt: { type: 'input' as const },
        },
      ],
      async run(ctx) {
        const username = String(ctx.args.username);
        const amount = Number(ctx.args.amount);
        const description = String(ctx.args.description);
        const user = await requireUser(ctx.prisma, username);

        const { adminGrantFish, adminDeductFish } = await import('../../../src/lib/fish-admin');
        const { accountServiceEnabled } = await import('../../../src/lib/account-client');
        const remote = accountServiceEnabled();

        try {
          const balance =
            kind === 'grant'
              ? await adminGrantFish(user.id, amount, description)
              : await adminDeductFish(user.id, amount, description);

          const verb = kind === 'grant' ? '赠送' : '扣减';
          const prep = kind === 'grant' ? '给' : '从';
          const lines = [
            ctx.io.green(`成功：已${verb} ${amount} 小鱼干${prep} ${username}`),
            `  当前余额：${balance}`,
          ];
          // 别无条件打印「已同步」—— dev fallback 下压根没打远端，那样会误导运维
          // 以为账目已经平了。
          const warnings: string[] = [];
          if (remote) lines.push('  已同步至账户服务');
          else warnings.push('  ⚠️ 账户服务未配置，仅写入本地库（远端账目未同步）');

          return { lines, warnings, json: { username, amount, balance, remoteSynced: remote } };
        } catch (e) {
          // fail-closed：本地写入已被补偿回滚，余额未变，返回退出码 2（对齐 Flask）
          if (errorName(e) === 'FishBusinessError') {
            throw new CliError(`错误：${errorMessage(e)}`, 1);
          }
          throw new CliError('失败：账户服务同步失败，本地写入已补偿回滚', 2, [
            `  原因: ${errorMessage(e)}`,
            // driedFish 存的是 0.1 鱼干为单位（fish-units.ts），展示除以 10
            `  本地余额未变更（${(user.driedFish ?? 0) / 10}），请稍后重试。`,
          ]);
        }
      },
    })
  ),
  {
    name: 'fish sync-retry',
    summary: '重放账本里 pending/failed 的远端同步',
    group: 'fish',
    order: 3,
    readOnly: false,
    args: [],
    details: [
      '用于「本地已提交、远端未同步」之间崩溃，或补偿失败留下的 failed 行。',
      '远端按幂等键重放，收敛后标 synced。详见 src/lib/fish-sync.ts。',
    ].join('\n'),
    async run(ctx) {
      const { replayPendingSyncs } = await import('../../../src/lib/fish-sync');
      const r = await replayPendingSyncs({ olderThanMs: 0, limit: 200 });

      if (r.total === 0) {
        return {
          lines: ['没有待重放的同步账目（account_sync_ledger 无 pending/failed 行）。'],
          json: { total: 0, synced: 0, stillFailing: 0 },
        };
      }
      const warnings: string[] = [];
      if (r.stillFailing > 0) {
        warnings.push(
          ctx.io.yellow('  仍失败的行保留在账本里（attempts 已 +1），可稍后再次执行本命令。')
        );
      }
      return {
        lines: [`扫描 ${r.total} 行：同步成功 ${r.synced}，仍失败 ${r.stillFailing}。`],
        warnings,
        json: { total: r.total, synced: r.synced, stillFailing: r.stillFailing },
      };
    },
  },
];
