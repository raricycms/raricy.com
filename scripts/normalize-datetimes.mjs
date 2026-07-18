// ─────────────────────────────────────────────────────────────────────────────
// normalize-datetimes.mjs
//
// 把 SQLAlchemy 写入的 "YYYY-MM-DD HH:MM:SS.ffffff"（空格分隔、无时区）时间戳
// 规整为 INTEGER（Unix 毫秒）—— 与 Prisma 自身写入 SQLite 的存储格式一致。
// （曾经转成 ISO 文本，Prisma 能读但日期比较会按类型序而非数值 —— 详见下方 UPDATE 处的注释。）
//
// 为什么必须做：Prisma 的 SQLite 连接器按列的声明类型 DATETIME 在驱动层解析，
// 遇到空格分隔格式会直接报 "Conversion failed: input contains invalid characters"。
//
// 幂等：只转换 typeof='text' 的值（已是 integer 的跳过），重复运行安全。
// 既吃 Flask 原始的空格格式，也吃历史上被旧版脚本转成的 ISO 文本。
//
// 用法：
//   node scripts/normalize-datetimes.mjs --source ./instance/database/db.db --dest ./instance/database/dev.db
//        → 先把 source 复制成 dest，再对 dest 规整（推荐：不碰线上库）
//   node scripts/normalize-datetimes.mjs --in-place path/to/db.db
//        → 就地规整（正式硬切换时用；执行前务必备份，并确保没有写入进程持有库句柄）
//   npm run db:normalize
//        → 等价于把线上 SQLite 复制到 ./instance/database/dev.db 再规整（见 package.json）
//
// 注：路径默认是相对于**进程 cwd**（=项目根），不是 schema.prisma 目录。
//     Prisma 自己解析 DATABASE_URL 时则相对 schema.prisma 目录 —— 同名"相对路径"
//     在不同语境下基点不同，不要照搬给 Prisma 用。
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
    console.log(`⚠️  就地规整: ${target}（确认已备份 / 服务进程已停写）`);
  } else {
    const source = resolve(process.cwd(), args.source || './instance/database/db.db');
    target = resolve(process.cwd(), args.dest || './instance/database/dev.db');
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
        // 转成 INTEGER（Unix 毫秒）—— 与 Prisma 自己写入 SQLite 的存储格式一致。
        //
        // 【为什么不是 TEXT ISO】曾经这里转的是 'YYYY-MM-DDTHH:MM:SS.sssZ' 文本，
        // Prisma 能**读**，于是看起来没问题；但 Prisma 做 DateTime 比较时绑定的是
        // INTEGER 毫秒，而 SQLite 跨存储类型比较**按类型序**（INTEGER < TEXT），不按数值：
        //   · `gte` → 所有 TEXT 行恒真
        //   · `lt` / `lte` → 所有 TEXT 行恒假
        // 后果实测：countBlogsToday 会把用户历史上**全部**文章算成「今天发的」——
        // 任何历史发文 ≥20 篇的用户切换后永久发不了文（429 今日已达上限）。
        // 存成 INTEGER 后，读/写/比较/排序全部一致且正确（已实测）。
        //
        // 幂等：只转 TEXT 型的值（typeof = 'text'），已是 integer 的跳过。
        // 两种来源都要吃下：
        //   · Flask 原始格式 "2025-08-09 20:48:45.776483"（空格）
        //   · 历史上被本脚本转成的 "2025-08-09T20:48:45.776Z"（ISO 文本）
        // strftime('%s') 按 UTC 解析这两种格式，再补上毫秒部分。
        const stmt = db.prepare(
          `UPDATE "${table}" SET "${col}" = ` +
            `CAST(strftime('%s', "${col}") AS INTEGER) * 1000 + ` +
            `CAST(COALESCE(strftime('%f', "${col}"), '0') * 1000 AS INTEGER) % 1000 ` +
            `WHERE "${col}" IS NOT NULL AND typeof("${col}") = 'text' ` +
            `AND strftime('%s', "${col}") IS NOT NULL`
        );
        const res = stmt.run();
        const n = Number(res.changes || 0);
        totalUpdated += n;
        if (n > 0) console.log(`  ✓ ${table}.${col}: ${n} 行 → INTEGER 毫秒`);

        // 兜底告警：仍有 text 残留说明格式无法被 strftime 解析，需人工看
        const left = db
          .prepare(
            `SELECT COUNT(*) AS n FROM "${table}" WHERE "${col}" IS NOT NULL AND typeof("${col}") = 'text'`
          )
          .get();
        if (Number(left?.n || 0) > 0) {
          console.log(
            `  ⚠️  ${table}.${col}: 仍有 ${left.n} 行是 TEXT 且无法解析 —— 请人工检查（这些行的日期比较会出错）`
          );
        }
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
