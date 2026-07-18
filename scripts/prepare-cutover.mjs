#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// prepare-cutover.mjs —— 把切换手册 §3.2~§3.6 的数据库那半段串成一条命令
//
// 【为什么要有】手册那 7 步全靠人肉按顺序敲，而它们**有严格的先后依赖**，
// 且每一步都得验完才能走下一步：
//   · 备份没验就规整 → 出事时才发现备份是坏的，等于没备份
//   · 没停 Flask 就规整 → 丢掉规整开始之后写入的行，而且**事后完全看不出来**
//   · 规整后没验墙上时间 → 全站时间静默漂 8 小时
//   · 补偿没先 dry-run → 直接改 465 个用户的余额
//   · 密钥没验就起服务 → 上线后被用户投诉才发现鱼干全废，而这一步不可逆
// 凌晨的维护窗口里，靠人记住这些顺序不现实。这个脚本把顺序和验证钉死。
//
// 【它做什么】
//   1. 备份源库（.backup，不是 cp）并验证备份能打开、行数对得上
//   2. 规整时间戳（源库只读）
//   3. 全量核对：33 个时间列逐条比对墙上时间，一处漂移都不许有
//   4. 补偿未翻牌的签到（默认只预演）
//   5. 跑 diagnose（含 SECRET_KEY 能否解开存量密文 —— 唯一不可逆的那步）
//
// 【它不做什么】停 Flask、起服务、切 nginx、TLS —— 那些依赖具体机器，
// 手册 §3.1 / §3.7 / §3.8 讲得清楚，也该由人看着做。
//
// 用法：
//   # 预演（默认）—— 只读源库，产出规整后的新库，补偿只打印不写
//   npx tsx scripts/prepare-cutover.mjs --source /path/to/db.db --dest /path/to/prod.db
//
//   # 真的执行补偿
//   npx tsx scripts/prepare-cutover.mjs --source ... --dest ... --apply
//
//   验密钥那步需要 SECRET_KEY，照生产的传：
//   SECRET_KEY=xxx npx tsx scripts/prepare-cutover.mjs --source ... --dest ...
//
// ⚠️ 源库全程只读。脚本结束会比对源库的 SHA-256，证明没碰过它。
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};

const source = arg('--source');
const dest = arg('--dest');
const apply = argv.includes('--apply');
const backupDir = arg('--backup-dir') ?? path.join(path.dirname(dest ?? '.'), 'backup');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

if (!source || !dest) {
  console.error('用法：npx tsx scripts/prepare-cutover.mjs --source <源库> --dest <目标库> [--apply]');
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(red(`源库不存在：${source}`));
  process.exit(2);
}
if (path.resolve(source) === path.resolve(dest)) {
  // 同一个文件会让「源库只读」这条保证失效，而它正是出事时的唯一退路
  console.error(red('--source 与 --dest 不能是同一个文件：源库必须保持只读，它是你的兜底'));
  process.exit(2);
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sqlite = (db, sql) =>
  execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();

const sourceShaBefore = sha(source);
let failed = 0;
const step = (n, t) => console.log(bold(`\n── ${n}. ${t} ──`));
const ok = (m) => console.log(`  ${green('✓')} ${m}`);
const bad = (m) => {
  failed++;
  console.log(`  ${red('✗')} ${m}`);
};

console.log(bold('\n═══ 切换准备（数据库部分）═══'));
console.log(`模式：${apply ? red('执行（会写补偿）') : green('预演（补偿只打印）')}`);
console.log(`源库：${source}\n目标：${dest}`);

// ── 0. 源库还在被写吗 ───────────────────────────────────────────────────────
step(0, '源库是否已停止写入');
// -wal 有内容通常意味着还有连接在写。规整一个正在被写的库，会丢掉规整开始之后
// 写入的行，而且**事后完全看不出来** —— 数据就是少了几条，没有任何报错。
const wal = source + '-wal';
if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
  console.log(`  ${yellow('!')} 存在非空的 WAL（${fs.statSync(wal).size} 字节）—— Flask 可能还在跑`);
  console.log(`     ${yellow('→ 先停掉 Flask（手册 §3.1）再来。带着写入做规整会静默丢数据')}`);
} else {
  ok('未见活跃 WAL');
}

// ── 1. 备份 + 验备份 ────────────────────────────────────────────────────────
step(1, '备份源库并验证备份可用');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = sqlite(source, "select strftime('%Y%m%d-%H%M%S','now')");
const backup = path.join(backupDir, `db-${stamp}.db`);
// .backup 而不是 cp：有 WAL 时 cp 会拷到不一致的快照
execFileSync('sqlite3', [source, `.backup '${backup}'`]);
ok(`已备份 → ${backup}`);

const counts = (db) => ({
  users: Number(sqlite(db, 'select count(*) from users')),
  blogs: Number(sqlite(db, 'select count(*) from blogs')),
  comments: Number(sqlite(db, 'select count(*) from blog_comments')),
});
const srcCount = counts(source);
const bakCount = counts(backup);
if (JSON.stringify(srcCount) === JSON.stringify(bakCount)) {
  ok(`备份可打开且行数一致：users=${bakCount.users} blogs=${bakCount.blogs} comments=${bakCount.comments}`);
} else {
  bad(`备份行数对不上：源 ${JSON.stringify(srcCount)} vs 备份 ${JSON.stringify(bakCount)}`);
}

// ── 2. 规整时间戳 ───────────────────────────────────────────────────────────
step(2, '规整时间戳（TEXT → INTEGER 毫秒）');

// ★ 目标库会被推平重建 ★
//
// 切换前重复跑本脚本是安全的：dest 每次都从源库重新生成，结果完全一致
// （补偿是确定性的，同一条记录每次翻出同一张牌）。
//
// 但**切换之后**网站就跑在 dest 上了。这时谁再手滑跑一次 —— 比如想「再确认一遍
// 准备工作」—— dest 会被推平重建，上线后新增的一切（新用户、新文章、新签到）
// 全部消失，而源库里没有它们。所以：dest 已存在就必须显式 --overwrite-dest。
if (fs.existsSync(dest)) {
  if (!argv.includes('--overwrite-dest')) {
    console.log(`  ${red('✗')} 目标库已存在：${dest}`);
    console.log(`     ${yellow('→ 本步骤会把它推平重建。若网站已经跑在这个库上，重建 = 丢掉上线后的全部数据。')}`);
    console.log(`     ${yellow('  确认它只是上一次准备的产物、可以丢，再加 --overwrite-dest 重跑。')}`);
    process.exit(1);
  }
  console.log(`  ${yellow('!')} 目标库已存在，按 --overwrite-dest 推平重建`);
}
for (const s of ['', '-wal', '-shm']) fs.rmSync(dest + s, { force: true });
execFileSync('node', [path.join(HERE, 'normalize-datetimes.mjs'), '--source', source, '--dest', dest], {
  stdio: 'pipe',
});
const dstCount = counts(dest);
if (JSON.stringify(srcCount) === JSON.stringify(dstCount)) {
  ok(`行数无损失：users=${dstCount.users} blogs=${dstCount.blogs} comments=${dstCount.comments}`);
} else {
  bad(`规整后行数变了：${JSON.stringify(srcCount)} → ${JSON.stringify(dstCount)}`);
}

// ── 3. 墙上时间零漂移 ───────────────────────────────────────────────────────
step(3, '全量核对墙上时间（一处漂移都不许有）');
// 逐个时间列把规整后的整数还原成字符串，跟源库的文本逐条比。
// DATE 列存的是 'YYYY-MM-DD'（10 字符），DATETIME 是 19 字符 —— 格式不分开会全不等，
// 那是比对脚本的错，不是数据漂了（这个坑踩过）。
const tables = sqlite(
  dest,
  "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'alembic%'"
).split('\n').filter(Boolean);

let cols = 0;
let drift = 0;
for (const t of tables) {
  const info = sqlite(dest, `pragma table_info(${t})`).split('\n').filter(Boolean).map((r) => r.split('|'));
  const pk = info.find((r) => r[5] === '1');
  if (!pk) continue;
  for (const r of info) {
    const [, col, ty] = r;
    const T = (ty || '').toUpperCase();
    if (!T.startsWith('DATETIME') && !T.startsWith('DATE') && !T.startsWith('TIMESTAMP')) continue;
    const dateOnly = T.startsWith('DATE') && !T.startsWith('DATETIME');
    const fmt = dateOnly ? '%Y-%m-%d' : '%Y-%m-%d %H:%M:%S';
    const cut = dateOnly ? 10 : 19;
    cols++;
    const n = Number(
      sqlite(
        dest,
        `attach '${source}' as old;
         select count(*) from ${t} n join old.${t} o on n.${pk[1]}=o.${pk[1]}
         where n.${col} is not null and o.${col} is not null
           and strftime('${fmt}', n.${col}/1000.0,'unixepoch') != substr(o.${col},1,${cut});`
      )
    );
    if (n) {
      drift += n;
      bad(`${t}.${col}：${n} 行墙上时间漂了`);
    }
  }
}
if (!drift) ok(`${cols} 个时间列全部零漂移`);

// ── 4. 补偿未翻牌的签到 ─────────────────────────────────────────────────────
step(4, `补偿未翻牌的签到${apply ? '（执行）' : '（预演）'}`);
const pending = Number(sqlite(dest, 'select count(*) from daily_checkins where fortune_value is null'));
if (!pending) {
  ok('没有「已签到但未翻牌」的记录，无需补偿');
} else {
  console.log(`  待补偿 ${pending} 条`);
  const out = execFileSync(
    'node',
    [
      path.join(HERE, 'compensate-unclaimed-fortunes.mjs'),
      '--db', dest,
      ...(apply ? ['--apply'] : []),
    ],
    { encoding: 'utf8' }
  );
  console.log(out.split('\n').filter((l) => l.trim()).map((l) => '    ' + l).join('\n'));
  const left = Number(sqlite(dest, 'select count(*) from daily_checkins where fortune_value is null'));
  if (apply && left) bad(`执行后仍剩 ${left} 条未补偿`);
  else if (apply) ok('补偿完成，无残留');
  else console.log(`  ${yellow('!')} 这是预演。确认无误后加 --apply 再跑一次`);
}

// ── 5. 自检（含唯一不可逆的密钥验证）──────────────────────────────────────
step(5, '自检（含 SECRET_KEY 能否解开存量密文）');
if (!process.env.SECRET_KEY) {
  console.log(`  ${yellow('!')} 未传 SECRET_KEY，跳过密钥验证`);
  console.log(`     ${yellow('→ 这是整个切换里唯一不可逆的一步，务必单独验：')}`);
  console.log(`     ${yellow(`   DATABASE_URL="file:${dest}" SECRET_KEY=<生产的> npm run diagnose`)}`);
} else {
  try {
    const out = execFileSync('npx', ['tsx', path.join(HERE, 'diagnose-deploy.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: `file:${dest}` },
      cwd: path.resolve(HERE, '..'),
    });
    const sec = out.split('4. 小鱼干密钥')[1]?.split('\n').slice(0, 4).join('\n');
    console.log(sec ? sec.split('\n').map((l) => '  ' + l.trim()).join('\n') : out.slice(-400));
    if (/✗/.test(sec ?? '')) bad('密钥验证没过 —— 上线前必须解决');
  } catch (e) {
    // diagnose 有致命项时 exit≠0，execFileSync 会抛；它的输出仍要给人看
    const out = String(e.stdout ?? '');
    const sec = out.split('4. 小鱼干密钥')[1]?.split('\n').slice(0, 4).join('\n');
    if (sec) console.log(sec.split('\n').map((l) => '  ' + l.trim()).join('\n'));
    bad('diagnose 报了致命项 —— 上线前必须解决（完整输出请单独跑 npm run diagnose）');
  }
}

// ── 源库有没有被碰过 ────────────────────────────────────────────────────────
step('✓', '源库完整性');
if (sha(source) === sourceShaBefore) {
  ok(`源库未被改动（SHA-256 ${sourceShaBefore.slice(0, 16)}…）—— 它仍是你的兜底`);
} else {
  bad('源库的校验和变了！本脚本本不该写它 —— 别继续，先查清楚');
}

console.log(bold('\n═══ 结论 ═══'));
if (failed) {
  console.log(red(`  ❌ ${failed} 项未通过 —— 别往下走（手册 §3.7 起服务之前必须全绿）\n`));
  process.exit(1);
}
if (!apply && pending) {
  console.log(yellow('  ⚠️ 预演通过。补偿尚未执行 —— 确认上面的逐条变更无误后，加 --apply 再跑一次。\n'));
  process.exit(0);
}
console.log(green('  ✅ 数据库这半段准备就绪。'));
console.log('     接下来是手册 §3.5 配 .env、§3.6 npm ci + build、§3.7 起服务、§3.8 切 nginx。\n');
