// ─────────────────────────────────────────────────────────────────────────────
// fish.ts —— 小鱼干（命令名与退出码对齐历史 CLI 的 fish 子命令）
//
// 【写路径与退出码】一次本地事务（余额 + 流水 +（有幂等键时）登记行同事务提交，
// 见 src/lib/fish-admin.ts）：要么整体生效、要么整体回滚，没有中间态。于是
//   0 = 成功；1 = 业务结果（参数非法 / 余额不足）；2 = 真故障（本地事务失败）。
// 退出码 2 这个号当年是给站外账户微服务的「同步失败」留的，账户搬进站内后它没有被
// 删掉，而是接过了「本地事务失败」这一档（与 API 侧的 500 同档，见
// docs/architecture.md §6.3）—— 脚本契约不变，别看见「没有 503 了」就顺手把它删掉。
//
// ⚠️ 这里不写审计日志（grant / deduct / compensate 三条写路径都不写）—— 这是**现状**，
//    不是结构约束。旧版的理由是「写路径是本地事务 + 远端 HTTP + 补偿事务三段结构，
//    logAdminAction 挤进去会占满 SQLite 写锁」，那条理由已随远端撤销而**不成立**：
//    现在只有一次本地事务，追加一条审计日志在技术上没有障碍。要不要补上是一次独立的
//    决定，别在这次重构里顺手改。现状下这三条路径的凭据是 fish_transactions 流水
//    （compensate 另有 account_sync_ledger 的幂等登记行，一条 / 人）。
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from '@prisma/client';
import { ymdhms } from '../../../src/lib/format';
import { unitsToFish } from '../../../src/lib/fish-units';
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
      summary: kind === 'grant' ? '赠送小鱼干' : '扣减小鱼干',
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

        try {
          const balance =
            kind === 'grant'
              ? await adminGrantFish(user.id, amount, description)
              : await adminDeductFish(user.id, amount, description);

          const verb = kind === 'grant' ? '赠送' : '扣减';
          const prep = kind === 'grant' ? '给' : '从';
          return {
            lines: [
              ctx.io.green(`成功：已${verb} ${amount} 小鱼干${prep} ${username}`),
              `  当前余额：${balance}`,
            ],
            json: { username, amount, balance },
          };
        } catch (e) {
          // 业务结果（amount 非法 / 余额不足）给一条干净的提示；其余异常是**真故障**
          // （本地事务失败 → 退出码 2）。两种情形本地都没有留下任何变更：前者压根没写，
          // 后者整体回滚。
          if (errorName(e) === 'FishBusinessError') {
            throw new CliError(`错误：${errorMessage(e)}`, 1);
          }
          throw new CliError('失败：本地事务失败，未做任何变更', 2, [
            `  原因: ${errorMessage(e)}`,
            // driedFish 存的是 0.0001 鱼干为单位，展示走 fish-units 的出口
            // （**别写死除数** —— 手写的 /10 在精度提升后不会报错，只会静默显示错值）
            `  本地余额未变更（${unitsToFish(user.driedFish ?? 0)}），可稍后重试。`,
          ]);
        }
      },
    })
  ),
  {
    name: 'fish compensate',
    summary: '给全部 core+ 用户群发补偿（逐人一笔事务）',
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
      '给**全部 core+ 用户**（core / admin / owner）每人发放同样数量的小鱼干。',
      '非核心账号一分不发：鱼干在站内的赚取渠道（签到翻牌、投喂分成）全在 core 门槛',
      '之后，给它们空投等于「注册就有鱼干」，与这套口径冲突。被禁言者**照发** ——',
      '补偿是系统行为，与个人当前状态无关。',
      '',
      '**逐人原子**：每人一笔独立事务（余额 + 流水 + 幂等登记一起提交），',
      '中途失败**不回滚**已经发出去的部分。',
      '',
      '续跑：失败或中断后，用同一个 --batch-id 重跑，已发放的会自动跳过 —— 靠的是由',
      '批次派生的确定性幂等键（**必须逐字节稳定**：历史批次可能跑了一半，换算法就续',
      '不上）。批次 ID 在开跑前就打印出来，进程被杀也找得回。',
      '',
      '有意偏离「一个大事务发给所有人」的做法：那个形状要么全成要么全败，拿不到',
      '「发到哪了」，也就没有续跑可言；而且它会把 SQLite 写锁一次性占满整批，',
      '期间全站写路径排队等锁。详见 src/lib/fish-compensate.ts 头部。',
      '',
      '不写审计日志：理由同 fish grant / deduct（那边的注释里说明了为什么这条理由',
      '现在已经不成立，以及为什么仍然维持现状）。每一笔都留在 fish_transactions 里',
      '可查（另有 account_sync_ledger 的幂等登记行，一条 / 人）。',
    ].join('\n'),
    async describe(ctx) {
      const amount = Number(ctx.args.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new CliError('错误：amount 必须为正整数');
      }
      const batchId = ctx.args.batchId ? String(ctx.args.batchId) : undefined;

      const { planCompensation } = await import('../../../src/lib/fish-compensate');
      const p = await planCompensation({ amount, batchId });
      // 库里一个用户都没有 = 本次没有实际变更 → 返回空数组，跳过确认闸。
      if (p.total === 0) return [];

      const lines = [
        `  目标用户数：${p.total}（全部 core+，含被禁言用户 —— 补偿是系统行为，与个人状态无关）`,
        `  每人发放：${amount} 小鱼干`,
        `  合计发放：${p.totalFish} 小鱼干`,
      ];
      if (batchId) {
        lines.push(
          `  批次 ID：${batchId}（续跑）`,
          `    ├─ 已发放、本次跳过：${p.alreadyDone} 位`,
          `    └─ 迁移前遗留（非 synced）、须人工查证：${p.blocked} 位`
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
      const dryRun = ctx.args.dryRun === true;
      const provided = ctx.args.batchId ? String(ctx.args.batchId) : undefined;

      const { compensateAllUsers, makeBatchId } = await import('../../../src/lib/fish-compensate');
      const batchId = provided ?? makeBatchId();

      // 批次 ID 必须在**第一位用户被发放之前**落到屏幕上：进程被 Ctrl-C / OOM 杀掉时，
      // 屏幕上这一行就是运维唯一的续跑凭据。
      if (!dryRun) ctx.io.line(`批次 ID：${batchId}${provided ? '（续跑）' : ''}`);

      const r = await compensateAllUsers({
        amount,
        description,
        batchId,
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
      if (r.skipped > 0) {
        warnings.push(`  本批次此前已发放、本次跳过 ${r.skipped} 位。`);
      }
      if (r.blocked.length > 0) {
        warnings.push(
          `  ⚠️ ${r.blocked.length} 位卡在迁移前的遗留账目里（本地已提交、当年远端那半笔状态不明），本次未动：` +
            r.blocked
              .slice(0, 5)
              .map((b) => `${b.username}(${b.status})`)
              .join('、') +
            (r.blocked.length > 5 ? ' 等' : ''),
          '     这些行不会自动收敛（重放它们的那条命令已随账户服务一起撤销），须人工查证；',
          '     在查清之前他们会一直被跳过 —— 重发会在本地实打实叠加一笔。'
        );
      }

      const lines = [
        ctx.io.green(
          `成功：${r.succeeded} 位（每人 ${amount} 小鱼干，合计 ${r.succeeded * amount}）` +
            (r.skipped > 0 ? `，跳过 ${r.skipped} 位` : '')
        ),
        `  批次 ID：${batchId}`,
      ];

      // 有人没发成 / 有卡住的账目 → 退出码 2（真故障档：每位没发成的都是一次本地事务
      // 失败），并把续跑命令原样交到运维手里，别让他自己拼批次 ID。
      if (r.failed.length > 0 || r.blocked.length > 0) {
        throw new CliError(
          `失败：${r.failed.length} 位未发放` +
            (r.blocked.length > 0
              ? `，另有 ${r.blocked.length} 位卡在迁移前的遗留账目里`
              : ''),
          2,
          [
            ...r.failed.slice(0, 10).map((f) => `  ✗ ${f.username}：${f.reason}`),
            ...(r.failed.length > 10 ? [`  …另有 ${r.failed.length - 10} 位失败`] : []),
            '',
            '  失败者那笔事务整体回滚（余额与流水一起没写入），对他们等价于没发生。',
            '  续跑（已发放的会自动跳过）：',
            `    npm run cli -- fish compensate ${amount} --batch-id ${batchId} --yes`,
          ]
        );
      }

      return { lines, warnings, json: { ...r } };
    },
  },
  {
    name: 'fish credential-list',
    summary: '列出某用户的鱼干只读凭据',
    group: 'fish',
    order: 6,
    readOnly: true,
    args: [usernameArg],
    details: [
      '鱼干只读凭据只能查余额与流水、不能转账，可单独吊销（见 src/lib/fish-token-service.ts）。',
      '输出里**不含明文也不含哈希** —— 明文只在用户自助签发的那一次显示过，取不回来。',
      '要失效某一张用 `fish credential-revoke <id>`，id 就是这里的第一列。',
    ].join('\n'),
    async run(ctx) {
      const user = await ctx.prisma.user.findUnique({
        where: { username: String(ctx.args.username) },
        select: { id: true, username: true },
      });
      if (!user) throw new CliError(`错误：用户 ${ctx.args.username} 不存在`);

      const rows = await ctx.prisma.fishApiToken.findMany({
        where: { userId: user.id },
        orderBy: { id: 'desc' },
        select: {
          id: true,
          label: true,
          scopes: true,
          createdAt: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
        },
      });

      // 时间一律走 format 的 ymdhms（读 UTC getter）—— 本库时间戳是
      // 「UTC+8 墙上时间贴 Z」，本地 getter 会按服务器时区平移（cli-guards 静态盯着）。
      const now = Date.now();
      const lines = renderTable(
        [
          { key: 'id', title: 'ID', align: 'right' },
          { key: 'label', title: '备注', maxWidth: 16 },
          { key: 'scopes', title: '权限', maxWidth: 8 },
          { key: 'createdAt', title: '签发于', maxWidth: 19 },
          { key: 'expiresAt', title: '到期', maxWidth: 19 },
          { key: 'lastUsedAt', title: '最后使用', maxWidth: 19 },
          { key: 'status', title: '状态', maxWidth: 8 },
        ],
        rows.map((r) => ({
          id: r.id,
          label: r.label ?? '—',
          scopes: r.scopes,
          createdAt: ymdhms(r.createdAt) ?? '—',
          expiresAt: ymdhms(r.expiresAt) ?? '—',
          lastUsedAt: ymdhms(r.lastUsedAt) ?? '从未',
          status: r.revokedAt ? '已吊销' : r.expiresAt.getTime() <= now ? '已过期' : '有效',
        })),
        { maxWidth: ctx.io.width() }
      );

      return {
        lines: rows.length ? lines : [`${user.username} 没有签发过只读凭据。`],
        json: {
          username: user.username,
          tokens: rows.map((r) => ({
            id: r.id,
            label: r.label,
            scopes: r.scopes,
            createdAt: ymdhms(r.createdAt),
            expiresAt: ymdhms(r.expiresAt),
            lastUsedAt: ymdhms(r.lastUsedAt),
            revokedAt: ymdhms(r.revokedAt),
          })),
        },
      };
    },
  },

  {
    name: 'fish credential-revoke',
    summary: '吊销一张鱼干只读凭据（立即失效）',
    group: 'fish',
    order: 7,
    needsActor: true,
    danger: 'destructive',
    args: [
      {
        name: 'id',
        flags: [],
        positional: 0,
        label: '凭据 ID',
        help: '`fish credential-list <用户名>` 第一列的那个整数',
        validate: (raw) => {
          const n = Number(raw);
          return Number.isInteger(n) && n > 0 ? null : '凭据 ID 必须是正整数';
        },
        prompt: { type: 'number' as const, min: 1, integer: true },
      },
    ],
    details: [
      '站长代吊销：用户不配合、或凭据已泄露但本人联系不上时用。用户自己在站内也能吊销。',
      '**立即生效** —— 校验每次都查库，没有缓存（见 fish-token-service.validateFishToken）。',
      '幂等：已吊销的再吊销照样成功。凭据本身不删除，只是标记 revokedAt（全站不物删）。',
    ].join('\n'),
    async describe(ctx) {
      const row = await ctx.prisma.fishApiToken.findUnique({
        where: { id: Number(ctx.args.id) },
        select: { id: true, label: true, userId: true, revokedAt: true },
      });
      if (!row) return [`凭据 #${ctx.args.id} 不存在。`];
      const owner = await ctx.prisma.user.findUnique({
        where: { id: row.userId },
        select: { username: true },
      });
      return [
        `凭据 #${row.id}（${row.label ?? '无备注'}）`,
        `持有者：${owner?.username ?? row.userId}`,
        row.revokedAt ? '当前状态：**已经吊销过**（本次是空操作）' : '当前状态：有效 → 将被吊销',
      ];
    },
    async run(ctx) {
      const { revokeFishToken } = await import('../../../src/lib/fish-token-service');
      const id = Number(ctx.args.id);
      // isOwner：CLI 由站长执行，可以动任何人的凭据（自助接口那边不走这条路）。
      const r = await revokeFishToken(ctx.actor?.id ?? '', id, { isOwner: true });
      if (r === 'not_found') throw new CliError(`错误：凭据 #${id} 不存在`);

      return {
        lines: [`凭据 #${id} 已吊销，立即失效。`],
        json: { id, result: r },
      };
    },
  },

  {
    name: 'fish webhooks',
    summary: '列出回调地址与投递积压',
    group: 'fish',
    order: 8,
    readOnly: true,
    args: [
      {
        name: 'username',
        flags: [],
        positional: 0,
        label: '用户名',
        help: '只看某一个人的；留空则列全部',
        prompt: { type: 'input' as const },
      },
    ],
    details: [
      '回调是「钱到账时主动通知商户」（见 src/lib/fish-webhook-service.ts）。',
      '投递是 **at-least-once**：商户可能收到重复回调，靠 X-Raricy-Delivery 去重。',
      '失败会自动重试（指数退避），耗尽后置 dead **且不自动停用地址** —— 悄悄停掉',
      '全部回调是静默失效，商户会以为还在收通知。要查 dead 的那几条看这里。',
    ].join('\n'),
    async run(ctx) {
      const name = String(ctx.args.username ?? '').trim();
      let userId: string | undefined;
      if (name) {
        const u = await ctx.prisma.user.findUnique({
          where: { username: name },
          select: { id: true },
        });
        if (!u) throw new CliError(`错误：用户 ${name} 不存在`);
        userId = u.id;
      }

      const endpoints = await ctx.prisma.fishWebhookEndpoint.findMany({
        where: userId ? { userId } : {},
        orderBy: { createdAt: 'desc' },
        select: {
          userId: true,
          url: true,
          disabledAt: true,
          consecutiveFailures: true,
          lastSuccessAt: true,
          lastFailureAt: true,
        },
      });
      if (endpoints.length === 0) {
        return { lines: ['没有任何账号登记回调地址。'], json: { endpoints: [] } };
      }

      // 按用户分组数投递状态 —— 只查这些用户，避免全表扫
      const ids = endpoints.map((e) => e.userId);
      const grouped = await ctx.prisma.fishWebhookDelivery.groupBy({
        by: ['userId', 'status'],
        where: { userId: { in: ids } },
        _count: { _all: true },
      });
      const countsOf = (uid: string) => {
        const rows = grouped.filter((g) => g.userId === uid);
        const get = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
        return { pending: get('pending') + get('sending'), delivered: get('delivered'), dead: get('dead') };
      };

      const lines = renderTable(
        [
          { key: 'user', title: '账号', maxWidth: 18 },
          { key: 'url', title: '回调地址', maxWidth: 40 },
          { key: 'state', title: '状态', maxWidth: 8 },
          { key: 'pending', title: '待投', align: 'right' },
          { key: 'dead', title: '死信', align: 'right' },
          { key: 'ok', title: '成功', align: 'right' },
          { key: 'last', title: '最近失败', maxWidth: 19 },
        ],
        endpoints.map((e) => {
          const c = countsOf(e.userId);
          return {
            user: e.userId,
            url: e.url,
            state: e.disabledAt ? '已停用' : `连续失败 ${e.consecutiveFailures}`,
            pending: c.pending,
            dead: c.dead,
            ok: c.delivered,
            last: ymdhms(e.lastFailureAt) ?? '—',
          };
        }),
        { maxWidth: ctx.io.width() }
      );

      const deadTotal = endpoints.reduce((a, e) => a + countsOf(e.userId).dead, 0);
      const warnings: string[] = [];
      if (deadTotal > 0) {
        warnings.push(
          ctx.io.yellow(
            `  有 ${deadTotal} 条已判死（dead）。商户那边没收到通知 —— 提醒它拉流水对账。`
          )
        );
      }
      return {
        lines,
        warnings,
        json: {
          endpoints: endpoints.map((e) => ({
            userId: e.userId,
            url: e.url,
            disabledAt: ymdhms(e.disabledAt),
            consecutiveFailures: e.consecutiveFailures,
            ...countsOf(e.userId),
          })),
        },
      };
    },
  },

  {
    name: 'fish webhook-retry',
    summary: '立刻重投待发的回调（不等退避）',
    group: 'fish',
    order: 9,
    readOnly: false,
    danger: 'safe',
    args: [],
    details: [
      '定时器正常情况下会自己重试（默认每 30 秒一扫，可用 FISH_WEBHOOK_DRAIN_MS 调）。',
      '本命令是**兜底与手动推动**：定时器关掉时、或刚修好商户端点想立刻补投时用。',
      '**不看退避时间**（ignoreBackoff）—— 运维要的是「现在就再试一遍」。',
      '投递是幂等的（认领是条件 UPDATE），与定时器同时跑不会重复发。',
    ].join('\n'),
    async run(ctx) {
      const { drainWebhookDeliveries } = await import('../../../src/lib/fish-webhook-service');
      const r = await drainWebhookDeliveries({
        ignoreBackoff: true,
        olderThanMs: 0,
        limit: 200,
      });

      if (r.scanned === 0 && r.reclaimed === 0) {
        return {
          lines: ['没有待投递的回调。'],
          json: { ...r },
        };
      }
      const warnings: string[] = [];
      if (r.dead > 0) {
        warnings.push(
          ctx.io.yellow(`  ${r.dead} 条已判死（dead）—— 见 \`fish webhooks\`，商户需自行对账。`)
        );
      }
      return {
        lines: [
          `扫描 ${r.scanned}：成功 ${r.delivered}，待重试 ${r.retried}，判死 ${r.dead}` +
            (r.reclaimed ? `，回收租约 ${r.reclaimed}` : '') +
            '。',
        ],
        warnings,
        json: { ...r },
      };
    },
  },

  {
    name: 'fish webhook-rekey',
    summary: '把存量回调签名密钥搬到专用加密密钥（迁移期一次性，可重复跑）',
    group: 'fish',
    order: 10,
    readOnly: false,
    danger: 'irreversible',
    args: [
      {
        name: 'dryRun',
        flags: ['--dry-run'],
        kind: 'boolean',
        label: '只预览',
        help: '只报「有几条待搬」，不写库',
        defaultValue: false,
        prompt: { type: 'confirm' as const },
      },
    ],
    details: [
      '把 `fish_webhook_endpoints.secret_encrypted` 的密文从 `SECRET_KEY` 派生',
      '重封到 `FISH_ENCRYPTION_KEY` 派生。**只是换封装，不换密钥本身** —— 商户手里',
      '那把签名密钥不变，验签代码一行都不用改。',
      '',
      '【为什么值得搬】搬之前，`SECRET_KEY`（会话 JWT 的签名密钥）同时是这些密文的',
      '钥匙：换一次会话密钥 = 商户再也收不到回调，而站点这边只在投递日志里看到失败。',
      '搬完之后 `SECRET_KEY` 就是纯粹的会话密钥了，泄漏后轮换它不再有连带后果。',
      '',
      '【前提】`.env` 里同时有 `FISH_ENCRYPTION_KEY`（目标钥匙）与 `SECRET_KEY`',
      '（存量密文的旧钥匙）。跑完可以把 `SECRET_KEY` 换成新值 —— 但**先跑完再换**。',
      '',
      '【可重复跑】逐行判状态：已经能用新钥匙解开的原样跳过，只有旧钥匙封的才重封。',
      '中断、部分完成、或「当时解不开后来补上钥匙」都能靠再跑一次收敛，不需要跟踪表。',
      '',
      '【两把钥匙都解不开的行】本命令**不动它们**（无法解密就不能重封），会列出来',
      '并要求人工查证：那种行只有当年加密时用的那个密钥能救。',
    ].join('\n'),
    async describe(ctx) {
      const { inspectWebhookSecret } = await import('../../../src/lib/fish-webhook-service');
      const rows = await ctx.prisma.fishWebhookEndpoint.findMany({
        select: { secretEncrypted: true },
      });
      if (rows.length === 0) return [];
      const count = { current: 0, legacy: 0, unreadable: 0 };
      for (const r of rows) count[inspectWebhookSecret(r.secretEncrypted)]++;

      const lines = [
        `  回调地址总数：${rows.length}`,
        `  ├─ 已是专用钥匙（跳过）：${count.current}`,
        `  ├─ 待搬（本次重封）：${count.legacy}`,
        `  └─ 两把钥匙都解不开（本次不动）：${count.unreadable}`,
      ];
      if (!process.env.FISH_ENCRYPTION_KEY) {
        lines.push('  ⚠️ FISH_ENCRYPTION_KEY 未设置 —— 没有目标钥匙，本命令会直接报错。');
      } else if (!process.env.SECRET_KEY) {
        lines.push('  ⚠️ SECRET_KEY 未设置 —— 若上面「待搬」不为 0，那些行解不开。');
      }
      return lines;
    },
    async run(ctx) {
      const { rekeyWebhookSecrets } = await import('../../../src/lib/fish-webhook-service');
      const dryRun = ctx.args.dryRun === true;

      let r;
      try {
        r = await rekeyWebhookSecrets({ dryRun });
      } catch (e) {
        // 缺 FISH_ENCRYPTION_KEY 这类是**用户错误**（少设一个变量），不是真故障
        throw new CliError(`错误：${errorMessage(e)}`, 1);
      }

      const warnings: string[] = [];
      if (r.unreadable.length > 0) {
        warnings.push(
          ctx.io.yellow(
            `  ⚠️ ${r.unreadable.length} 条两把钥匙都解不开，本次未动：${r.unreadable.join('、')}`
          ),
          '     这些行只有当年加密它们的那把钥匙能救 —— 查清那把钥匙是什么，设成 SECRET_KEY 再跑一次；',
          '     在此之前，那些商户的回调**一直投递失败**（`fish webhooks` 里看得到 consecutive_failures）。'
        );
      }
      if (r.failed.length > 0) {
        warnings.push(
          ctx.io.yellow(`  ${r.failed.length} 条写入失败（已搬过去的不回滚）：${r.failed.join('、')}`)
        );
      }

      const lines = dryRun
        ? [
            `--dry-run：未写库。共 ${r.total} 条，其中待搬 ${r.migrated} 条、` +
              `已是专用钥匙 ${r.alreadyCurrent} 条、解不开 ${r.unreadable.length} 条。`,
          ]
        : [
            ctx.io.green(
              `成功：本次重封 ${r.migrated} 条，另有 ${r.alreadyCurrent} 条本来就是专用钥匙。`
            ),
          ];
      if (!dryRun && r.total === 0) {
        lines.push('  库里没有登记过回调地址 —— 没有需要搬的东西。');
      } else if (!dryRun && r.unreadable.length === 0 && r.failed.length === 0) {
        lines.push(
          '  库里已没有旧钥匙封的密文 —— 此后 `SECRET_KEY` 可以自由轮换，与商户回调无关。'
        );
      }

      // 有解不开的或写失败的 → 退出码 2（真故障档），把「还没收尾」这件事顶到脚本层
      if (r.unreadable.length > 0 || r.failed.length > 0) {
        throw new CliError(
          `失败：${r.unreadable.length} 条解不开，${r.failed.length} 条写入失败`,
          2,
          [...warnings, '', `  重跑（已搬过去的会自动跳过）：npm run cli -- fish webhook-rekey --yes`]
        );
      }

      return { lines, warnings, json: { ...r } };
    },
  },
];
