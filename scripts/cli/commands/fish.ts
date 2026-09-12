// ─────────────────────────────────────────────────────────────────────────────
// fish.ts —— 小鱼干（对齐 Flask `flask fish ...`）
//
// 写路径 fail-closed：远端账户服务失败 → 本地写入被补偿事务精确撤销（对用户等价于
// 回滚）→ **退出码 2**。绝不静默成功。详见 src/lib/fish-admin.ts 与 CLAUDE.md。
//
// ⚠️ 这里不写审计日志（grant / deduct / compensate 三条写路径都不写）：它们的底层是
//    本地事务 + 远端 HTTP + 补偿事务三段结构，logAdminAction 绝不能挤进那个事务里
//    （会占满 SQLite 写锁）。fish 有自己的账本（fish_transactions +
//    account_sync_ledger）可查。
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import { ymdhms } from '../../../src/lib/format';
import { renderTable } from '../output';
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
    name: 'fish compensate',
    summary: '全站群发补偿（逐人原子，fail-closed）',
    group: 'fish',
    order: 3,
    danger: 'irreversible',
    args: [
      {
        name: 'amount',
        flags: [],
        positional: 0,
        required: true,
        kind: 'int',
        label: '每人数量',
        help: '每位用户发放的鱼干数，正整数，单位是整个小鱼干',
        prompt: { type: 'number' as const, integer: true, min: 1 },
        validate: (raw) => (Number.parseInt(raw, 10) > 0 ? null : 'amount 必须为正整数'),
      },
      {
        name: 'description',
        flags: ['-d', '--description'],
        label: '说明',
        help: '写进每条鱼干流水的说明',
        defaultValue: '系统补偿',
        prompt: { type: 'input' as const },
      },
      {
        name: 'batchId',
        flags: ['--batch-id'],
        label: '批次 ID',
        help: '续跑时传上次打印的批次 ID：已发放的用户会被跳过，只补剩下的',
        prompt: { type: 'input' as const },
      },
      {
        name: 'rate',
        flags: ['--rate'],
        kind: 'number',
        label: '同步速率',
        help: '远端同步每秒请求数（默认 5；遇到 429 限频可调小，如 1）',
        defaultValue: 5,
        prompt: { type: 'number' as const },
        validate: (raw) => {
          const n = Number(raw);
          return Number.isFinite(n) && n >= 0.1 && n <= 100 ? null : 'rate 需在 0.1 ~ 100 之间';
        },
      },
      {
        name: 'dryRun',
        flags: ['--dry-run'],
        kind: 'boolean',
        label: '只预览',
        help: '只显示计划，不实际执行',
        defaultValue: false,
        prompt: { type: 'confirm' as const },
      },
    ],
    details: [
      '给全站每一位用户发放同样数量的小鱼干。**逐人原子**：每人走一次「本地事务提交 →',
      '事务外远端同步 → 失败补偿」，中途失败**不回滚**已经发出去的部分。',
      '',
      '续跑：失败或中断后，用同一个 --batch-id 重跑，已发放的会自动跳过 —— 靠的是由',
      '批次派生的确定性幂等键（与 Flask `flask fish compensate` 逐字节同构）。批次 ID',
      '在开跑前就打印出来，进程被杀也找得回。',
      '',
      '与 Flask 版的有意偏离：Flask 是「一个大事务发给所有人，远端 HTTP 在事务里，',
      '任一失败整体回滚」—— 那会占满 SQLite 写锁整轮（1000 人 @5req/s ≈ 200 秒），',
      '期间全站写路径 database is locked。详见 src/lib/fish-compensate.ts 头部。',
      '',
      '不写审计日志：理由同 fish grant / deduct —— 写路径是「本地事务 + 远端 HTTP +',
      '补偿事务」三段结构，logAdminAction 挤进去会占满 SQLite 写锁。每一笔都留在',
      'fish_transactions 与 account_sync_ledger 里可查。',
    ].join('\n'),
    async describe(ctx) {
      const amount = Number(ctx.args.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new CliError('错误：amount 必须为正整数');
      }
      const rate = Number(ctx.args.rate);
      const batchId = ctx.args.batchId ? String(ctx.args.batchId) : undefined;

      const { planCompensation } = await import('../../../src/lib/fish-compensate');
      const p = await planCompensation({ amount, batchId, rate });
      // 库里一个用户都没有 = 本次没有实际变更 → 返回空数组，跳过确认闸。
      if (p.total === 0) return [];

      const lines = [
        `  目标用户数：${p.total}（含被禁言用户 —— 补偿是系统行为，与个人状态无关）`,
        `  每人发放：${amount} 小鱼干`,
        `  合计发放：${p.totalFish} 小鱼干`,
        `  远端限频：${rate} req/s（预计耗时约 ${(p.estimatedMs / 1000).toFixed(1)}s）`,
      ];
      if (batchId) {
        lines.push(
          `  批次 ID：${batchId}（续跑）`,
          `    ├─ 已发放、本次跳过：${p.alreadyDone} 位`,
          `    └─ 卡在账本里、须先 \`fish sync-retry\`：${p.blocked} 位`
        );
      } else {
        lines.push('  批次 ID：开跑时生成并立即打印（续跑时用 --batch-id 传回来）');
      }
      lines.push('  失败语义：逐人原子，中途失败不回滚已发放的部分 —— 用同一个批次 ID 重跑续上。');
      return lines;
    },
    async run(ctx) {
      const amount = Number(ctx.args.amount);
      const description = String(ctx.args.description);
      const rate = Number(ctx.args.rate);
      const dryRun = ctx.args.dryRun === true;
      const provided = ctx.args.batchId ? String(ctx.args.batchId) : undefined;

      const { compensateAllUsers, makeBatchId } = await import('../../../src/lib/fish-compensate');
      const batchId = provided ?? makeBatchId();

      // 批次 ID 必须在**任何远端调用之前**落到屏幕上：进程被 Ctrl-C / OOM 杀掉时，
      // 屏幕上这一行就是运维唯一的续跑凭据。
      if (!dryRun) ctx.io.line(`批次 ID：${batchId}${provided ? '（续跑）' : ''}`);

      const r = await compensateAllUsers({
        amount,
        description,
        batchId,
        rate,
        dryRun,
        onProgress: (done, total, username) => {
          if (done % 25 === 0 || done === total) {
            ctx.io.line(`  进度：${done}/${total}（${username}）`);
          }
        },
      });

      if (r.dryRun) {
        return {
          lines: [
            `--dry-run：未实际执行。目标 ${r.total} 位，每人 ${amount}，合计 ${r.total * amount} 小鱼干。`,
          ],
          json: r,
        };
      }

      const warnings: string[] = [];
      if (!r.remoteSynced) {
        warnings.push('  ⚠️ 账户服务未配置，仅写入本地库（远端账目未同步，续跑去重也不生效）');
      }
      if (r.skipped > 0) {
        warnings.push(`  本批次此前已发放、本次跳过 ${r.skipped} 位。`);
      }
      if (r.blocked.length > 0) {
        warnings.push(
          `  ⚠️ ${r.blocked.length} 位卡在账本里（本地已提交、远端未落地），本次未动：` +
            r.blocked
              .slice(0, 5)
              .map((b) => `${b.username}(${b.status})`)
              .join('、') +
            (r.blocked.length > 5 ? ' 等' : ''),
          '     先跑 `fish sync-retry` 收敛这些账目，再用同一个批次 ID 续跑。'
        );
      }

      const lines = [
        ctx.io.green(
          `成功：${r.succeeded} 位（每人 ${amount} 小鱼干，合计 ${r.succeeded * amount}）` +
            (r.skipped > 0 ? `，跳过 ${r.skipped} 位` : '')
        ),
        `  批次 ID：${batchId}`,
      ];
      if (r.remoteSynced) lines.push('  已同步至账户服务');

      // 有人没发成 / 整批中止 / 有卡住的账目 → 退出码 2（对齐 Flask 的「同步失败」），
      // 并把续跑命令原样交到运维手里，别让他自己拼批次 ID。
      if (r.failed.length > 0 || r.aborted || r.blocked.length > 0) {
        throw new CliError(
          `失败：${r.failed.length} 位未发放${r.aborted ? '（整批已中止）' : ''}`,
          2,
          [
            ...(r.aborted ? [`  已中止：${r.abortReason}`] : []),
            ...r.failed.slice(0, 10).map((f) => `  ✗ ${f.username}：${f.reason}`),
            ...(r.failed.length > 10 ? [`  …另有 ${r.failed.length - 10} 位失败`] : []),
            '',
            '  失败者各自的本地写入已被补偿事务精确撤销（对他们等价于没发生），余额未变。',
            '  续跑（已发放的会自动跳过）：',
            `    npm run cli -- fish compensate ${amount} --batch-id ${batchId} --yes`,
          ]
        );
      }

      return { lines, warnings, json: { ...r } };
    },
  },
  {
    name: 'fish pending',
    summary: '列出账本里未同步的鱼干账目',
    group: 'fish',
    order: 4,
    readOnly: true,
    args: [],
    details: [
      '看的是 account_sync_ledger：pending = 本地已提交、远端还没同步；',
      'failed = 远端失败且补偿也失败，需要 fish sync-retry 重放。',
      '两者都会由 sync-retry 收敛。',
    ].join('\n'),
    async run(ctx) {
      const rows = await ctx.prisma.accountSyncLedger.findMany({
        where: { status: { in: ['pending', 'failed'] } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          idempotencyKey: true,
          operation: true,
          status: true,
          attempts: true,
          lastError: true,
          createdAt: true,
        },
      });

      // payload 是 JSON 文本，里面是重建远端调用所需的非敏感参数。
      // 按约定不含密钥（要重放时按 userId 重新解密），但也没必要原样打给操作者看。
      if (rows.length === 0) {
        return {
          lines: [ctx.io.green('账本干净：没有 pending / failed 的鱼干账目。')],
          json: { entries: [] },
        };
      }

      const lines = renderTable(
        [
          { key: 'id', title: 'ID', align: 'right' },
          { key: 'operation', title: '操作', maxWidth: 14 },
          { key: 'status', title: '状态', maxWidth: 12 },
          { key: 'attempts', title: '重试', align: 'right' },
          { key: 'createdAt', title: '创建时间', maxWidth: 19 },
          { key: 'lastError', title: '最后错误', maxWidth: 30 },
        ],
        rows.map((r) => ({
          id: r.id,
          operation: r.operation,
          status: r.status,
          attempts: r.attempts,
          createdAt: ymdhms(r.createdAt) ?? '—',
          lastError: r.lastError ?? '—',
        })),
        { maxWidth: ctx.io.width() }
      );

      return {
        lines,
        warnings: ['跑 `fish sync-retry` 可以重放这些账目。'],
        json: { entries: rows },
      };
    },
  },
  {
    name: 'fish sync-retry',
    summary: '重放账本里 pending/failed 的远端同步',
    group: 'fish',
    order: 5,
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
