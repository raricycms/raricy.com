// ─────────────────────────────────────────────────────────────────────────────
// normalize-datetimes.mjs
//
// 把 SQLAlchemy 写入的 "YYYY-MM-DD HH:MM:SS.ffffff"（空格分隔、无时区）时间戳
// 规整为 Prisma/SQLite 要求的 ISO-8601 "YYYY-MM-DDTHH:MM:SS.sssZ"。
//
// 为什么必须做：Prisma 的 SQLite 连接器按列的声明类型 DATETIME 在驱动层解析，
// 遇到空格分隔格式会直接报 "Conversion failed: input contains invalid characters"。
//
// 幂等：只转换尚未含 'T' 的值，重复运行安全。
//
// 用法：
//   node scripts/normalize-datetimes.mjs --source ../instance/database/db.db --dest prisma/dev.db
//        → 先把 source 复制成 dest，再对 dest 规整（推荐：不碰线上库）
//   node scripts/normalize-datetimes.mjs --in-place path/to/db.db
//        → 就地规整（正式硬切换时用；执行前务必备份，且 Flask 需已停机或已配 ISO 兼容类型）
//   npm run db:normalize
//        → 等价于把线上 SQLite 复制到 prisma/dev.db 再规整（见 package.json）
// ─────────────────────────────────────────────────────────────────────────────

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 每张表需要规整的 DATETIME / DATE 列
const DATETIME_COLUMNS = {
  users: ['created_at', 'last_login', 'ban_until'],
  invite_codes: ['created_at'],
  user_bans: ['banned_at', 'ban_until', 'lifted_at'],
  blogs: ['created_at', 'last_comment_at'],
  blog_contents: ['updated_at'],
  blog_likes: ['created_at', 'deleted_at'],
  blog_feeds: ['created_at', 'updated_at'],
  categories: ['created_at'],
  blog_comments: ['created_at', 'updated_at'],
  comment_likes: ['created_at'],
  notifications: ['timestamp'],
  clipboards: ['created_at'],
  clip_text: ['updated_at'],
  image_hosting: ['created_at'],
  photo_wall_items: ['created_at', 'updated_at'],
  votes: ['created_at'],
  vote_records: ['created_at'],
  daily_checkins: ['checkin_date', 'created_at'],
  fish_transactions: ['created_at'],
  admin_action_logs: ['created_at'],
  admin_action_appeals: ['created_at', 'updated_at', 'decided_at'],
};

function parseArgs(argv) {
  const args = { source: null, dest: null, inPlace: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--dest') args.dest = argv[++i];
    else if (argv[i] === '--in-place') args.inPlace = argv[++i];
  }
  return args;
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let target;
  if (args.inPlace) {
    target = resolve(process.cwd(), args.inPlace);
    if (!existsSync(target)) throw new Error(`--in-place 目标不存在: ${target}`);
    console.log(`⚠️  就地规整: ${target}（确认已备份 / Flask 已停机）`);
  } else {
    const source = resolve(process.cwd(), args.source || '../instance/database/db.db');
    target = resolve(process.cwd(), args.dest || 'prisma/dev.db');
    if (!existsSync(source)) throw new Error(`源库不存在: ${source}`);
    copyFileSync(source, target);
    console.log(`📋 已复制 ${source} → ${target}`);
  }

  const db = new DatabaseSync(target);
  let totalUpdated = 0;

  db.exec('BEGIN');
  try {
    for (const [table, cols] of Object.entries(DATETIME_COLUMNS)) {
      if (!tableExists(db, table)) {
        console.log(`  · 跳过不存在的表 ${table}`);
        continue;
      }
      for (const col of cols) {
        // 只转换尚未 ISO 化（不含 'T'）的非空值 → 幂等
        const stmt = db.prepare(
          `UPDATE "${table}" SET "${col}" = strftime('%Y-%m-%dT%H:%M:%fZ', "${col}") ` +
            `WHERE "${col}" IS NOT NULL AND instr("${col}", 'T') = 0`
        );
        const res = stmt.run();
        const n = Number(res.changes || 0);
        totalUpdated += n;
        if (n > 0) console.log(`  ✓ ${table}.${col}: ${n} 行`);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // 并发加固：开启 WAL（持久写入库头，读写不互相阻塞）。
  try {
    const mode = db.prepare('PRAGMA journal_mode=WAL').get();
    console.log(`  ⚙️  journal_mode → ${JSON.stringify(mode)}`);
  } catch {
    /* 非致命 */
  }
  db.close();

  console.log(`\n✅ 规整完成，共更新 ${totalUpdated} 个时间戳。目标库: ${target}`);
}

main();
