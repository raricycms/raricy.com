// ─────────────────────────────────────────────────────────────────────────────
// migrate-entry.test.ts —— `npm run migrate -- up` 的真实隔离 SQLite 验收
//
// 覆盖的是**入口行为**，不是 Reactive 迁移算法本身（后者已有
// reactive-v07-migration / reactive-backfill 用例）：
//   · 空库首次 up：结构 + 数据阶段一次完成；
//   · 结构已完成（无 pending SQL）时仍补做旧语法升级 / 快照回填 / 索引重建；
//   · 重复 up 幂等，不重写正文 / 不重复写快照 / 无变化不重建索引；
//   · v07 blocker 在写入前拦截；回填 blocked 时非零退出且跳过索引重建；
//   · status / verify 只读（空库连跟踪表都不建）；
//   · 相对 DATABASE_URL / 缺省 .env / Windows 路径带空格时仍只碰目标库，不碰诱饵库。
//
// 所有库都建在 os.tmpdir() 下带空格的独立目录里；不读 instance/ 或 .env 的真库。
// ─────────────────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const ROOT = path.resolve(import.meta.dirname, '../..');
const MIGRATE = path.join(ROOT, 'scripts', 'migrate.mjs');
const PRISMA_DIR = path.join(ROOT, 'prisma');
const MIGRATION_COUNT = fs
  .readdirSync(path.join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'prisma', 'migrations', entry.name, 'migration.sql')))
  .length;

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'raricy migrate entry '));
const BASE_DB = path.join(SANDBOX, 'base.db');

const BASE_ENV = { ...process.env };
delete BASE_ENV.DATABASE_URL;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function run(args: string[], options: { url?: string; cwd?: string; timeout?: number } = {}): RunResult {
  const env = { ...BASE_ENV };
  if (options.url !== undefined) env.DATABASE_URL = options.url;
  const result = spawnSync(process.execPath, [MIGRATE, ...args], {
    cwd: options.cwd ?? ROOT,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal,
    error: result.error,
  };
}

function output(result: RunResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function expectOk(result: RunResult, label: string): void {
  expect(result.error, `${label}: ${result.error?.message ?? ''}`).toBeUndefined();
  expect(result.status, `${label}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`).toBe(0);
}

function open(dbPath: string): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(dbPath);
}

/** 把 WAL 并回主文件，保证拷贝 / 哈希看到的是完整库。 */
function checkpoint(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  const db = open(dbPath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function copyDb(from: string, to: string): void {
  checkpoint(from);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(to + suffix, { force: true });
  fs.copyFileSync(from, to);
}

function exec(dbPath: string, sql: string): void {
  checkpoint(dbPath);
  const db = open(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function one<T>(dbPath: string, sql: string): T {
  checkpoint(dbPath);
  const db = open(dbPath);
  try {
    return db.prepare(sql).get() as T;
  } finally {
    db.close();
  }
}

function all<T>(dbPath: string, sql: string): T[] {
  checkpoint(dbPath);
  const db = open(dbPath);
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function fileHash(dbPath: string): string {
  checkpoint(dbPath);
  return createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
}

function resetReactiveMarker(dbPath: string): void {
  exec(dbPath, 'DELETE FROM reactive_source_migrations');
}

/**
 * 一个 public Markdown、一个旧版 Reactive 博客、一个旧版 Reactive 剪贴板。
 * 只写迁移前后的真实列，不复制业务服务逻辑。
 */
function seedContent(dbPath: string): void {
  exec(
    dbPath,
    `
    INSERT INTO users (id, username, email, password_hash, role, created_at)
      VALUES ('author', 'author', 'author@example.test', 'x', 'core', 1700000000000);
    INSERT INTO users (id, username, email, password_hash, role, created_at, archived_at)
      VALUES ('archived-author', 'archived-author', 'archived@example.test', 'x', 'core', 1700000000000, 1700000000001);

    INSERT INTO blogs (id, title, description, author_id, created_at, ignore, visibility)
      VALUES
        ('blog-md', '公开标题', '', 'author', 1700000000000, 0, 'public'),
        ('blog-old', '旧博客', '', 'author', 1700000000000, 0, 'public'),
        ('blog-archived', '归档作者的公开文章', '', 'archived-author', 1700000000000, 0, 'public');

    INSERT INTO blog_contents (blog_id, content, updated_at, format, syntax_version)
      VALUES
        ('blog-md', '# 公开标题

公开索引标记词', 1700000000000, 'markdown', NULL),
        ('blog-old', '<!-- reactive-md: local-draft-2 -->

旧正文标记词', 1700000000000, 'reactive', 'local-draft-2'),
        ('blog-archived', '# 归档文章

不应进入公开索引', 1700000000000, 'markdown', NULL);

    INSERT INTO clipboards (id, title, author_id, created_at, ignore, publicity)
      VALUES ('clip-old', '旧剪贴板', 'author', 1700000000000, 0, 1);
    INSERT INTO clip_text (clip_id, content, updated_at, format, syntax_version)
      VALUES ('clip-old', '<!-- reactive-md: local-draft-2 -->

旧剪贴板标记词', 1700000000000, 'reactive', 'local-draft-2');
    `
  );
}

beforeAll(() => {
  const first = run(['up'], { url: `file:${BASE_DB}` });
  expectOk(first, '空库首次 up');
  checkpoint(BASE_DB);
}, 300_000);

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe('migrate up 入口', () => {
  it('空库首次部署：SQL 结构 + Reactive 数据阶段一次完成', { timeout: 120_000 }, () => {
    const applied = one<{ n: number }>(BASE_DB, 'SELECT COUNT(*) AS n FROM _raricy_migrations');
    expect(Number(applied.n)).toBe(MIGRATION_COUNT);
    expect(Number(one<{ n: number }>(BASE_DB, 'SELECT COUNT(*) AS n FROM reactive_source_migrations').n)).toBe(1);
    expect(
      all<{ name: string }>(
        BASE_DB,
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('reactive_snapshots','public_blog_search','public_blog_search_state') ORDER BY name"
      ).map((row) => row.name)
    ).toEqual(['public_blog_search', 'public_blog_search_state', 'reactive_snapshots']);
  });

  it('无 pending SQL 时仍升级旧正文、回填 Markdown 快照并重建公开索引', { timeout: 180_000 }, () => {
    const db = path.join(SANDBOX, 'content data.db');
    copyDb(BASE_DB, db);
    resetReactiveMarker(db);
    seedContent(db);

    const result = run(['up'], { url: `file:${db}` });
    expectOk(result, '结构已完成仍执行数据阶段');
    expect(output(result)).toContain('SQL 阶段：没有 pending 迁移');

    const old = one<{ content: string; syntax_version: string }>(
      db,
      "SELECT content, syntax_version FROM blog_contents WHERE blog_id='blog-old'"
    );
    expect(old.syntax_version).toBe('local-draft-3');
    expect(old.content).toContain('local-draft-3');
    expect(old.content).toContain('旧正文标记词');
    expect(
      one<{ syntax_version: string }>(db, "SELECT syntax_version FROM clip_text WHERE clip_id='clip-old'").syntax_version
    ).toBe('local-draft-3');

    const snapshots = all<{ kind: string; content_id: string; format: string }>(
      db,
      "SELECT kind, content_id, format FROM reactive_snapshots ORDER BY kind, content_id"
    );
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'blog', content_id: 'blog-md', format: 'markdown' }),
        expect.objectContaining({ kind: 'blog', content_id: 'blog-old', format: 'reactive' }),
        expect.objectContaining({ kind: 'clipboard', content_id: 'clip-old', format: 'reactive' }),
      ])
    );
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reactive_source_migrations').n)).toBe(1);
    // 归档作者的内容不在回填 / 公开索引的作用域内；覆盖检查也必须排除它，
    // 否则每次 up 都会把「归档文章缺 state」误判成缺口并全量重建。
    expect(snapshots.some((row) => row.content_id === 'blog-archived')).toBe(false);

    const state = all<{ blog_id: string; version: string; body_status: string }>(
      db,
      'SELECT blog_id, version, body_status FROM public_blog_search_state ORDER BY blog_id'
    );
    expect(state.map((row) => row.blog_id)).toEqual(['blog-md', 'blog-old']);
    expect(state.every((row) => row.version === 'public-body/2' && row.body_status === 'ready')).toBe(true);
    expect(
      one<{ body: string }>(db, "SELECT body FROM public_blog_search WHERE blog_id='blog-old'").body
    ).toContain('旧正文标记词');
    expect(
      one<{ body: string }>(db, "SELECT body FROM public_blog_search WHERE blog_id='blog-md'").body
    ).toContain('公开索引标记词');

    // 第二次 up：正文 / 快照 / 标记都不重写，索引无变化时跳过重建。
    const beforeHash = fileHash(db);
    const beforeContent = one<{ content: string; syntax_version: string }>(
      db,
      "SELECT content, syntax_version FROM blog_contents WHERE blog_id='blog-old'"
    );
    const beforeSnapshots = Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reactive_snapshots').n);

    const again = run(['up'], { url: `file:${db}` });
    expectOk(again, '重复 up');
    const againOutput = output(again);
    expect(againOutput).toContain('旧语法升级：已完成（跳过）');
    expect(againOutput).toMatch(/快照回填：scanned=\d+ skipped=\d+ refreshed=0 written=0 blocked=0 failed=0/);
    expect(againOutput).toContain('公开索引：已是最新（跳过）');
    expect(
      one<{ content: string; syntax_version: string }>(
        db,
        "SELECT content, syntax_version FROM blog_contents WHERE blog_id='blog-old'"
      )
    ).toEqual(beforeContent);
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reactive_snapshots').n)).toBe(beforeSnapshots);
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reactive_source_migrations').n)).toBe(1);
    expect(fileHash(db)).toBe(beforeHash);
  });

  it('v07 blocker 在写入前拦截；修复后重跑接续', { timeout: 180_000 }, () => {
    const db = path.join(SANDBOX, 'blocked v07.db');
    copyDb(BASE_DB, db);
    resetReactiveMarker(db);
    seedContent(db);
    exec(
      db,
      `UPDATE clip_text SET content='<external name="foo" type="number">', syntax_version='local-draft-2'
       WHERE clip_id='clip-old'`
    );

    const blocked = run(['up'], { url: `file:${db}` });
    expect(blocked.status).not.toBe(0);
    expect(output(blocked)).toContain('旧语法升级被阻塞，未写入任何正文');
    expect(output(blocked)).toContain('local.upgrade.tag');
    expect(
      one<{ syntax_version: string }>(db, "SELECT syntax_version FROM blog_contents WHERE blog_id='blog-old'").syntax_version
    ).toBe('local-draft-2');
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reactive_source_migrations').n)).toBe(0);
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reactive_snapshots').n)).toBe(0);
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM public_blog_search_state').n)).toBe(0);

    exec(
      db,
      `UPDATE clip_text SET content='<!-- reactive-md: local-draft-3 -->

修好了', syntax_version='local-draft-3' WHERE clip_id='clip-old'`
    );
    const resumed = run(['up'], { url: `file:${db}` });
    expectOk(resumed, '修复 blocker 后重跑');
    expect(
      one<{ syntax_version: string }>(db, "SELECT syntax_version FROM blog_contents WHERE blog_id='blog-old'").syntax_version
    ).toBe('local-draft-3');
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reactive_source_migrations').n)).toBe(1);
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM public_blog_search_state').n)).toBe(2);
  });

  it('回填 blocked 时非零退出、不重建索引；修复后重跑完成', { timeout: 180_000 }, () => {
    const db = path.join(SANDBOX, 'blocked backfill.db');
    copyDb(BASE_DB, db);
    // 这里刻意不放旧 Reactive 正文（base 已有一次性标记）：先让 v07 顺利跳过，
    // 才能单独验证回填失败会挡住索引阶段。
    exec(
      db,
      `INSERT INTO users (id, username, email, password_hash, role, created_at)
         VALUES ('author', 'author', 'author@example.test', 'x', 'core', 1700000000000);
       INSERT INTO blogs (id, title, description, author_id, created_at, ignore, visibility)
         VALUES
           ('blog-md', '公开标题', '', 'author', 1700000000000, 0, 'public'),
           ('blog-bad', '坏格式', '', 'author', 1700000000000, 0, 'internal');
       INSERT INTO blog_contents (blog_id, content, updated_at, format, syntax_version)
         VALUES
           ('blog-md', '# 公开标题

公开索引标记词', 1700000000000, 'markdown', NULL),
           ('blog-bad', '无法识别的格式', 1700000000000, 'binary', NULL)`
    );

    const blocked = run(['up'], { url: `file:${db}` });
    expect(blocked.status).not.toBe(0);
    expect(output(blocked)).toContain('快照回填存在阻塞');
    expect(output(blocked)).toContain('invalid_content_format');
    // 公开索引阶段没有执行：公开 Markdown 仍无 state。
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM public_blog_search_state').n)).toBe(0);

    exec(db, "UPDATE blog_contents SET format='markdown' WHERE blog_id='blog-bad'");
    const resumed = run(['up'], { url: `file:${db}` });
    expectOk(resumed, '修复回填 blocker 后重跑');
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM public_blog_search_state').n)).toBe(1);
    expect(
      Number(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM reactive_snapshots WHERE content_id='blog-bad'").n)
    ).toBe(1);
  });

  it('status / verify 只读；空库连跟踪表都不创建', { timeout: 120_000 }, () => {
    const db = path.join(SANDBOX, 'readonly status.db');
    copyDb(BASE_DB, db);
    const beforeHash = fileHash(db);
    const beforeRows = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM _raricy_migrations');

    const status = run(['status'], { url: `file:${db}` });
    expectOk(status, 'status');
    expect(output(status)).toContain('Pending:');
    const verify = run(['verify'], { url: `file:${db}` });
    expectOk(verify, 'verify');
    expect(output(verify)).toContain('所有已应用迁移 checksum 一致');

    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM _raricy_migrations')).toEqual(beforeRows);
    expect(fileHash(db)).toBe(beforeHash);

    const empty = path.join(SANDBOX, 'empty readonly.db');
    const handle = open(empty);
    handle.close();
    const emptyStatus = run(['status'], { url: `file:${empty}` });
    expectOk(emptyStatus, '空库 status');
    expect(output(emptyStatus)).toContain('尚不存在');
    // 没有跟踪表 ≠ checksum 一致：verify 必须非零，且不能把空库说成绿色。
    const emptyVerify = run(['verify'], { url: `file:${empty}` });
    expect(emptyVerify.status).toBe(2);
    expect(output(emptyVerify)).toContain('从未通过本迁移系统应用过迁移');
    expect(output(emptyVerify)).not.toContain('所有已应用迁移 checksum 一致');
    expect(
      all<{ name: string }>(empty, "SELECT name FROM sqlite_master WHERE type='table' AND name='_raricy_migrations'")
    ).toEqual([]);
  });

  it('索引覆盖完整但编译签名变化时仍重建（不静默跳过）', { timeout: 180_000 }, () => {
    const db = path.join(SANDBOX, 'stale signature.db');
    copyDb(BASE_DB, db);
    resetReactiveMarker(db);
    seedContent(db);
    expectOk(run(['up'], { url: `file:${db}` }), '首次生成索引');
    expect(
      one<{ body: string }>(db, "SELECT body FROM public_blog_search WHERE blog_id='blog-md'").body
    ).toContain('公开索引标记词');

    // 模拟：索引 state / FTS 行都齐全，但快照是旧编译签名。回填会 refreshed，
    // 即使覆盖检查说「没问题」，也必须重建索引，不能把旧编译产物当成最新。
    exec(
      db,
      `UPDATE reactive_snapshots SET compiler_version='reactive-md/old'
         WHERE kind='blog' AND content_id='blog-md';
       UPDATE public_blog_search SET body='STALE INDEX BODY' WHERE blog_id='blog-md'`
    );

    const result = run(['up'], { url: `file:${db}` });
    expectOk(result, '编译签名变化后重跑 up');
    expect(output(result)).toContain('快照编译签名已变化');
    expect(
      one<{ body: string }>(db, "SELECT body FROM public_blog_search WHERE blog_id='blog-md'").body
    ).toContain('公开索引标记词');
    expect(
      one<{ body: string }>(db, "SELECT body FROM public_blog_search WHERE blog_id='blog-md'").body
    ).not.toContain('STALE INDEX BODY');
  });

  it('缺省 DATABASE_URL 从 cwd .env 读取；相对路径与空格只落到目标库', { timeout: 180_000 }, () => {
    const db = path.join(SANDBOX, 'env target with space.db');
    copyDb(BASE_DB, db);
    const decoy = path.join(SANDBOX, 'decoy.db');
    const decoyHandle = open(decoy);
    decoyHandle.exec('CREATE TABLE decoy_marker (value TEXT); INSERT INTO decoy_marker VALUES (\'untouched\')');
    decoyHandle.close();
    const decoyHash = fileHash(decoy);

    // 相对路径的基点是 prisma/（Prisma 自己的规则），故意包含空格。
    const relative = path.relative(PRISMA_DIR, db);
    const cwd = path.join(SANDBOX, 'env cwd');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, '.env'), `DATABASE_URL="file:${relative}"\nSECRET_KEY="synthetic-only"\n`, 'utf8');

    // 不传 DATABASE_URL：入口应读 cwd/.env，并把同一个绝对地址交给数据子进程。
    const result = run(['up'], { cwd });
    expectOk(result, '缺省 DATABASE_URL + 相对路径');
    expect(output(result)).toContain('数据阶段完成');
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM _raricy_migrations').n)).toBe(MIGRATION_COUNT);
    expect(Number(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reactive_source_migrations').n)).toBe(1);
    expect(all<{ value: string }>(decoy, 'SELECT value FROM decoy_marker')).toEqual([{ value: 'untouched' }]);
    expect(fileHash(decoy)).toBe(decoyHash);
  });
});
