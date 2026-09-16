// ─────────────────────────────────────────────────────────────────────────────
// service-accounts.ts — 服务账号（配额白名单）
//
// 用途：给「站外银行 / 机器人」这类**自动化账号**抬转账配额。普通账号是
// 30 次/时、200 次/天 —— 一个几十人的银行光提现就能吃光，业务直接停摆。
//
// 【为什么是环境变量而不是数据库列】
//   · 零迁移（本站手写 SQL 迁移，能不动就不动）；
//   · 撤销 = 删掉一行配置 + 重启，出事时是最快的手段，也没有「忘改库」这一层；
//   · 白名单天生是运维决定，不是用户可见状态。
//
// 【风险与配套】白名单一生效，那个账号的唯一反滥用闸门就只剩「可撤销」这一层 ——
// 它成为一根共享管道（A → 银行 → B 可以绕开每人 30/时的限制）。所以：
//   · 只给真正需要的账号开口子，且额度仍是有限的（500/时、5000/天）；
//   · 出事时的三档手段：移出白名单 → 禁言 → 封号（见 docs/bot/fish-bot.md §4）。
//
// 【按 user id 而不是用户名】用户名虽然不可改（updateOwnProfile 里没有这个字段），
// 但 id 是更强的身份锚点，且不会因为「某人注册了个同名账号」之类的将来变化而漂移。
// ─────────────────────────────────────────────────────────────────────────────

import type { RateRule } from './rate-limit';

/** 逗号分隔的 user id 列表（如 `FISH_SERVICE_ACCOUNTS="uid-a,uid-b"`）。 */
function whitelist(): string[] {
  return (process.env.FISH_SERVICE_ACCOUNTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 该账号是否在白名单里（每次读 env：测试可 stubEnv，无需重启进程语义）。 */
export function isServiceAccount(userId: string): boolean {
  return whitelist().includes(userId);
}

/**
 * 服务账号的转账配额（覆盖 RULES.transferHourly / transferDaily）。
 *
 * 【为什么只抬转账这两条】无状态接口那条 20 次/分/账号是 **CPU 闸门**（每次请求
 * 都要跑一次 scrypt），不是业务额度 —— 站外银行的热循环应该用会话（登录一次
 * cookie 有效 30 天），会话路径根本不消耗它。见 docs/bot/fish-bot.md §4。
 */
export const SERVICE_QUOTA = {
  transferHourly: { limit: 500, windowMs: 60 * 60 * 1000 },
  transferDaily: { limit: 5000, windowMs: 24 * 60 * 60 * 1000 },
} as const satisfies Record<string, RateRule>;
