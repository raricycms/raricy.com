#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 部署自检：定位「登录 500 / 登录不上 / CSRF 403」的具体原因。
//
// 用法（在 web-next 目录下、与线上相同的环境变量里跑）：
//   node scripts/diagnose-deploy.mjs                     # 只查本地配置与数据库
//   node scripts/diagnose-deploy.mjs --url https://你的域名  # additionally 打线上活体检查
//
// 不会修改任何数据；只读检查 + 打印结论。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const urlArg = (() => {
  const i = args.indexOf('--url');
  return i >= 0 ? args[i + 1] : null;
})();

let fail = 0;
let warn = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m, fix) => {
  fail++;
  console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
  if (fix) console.log(`     \x1b[33m→ ${fix}\x1b[0m`);
};
const wrn = (m, fix) => {
  warn++;
  console.log(`  \x1b[33m! ${m}\x1b[0m`);
  if (fix) console.log(`     → ${fix}`);
};
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// 读 .env（不覆盖已存在的真实环境变量）
function loadEnvFile(f) {
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
for (const f of ['.env.production', '.env.local', '.env']) loadEnvFile(f);

console.log('\x1b[1m═══ web-next 部署自检 ═══\x1b[0m');

// ── 1. 必需环境变量 ─────────────────────────────────────────────────────────
head('1. 环境变量');
if (!process.env.SECRET_KEY) {
  bad('SECRET_KEY 未配置 → session.ts 会抛错 → 登录必 500', '在 .env.production 填 SECRET_KEY（照搬 Flask 生产值）');
} else {
  ok(`SECRET_KEY 已配置（长度 ${process.env.SECRET_KEY.length}）`);
}
if (!process.env.DATABASE_URL) {
  bad('DATABASE_URL 未配置', '形如 DATABASE_URL="file:/abs/path/db.db?connection_limit=1&socket_timeout=30"');
} else {
  ok(`DATABASE_URL = ${process.env.DATABASE_URL.replace(/(file:)[^?]*/, '$1<路径>')}`);
}
if (process.env.ALLOWED_ORIGINS) {
  ok(`ALLOWED_ORIGINS = ${process.env.ALLOWED_ORIGINS}（反代下最稳妥）`);
} else {
  wrn('ALLOWED_ORIGINS 未配置 —— 此时依赖 nginx 透传 X-Forwarded-Host/Host',
      'nginx 未透传就会 CSRF 403。稳妥做法：ALLOWED_ORIGINS="你的域名"');
}
for (const k of ['AVATARS_DIR', 'IMAGE_UPLOAD_FOLDER']) {
  const v = process.env[k];
  if (!v) wrn(`${k} 未配置（将回退到 ../instance/...）`, '指向真实数据目录');
  else if (!fs.existsSync(v)) bad(`${k}=${v} 目录不存在`, '挂载真实数据卷');
  else ok(`${k} = ${v}`);
}

// ── 2. 数据库文件 ───────────────────────────────────────────────────────────
head('2. 数据库文件');
let dbPath = null;
if (process.env.DATABASE_URL?.startsWith('file:')) {
  const raw = process.env.DATABASE_URL.slice(5).split('?')[0];
  dbPath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), 'prisma', raw);
  if (!fs.existsSync(dbPath)) {
    bad(`数据库文件不存在：${dbPath}`, '检查 DATABASE_URL 路径（相对路径是相对 prisma/ 目录）');
  } else {
    ok(`文件存在：${dbPath}`);
    try {
      fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
      ok('进程可读写该文件');
    } catch {
      bad('进程对数据库文件无读写权限', 'chown/chmod 给运行 Next 的用户');
    }
    try {
      fs.accessSync(path.dirname(dbPath), fs.constants.W_OK);
      ok('所在目录可写（WAL 需要写 -wal/-shm）');
    } catch {
      bad('数据库所在目录不可写 → WAL 模式会失败', '给目录写权限');
    }
  }
}

// ── 3. 时间戳格式（登录 500 头号元凶）────────────────────────────────────────
head('3. 时间戳格式（登录 500 头号元凶）');
if (dbPath && fs.existsSync(dbPath)) {
  let PrismaClient = null;
  try {
    ({ PrismaClient } = await import('@prisma/client'));
  } catch (e) {
    wrn(`无法加载 Prisma Client：${String(e).split('\n')[0]}`, '先跑 npm run prisma:generate');
  }

  if (PrismaClient) {
    const prisma = new PrismaClient({ log: [] });
    const NORMALIZE_HINT = `对该库跑：node scripts/normalize-datetimes.mjs --source <你的库> --dest <新库>（详见 docs/nextjs-migration/03-数据库映射与陷阱.md）`;

    // 3.1 看真实存储类型。目标是 INTEGER（Unix 毫秒）—— 与 Prisma 自身写入格式一致。
    //     TEXT 存储即使能被 Prisma 读出，日期比较也会按 SQLite 类型序（INTEGER < TEXT）
    //     而非数值进行：gte 恒真、lt 恒假 → 发文日限额把历史文章全算成「今天」。
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT typeof(created_at) AS ty, CAST(created_at AS TEXT) AS v, COUNT(*) AS n
         FROM users WHERE created_at IS NOT NULL GROUP BY typeof(created_at)`
      );
      if (!rows?.length) {
        wrn('users.created_at 全为空，无法判定格式');
      } else {
        for (const r of rows) {
          const ty = String(r.ty);
          const sample = String(r.v);
          const n = Number(r.n);
          if (ty === 'integer') {
            ok(`时间戳存储为 INTEGER 毫秒（${n} 行，样例 ${sample}）—— 正确`);
          } else if (sample.includes(' ') && !sample.includes('T')) {
            bad(
              `时间戳是 SQLAlchemy 空格格式（${n} 行，样例 "${sample}"）→ Prisma 解析即抛错 → 登录 500`,
              NORMALIZE_HINT
            );
          } else {
            bad(
              `时间戳是 TEXT 存储（${n} 行，样例 "${sample}"）→ Prisma 能读但**日期比较会错**：` +
                `SQLite 跨类型比较按类型序，gte 恒真 / lt 恒假 → 发文日限额会把历史文章全算成「今天」，` +
                `历史发文 ≥20 篇的用户将永久无法发文`,
              NORMALIZE_HINT + '（新版脚本会转成 INTEGER 毫秒）'
            );
          }
        }
        if (rows.length > 1) {
          bad('同一列混存多种类型 —— 日期比较结果不可预测', NORMALIZE_HINT);
        }
      }
    } catch (e) {
      wrn(`读取 users.created_at 失败：${String(e).split('\n')[0]}`, '确认 DATABASE_URL 指向的是本项目的库');
    }

    // 3.2 真刀真枪：让 Prisma 反序列化一整行 users —— 这正是登录写回 lastLogin 时会做的事
    try {
      await prisma.user.findFirst({});
      ok('Prisma 可正常反序列化完整 users 行（登录不会因此 500）');
    } catch (e) {
      const msg = String(e).replace(/\s+/g, ' ');
      if (/Conversion failed|invalid characters/i.test(msg)) {
        bad('Prisma 反序列化 users 行报「Conversion failed / invalid characters」→ 就是时间戳格式问题，登录必 500', NORMALIZE_HINT);
      } else {
        bad(`Prisma 读取完整 users 行失败：${msg.slice(0, 160)}`, '把这条错误发出来');
      }
    }
    await prisma.$disconnect();
  }
}

// ── 4. 线上活体检查 ─────────────────────────────────────────────────────────
if (urlArg) {
  head(`4. 线上活体检查（${urlArg}）`);
  const base = urlArg.replace(/\/$/, '');
  const isHttps = base.startsWith('https://');
  if (!isHttps) {
    bad('站点走的是 HTTP（非 HTTPS）→ 生产模式下会话 cookie 带 Secure 标记，浏览器会丢弃它',
        '表现正是「登录接口返回 200 但就是登不进去」。要么上 TLS（推荐），要么见下方说明改 cookie secure 策略');
  } else {
    ok('站点是 HTTPS（Secure cookie 可正常下发）');
  }
  const origin = new URL(base).origin;
  try {
    // 4.1 CSRF 是否放行
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username: '__diagnose_nobody__', password: 'x' }),
    });
    const text = await r.text();
    if (r.status === 403 && text.includes('CSRF')) {
      bad('CSRF 中间件仍在拦截正常请求（403）',
          '① 确认已部署最新代码（含 X-Forwarded-Host 修复）②配 ALLOWED_ORIGINS ③nginx 加 proxy_set_header X-Forwarded-Host $host');
    } else if (r.status === 500) {
      bad(`登录接口 500：${text.slice(0, 200)}`, '看服务端日志堆栈；多半是时间戳或 SECRET_KEY');
    } else if (r.status === 401) {
      ok('登录接口正常（401 = 已通过 CSRF，进到密码校验逻辑）');
    } else {
      wrn(`登录接口返回 ${r.status}：${text.slice(0, 160)}`);
    }
    // 4.2 Set-Cookie 属性
    const sc = r.headers.get('set-cookie');
    if (sc) console.log(`     Set-Cookie: ${sc.slice(0, 120)}`);
  } catch (e) {
    bad(`无法访问 ${base}：${String(e).split('\n')[0]}`, '检查站点是否在跑、防火墙、域名解析');
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1m═══ 结论 ═══\x1b[0m`);
if (fail === 0 && warn === 0) console.log('  \x1b[32m全部通过\x1b[0m');
else console.log(`  \x1b[31m${fail} 个致命问题\x1b[0m，\x1b[33m${warn} 个警告\x1b[0m（按上面的 → 提示处理）`);
console.log('  仍无法定位时，请把服务端日志堆栈发出来：pm2 logs / journalctl -u <service> / 前台 npm start\n');
process.exit(fail > 0 ? 1 : 0);
