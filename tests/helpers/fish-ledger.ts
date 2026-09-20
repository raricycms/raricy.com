// ─────────────────────────────────────────────────────────────────────────────
// fish-ledger.ts — 记账不变式的测试助手
//
// 【为什么需要它】站外那个账户微服务曾经提供了**第二双眼睛**：它的复式账本可以在
// 事后核对本站的余额。搬进站内之后没有第二个存储了 —— 账目对不对，只能靠**内部
// 一致性**来证明。这条不变式就是那份替代品：
//
//     每个用户的 users.driedFish  ==  他所有 fish_transactions.amount 之和
//
// 它同时钉住两件在钱上最要命的事：
//   · 有人改了余额但漏写流水（或反过来）—— 靠差额暴露；
//   · 余额被扣成负数 —— 出账的条件谓词（postEntry 的 `driedFish >= need`）失效时
//     唯一的征兆就是它，而负数余额在页面上看起来只是个「0」。
//
// 【怎么用】任何跑过鱼干写路径的用例都可以在末尾调 `expectLedgerConsistent()`。
// 单独跑一个「什么都不做」的用例证明不了任何东西 —— 它的价值在于**附着在真实
// 业务用例上**（转账、投喂、签到翻牌、练手盘、CLI 发扣、群发补偿）。
//
// ⚠️⚠️ **前提：这个用户的余额必须「有来源」**。绝对不变式对**凭空塞出来的余额**
// 不成立，而 `makeUser({ driedFish: N })` 正是凭空塞 —— 它只写列、不写流水，
// 于是一个刚造出来的用户就已经「撕裂」了。
// **造有余额的用户请用 `makeFishUser(N)`**，它让余额经由 postEntry 进入，
// 与线上完全同构（线上余额从来只有写路径这一个来源，
// 连 scripts/compensate-unclaimed-fortunes.mjs 都会补写配套流水）。
// 用 makeUser 造余额的用例**不能**调本助手 —— 那不是账坏，是夹具没来源。
//
// ⚠️ 只断言「对得上」，不断言具体数值 —— 数值由各用例自己断言。这里管的是
// 「无论发生什么，账不能撕裂」。
// ─────────────────────────────────────────────────────────────────────────────

import { expect } from 'vitest';
import { prisma } from '@/lib/db';
import { postEntry } from '@/lib/fish-service';
import { fishToUnits, unitsToFish } from '@/lib/fish-units';
import { makeUser } from './db';

export interface LedgerMismatch {
  userId: string;
  username: string;
  /** users.driedFish —— **存储单位**（0.1 鱼干）。报错信息里换算成鱼干给人看。 */
  balance: number;
  /** SUM(fish_transactions.amount)，没有流水时为 0。同为存储单位。 */
  ledgerSum: number;
  /** balance − ledgerSum（存储单位），非 0 即撕裂。 */
  diff: number;
}

export interface LedgerReport {
  mismatches: LedgerMismatch[];
  /** 余额为负的用户（不可能出现 —— 出账一律走带谓词的条件写）。 */
  negatives: LedgerMismatch[];
  userCount: number;
  txCount: number;
}

/**
 * 存储单位 → 报错信息里的鱼干。
 * 不加 `+` 号：三个数字都带标签（余额 / 流水和 / 差），负数自己带 `-`，
 * 再加一层正号只会让人读第二遍才认出这是余额还是增量。
 */
function fish(units: number): string {
  return String(unitsToFish(units));
}

/**
 * 造一个有余额的用户，**余额经由记账内核进入**（因此满足绝对不变式）。
 *
 * 【为什么不能直接 makeUser({ driedFish: N })】那会造出一个「无来源的余额」——
 * 列里有 N，流水里什么都没有。真实用户不存在这种状态（余额只有写路径一个来源），
 * 拿它去跑不变式会当场报撕裂，把「夹具不真实」误诊成「账坏了」。
 */
export async function makeFishUser(
  amount: number,
  opts: Parameters<typeof makeUser>[0] = {}
) {
  const u = await makeUser({ ...opts, driedFish: 0 });
  if (amount > 0) {
    await prisma.$transaction((tx) =>
      postEntry(tx, {
        userId: u.id,
        units: fishToUnits(amount),
        type: 'admin_grant',
        description: '测试夹具：让余额有来源',
      })
    );
  }
  return u;
}

/** 全库核对一次，返回所有撕裂点。不断言，供调用方自己决定怎么用。 */
export async function auditLedger(): Promise<LedgerReport> {
  const users = await prisma.user.findMany({
    select: { id: true, username: true, driedFish: true },
  });
  // 一次 groupBy 拿全部用户的流水合计（不是每人一次查询 —— 那在几百用户时就很慢）。
  const sums = await prisma.fishTransaction.groupBy({
    by: ['userId'],
    _sum: { amount: true },
  });
  const sumByUser = new Map<string, number>();
  for (const s of sums) sumByUser.set(s.userId, s._sum.amount ?? 0);

  const mismatches: LedgerMismatch[] = [];
  const negatives: LedgerMismatch[] = [];
  for (const u of users) {
    const ledgerSum = sumByUser.get(u.id) ?? 0;
    if (u.driedFish !== ledgerSum) {
      mismatches.push({
        userId: u.id,
        username: u.username,
        balance: u.driedFish,
        ledgerSum,
        diff: u.driedFish - ledgerSum,
      });
    }
    if (u.driedFish < 0) {
      negatives.push({
        userId: u.id,
        username: u.username,
        balance: u.driedFish,
        ledgerSum,
        diff: u.driedFish - ledgerSum,
      });
    }
  }

  const txCount = await prisma.fishTransaction.count();
  return { mismatches, negatives, userCount: users.length, txCount };
}

/**
 * 断言全库账目自洽（**绝对口径**：每个用户的余额都必须等于他自己的流水之和）。
 *
 * ⚠️ 前提见文件头：余额必须**有来源**。用 `makeFishUser` 造的用户满足，
 * 用 `makeUser({ driedFish: N })` 造的不满足。
 *
 * @param context 出问题时打在报错里的场景描述 —— 失败信息要能直接指出
 *                「哪一步之后账坏了」，否则只能二分排查。
 */
export async function expectLedgerConsistent(context = ''): Promise<void> {
  const { mismatches, negatives, userCount, txCount } = await auditLedger();
  const where = context ? `（${context}）` : '';

  expect(
    mismatches,
    `账目撕裂${where}：余额与流水之和对不上的用户（共 ${userCount} 人 / ${txCount} 条流水）：\n` +
      mismatches
        .map(
          (m) =>
            `  ${m.username}(${m.userId}) 余额=${fish(m.balance)} 流水和=${fish(m.ledgerSum)} 差=${fish(m.diff)}`
        )
        .join('\n') +
      '\n（余额与流水都以**鱼干**为单位显示；若差值恰好等于某个用户的初始余额，' +
      '多半是夹具直接塞了 driedFish、没走 makeFishUser）'
  ).toEqual([]);

  expect(
    negatives,
    `出现负数余额${where} —— 出账的条件谓词漏了：\n` +
      negatives.map((m) => `  ${m.username}(${m.userId}) 余额=${fish(m.balance)}`).join('\n')
  ).toEqual([]);
}
