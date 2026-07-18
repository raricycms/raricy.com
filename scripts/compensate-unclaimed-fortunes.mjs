#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// compensate-unclaimed-fortunes.mjs
//
// 【为什么需要这个脚本】
// Flask 的签到是**两步**：check_in() 先建记录（fortune_value=NULL、fortune_pool 已定），
// 再由 claim_fortune() 让用户翻牌赋值 + 发鱼干。Next 侧合并成了一步（签到即翻牌），
// 因此**没有单独的 claim 入口**。
//
// 后果：迁移时库里若存在「已签到但未翻牌」的记录（fortune_value IS NULL），
// 这些用户切到 Next 后永远翻不了那张牌 —— doCheckin 会被唯一约束
// (user_id, checkin_date) 挡住，而 claim 路径不存在。他们那天的鱼干和 total_fortune
// 就永久丢了。真实库里有 7 条这样的记录（最近一条 2026-07-15）。
//
// 【补偿口径 —— 逐条对齐 Flask claim_fortune】
//   1. 从该记录**自己的** fortune_pool 里取一张（池是签到当时就定好的，不是现编）
//   2. 原子置 fortune_value（WHERE fortune_value IS NULL，重复跑不会二次赋值）
//   3. total_fortune += fortune_value
//   4. 发等额鱼干 + 写一条 type='checkin' 的流水
// 与 claim_fortune 唯一的差别：用户当时没选，只能由脚本代选 —— 默认取 index 0
// （池本身已是随机洗牌的结果，取哪张都等价于随机）。可用 --index 覆盖。
//
// 【安全设计】
//   · 默认 dry-run，必须显式 --apply 才写库
//   · 强制要求 --db 显式指定目标库（不读 .env，避免手滑打到别的库）
//   · 每步原子（WHERE ... IS NULL），可重复执行，不会重复发鱼
//   · 逐条打印将要发生的变更，--apply 前必须先看一遍
//
// 用法：
//   node scripts/compensate-unclaimed-fortunes.mjs --db /path/to/db.db            # 预演
//   node scripts/compensate-unclaimed-fortunes.mjs --db /path/to/db.db --apply    # 执行
//   node scripts/compensate-unclaimed-fortunes.mjs --db ... --apply --index 2     # 指定翻第 3 张
//
// ⚠️ 执行前请备份目标库。
// ─────────────────────────────────────────────────────────────────────────────

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

// ── 参数 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

const dbPath = arg('--db');
const apply = has('--apply');
const chosenIndex = Number(arg('--index') ?? 0);

if (!dbPath) {
  console.error(
    '用法：node scripts/compensate-unclaimed-fortunes.mjs --db <数据库路径> [--apply] [--index 0-4]\n' +
      '（必须显式指定 --db，不读 .env —— 避免手滑打到别的库）'
  );
  process.exit(2);
}
if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(2);
}
if (!Number.isInteger(chosenIndex) || chosenIndex < 0 || chosenIndex > 4) {
  console.error(`--index 必须是 0-4 的整数，收到：${arg('--index')}`);
  process.exit(2);
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

/** 解析 "3,1,2,4,5" → [3,1,2,4,5]；非法返回 null（对齐 Flask _parse_pool）。 */
function parsePool(pool) {
  if (!pool) return null;
  const vals = String(pool)
    .split(',')
    .map((x) => Number.parseInt(x, 10));
  if (vals.length !== 5 || vals.some((v) => Number.isNaN(v))) return null;
  return vals;
}

/**
 * 写库用的当前时间：UTC+8 墙上时间（与 src/lib/db-time.ts 的 nowForDb 同口径）。
 * 本库时间戳语义是「UTC+8 墙上时间贴 Z 标签」，用真实 UTC 会与既有数据差 8 小时。
 */
const nowForDbMs = () => Date.now() + 8 * 3600 * 1000;

/**
 * checkin_date 展示成 YYYY-MM-DD。
 * 规整后该列是 INTEGER 毫秒；未规整时是文本 —— 两种都要能读，否则这个脚本
 * 在「规整前跑」和「规整后跑」会显示成两个样子。
 */
function fmtDay(v) {
  if (v == null) return '(空)';
  const s = String(v);
  if (/^\d{10,}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

const db = new DatabaseSync(dbPath);

// ── 1. 找出待补偿记录 ────────────────────────────────────────────────────────
const rows = db
  .prepare(
    `SELECT c.id, c.user_id, CAST(c.checkin_date AS TEXT) AS checkin_date,
            c.fortune_pool, u.username, u.total_fortune, u.dried_fish
       FROM daily_checkins c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.fortune_value IS NULL
      ORDER BY c.checkin_date DESC`
  )
  .all();

console.log(`\n目标库：${dbPath}`);
console.log(`模式：${apply ? '\x1b[31m执行（将写库）\x1b[0m' : '\x1b[32m预演（不写库）\x1b[0m'}`);
console.log(`翻牌选择：index ${chosenIndex}（池已是随机洗牌结果，取哪张等价于随机）\n`);

if (rows.length === 0) {
  console.log('✅ 没有「已签到但未翻牌」的记录，无需补偿。');
  process.exit(0);
}

console.log(`找到 ${rows.length} 条待补偿记录：\n`);

// ── 2. 逐条计算将要发生的变更 ────────────────────────────────────────────────
const plan = [];
for (const r of rows) {
  const pool = parsePool(r.fortune_pool);
  if (pool === null) {
    console.log(
      `  \x1b[33m跳过\x1b[0m id=${r.id} user=${r.username ?? r.user_id} ` +
        `date=${r.checkin_date} —— fortune_pool 非法（"${r.fortune_pool}"），无法确定该发多少`
    );
    continue;
  }
  if (r.username == null) {
    console.log(
      `  \x1b[33m跳过\x1b[0m id=${r.id} user_id=${r.user_id} —— 用户不存在（外键悬空）`
    );
    continue;
  }
  const value = pool[chosenIndex];
  plan.push({ ...r, pool, value });
  console.log(
    `  id=${String(r.id).padStart(4)} ${String(r.username).padEnd(16)} ${fmtDay(r.checkin_date)}  ` +
      `池=[${pool.join(',')}] → 翻出 \x1b[36m${value}\x1b[0m  ` +
      `(鱼干 ${r.dried_fish} → ${(r.dried_fish ?? 0) + value}, ` +
      `运势 ${r.total_fortune} → ${(r.total_fortune ?? 0) + value})`
  );
}

const totalFish = plan.reduce((s, p) => s + p.value, 0);
console.log(`\n合计：${plan.length} 条，补发 ${totalFish} 条小鱼干。`);

if (!apply) {
  console.log('\n\x1b[32m这是预演，没有写任何数据。\x1b[0m 确认无误后加 --apply 执行。');
  console.log('⚠️ 执行前请先备份目标库。\n');
  process.exit(0);
}

// ── 3. 执行（单事务 + 每步原子条件写）────────────────────────────────────────
console.log('\n开始执行…\n');

const now = nowForDbMs();
let done = 0;
let skipped = 0;

db.exec('BEGIN');
try {
  for (const p of plan) {
    // 3.1 原子置 fortune_value —— 对齐 Flask 的 WHERE fortune_value IS NULL。
    //     重复执行本脚本时这里会 changes=0，从而不会二次发鱼。
    const upd = db
      .prepare(
        `UPDATE daily_checkins SET fortune_value = ?
          WHERE id = ? AND fortune_value IS NULL`
      )
      .run(p.value, p.id);

    if (Number(upd.changes) === 0) {
      console.log(`  \x1b[33m跳过\x1b[0m id=${p.id} —— 已被翻过（并发/重复执行），不重复发鱼`);
      skipped += 1;
      continue;
    }

    // 3.2 累加 total_fortune（原子自增，不做读-改-写）
    db.prepare(`UPDATE users SET total_fortune = COALESCE(total_fortune, 0) + ? WHERE id = ?`).run(
      p.value,
      p.user_id
    );

    // 3.3 发鱼干
    db.prepare(`UPDATE users SET dried_fish = COALESCE(dried_fish, 0) + ? WHERE id = ?`).run(
      p.value,
      p.user_id
    );

    // 3.4 写流水（type/description 逐字对齐 Flask claim_fortune 里的 add_fish 调用）
    //     created_at 存 INTEGER 毫秒 —— 与规整后的库、与 Prisma 的写入格式一致。
    db.prepare(
      `INSERT INTO fish_transactions (user_id, amount, type, description, created_at)
       VALUES (?, ?, 'checkin', ?, ?)`
    ).run(p.user_id, p.value, `每日签到（运势值 ${p.value}）`, now);

    console.log(`  \x1b[32m✓\x1b[0m id=${p.id} ${p.username} 补发 ${p.value} 条鱼干`);
    done += 1;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('\n\x1b[31m执行失败，已整体回滚，数据未变更：\x1b[0m', e);
  process.exit(1);
}

// ── 4. 复核 ──────────────────────────────────────────────────────────────────
const left = db
  .prepare(`SELECT COUNT(*) AS n FROM daily_checkins WHERE fortune_value IS NULL`)
  .get();

console.log(`\n\x1b[32m✅ 完成：补偿 ${done} 条，跳过 ${skipped} 条。\x1b[0m`);
console.log(`   剩余未翻牌记录：${left.n}（应为 0；非 0 说明有 pool 非法或用户不存在的记录，见上方跳过项）`);

// ⚠️ 与账户微服务的一致性提醒
console.log(
  '\n⚠️  本脚本只写**本地库**。若账户微服务已上线，补发的鱼干需要同步到远端账户，\n' +
    '   否则本地与远端账目不一致。请在切换前执行本脚本（此时远端尚未接管），\n' +
    '   或执行后按 total 差额做一次对账。\n'
);
