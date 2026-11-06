// SQL-only 入口验收：空库应用结构；错误 / 旧版本正文不触发数据阶段；
// 重复 up、status、verify 不改正文，DATABASE_URL 正确隔离。
// 数据库使用 tests/helpers 的隔离临时目录，不读取业务库。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { TMP_DIR } from '../helpers/db-template';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const ROOT = path.resolve(import.meta.dirname, '../..');
const MIGRATE = path.join(ROOT, 'scripts', 'migrate.mjs');
const PRISMA_DIR = path.join(ROOT, 'prisma');
const MIGRATION_COUNT = fs
  .readdirSync(path.join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'prisma', 'migrations', entry.name, 'migration.sql')))
  .length;

// 与其它真实 SQLite 测试共用被忽略的测试目录，但每轮单独建子目录。
// 本机 Windows 上 schema-engine 可写工作区，系统 TEMP 则会返回 readonly database。
fs.mkdirSync(TMP_DIR, { recursive: true });
const SANDBOX = fs.mkdtempSync(path.join(TMP_DIR, 'migrate entry '));
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
    // 迁移数已到 43 个：每个迁移都要起一次 `prisma db execute` 子进程，空库全量 up 在
    // 高负载机器上会逼近原来的 180s（本地并行跑测试时实测超时）。给足余量，避免把
    // 「机器忙」误报成迁移缺陷。
    timeout: options.timeout ?? 300_000,
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

describe('migrate up 仅应用 SQL', () => {
  it('空库首跑只应用结构，不写 Reactive 标记；41/42 的索引与退役项已落地', () => {
    expect(one<{ n: number }>(BASE_DB, 'SELECT COUNT(*) AS n FROM _raricy_migrations').n).toBe(MIGRATION_COUNT);
    expect(one<{ n: number }>(BASE_DB, 'SELECT COUNT(*) AS n FROM reactive_source_migrations').n).toBe(0);
    // 42_retire_residual：快照表、账户 Key 列、profile 手机排序列都已删除。
    expect(one<{ n: number }>(BASE_DB, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='reactive_snapshots'").n).toBe(0);
    expect(one<{ n: number }>(BASE_DB, "SELECT COUNT(*) AS n FROM pragma_table_info('users') WHERE name='fish_api_key_encrypted'").n).toBe(0);
    expect(one<{ n: number }>(BASE_DB, "SELECT COUNT(*) AS n FROM pragma_table_info('profile_blocks') WHERE name='sort'").n).toBe(0);
    // 41_lookup_indexes：R3-015 的两条热点索引都在（空库建索引 → 物理名与 schema.map 一致）。
    expect(
      one<{ n: number }>(
        BASE_DB,
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('ix_notifications_recipient_read','ix_market_positions_open')"
      ).n
    ).toBe(2);
  });
  it('错误或旧版正文不阻塞 SQL up，正文、快照与索引均不改写', () => {
    const target = path.join(SANDBOX, 'content.db');
    copyDb(BASE_DB, target);
    seedContent(target);
    exec(target, "UPDATE clip_text SET content='<radio-group>', syntax_version='local-draft-3'");
    const before = fileHash(target);
    for (let i = 0; i < 2; i++) {
      const result = run(['up'], { url: `file:${target}` });
      expectOk(result, '含错误正文的重复 up');
      expect(output(result)).not.toContain('[reactive]');
    }
    expect(fileHash(target)).toBe(before);
    expect(one<{ n: number }>(target, 'SELECT COUNT(*) AS n FROM public_blog_search_state').n).toBe(0);
  });
  it('status / verify 只读；空库不创建跟踪表', () => {
    const target = path.join(SANDBOX, 'readonly.db');
    copyDb(BASE_DB, target);
    const before = fileHash(target);
    expectOk(run(['status'], { url: `file:${target}` }), 'status');
    expectOk(run(['verify'], { url: `file:${target}` }), 'verify');
    expect(fileHash(target)).toBe(before);
    const empty = path.join(SANDBOX, 'empty.db');
    open(empty).close();
    expectOk(run(['status'], { url: `file:${empty}` }), 'empty status');
    expect(run(['verify'], { url: `file:${empty}` }).status).not.toBe(0);
    expect(one<{ n: number }>(empty, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='_raricy_migrations'").n).toBe(0);
  });
  it('cwd .env 中含空格的相对地址只使用目标库，不碰诱饵库', () => {
    const cwd = path.join(SANDBOX, 'cwd space');
    fs.mkdirSync(cwd);
    const target = path.join(cwd, 'target space.db');
    const decoy = path.join(cwd, 'decoy.db');
    copyDb(BASE_DB, target); copyDb(BASE_DB, decoy);
    const relative = path.relative(PRISMA_DIR, target).replaceAll('\\', '/');
    fs.writeFileSync(path.join(cwd, '.env'), `DATABASE_URL="file:${relative}"\n`);
    const targetHash = fileHash(target), decoyHash = fileHash(decoy);
    expectOk(run(['up'], { cwd }), 'relative up');
    expect(fileHash(target)).toBe(targetHash);
    expect(fileHash(decoy)).toBe(decoyHash);
  });
});
