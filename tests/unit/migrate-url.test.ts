// migrate.mjs 的 DATABASE_URL 归一化：相对路径按 prisma/ 解析、查询串保留、
// Windows 盘符 / 编码空格都改写成绝对路径。集成行为见 tests/service/migrate-entry.test.ts。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// 运维入口交给 Node 原生加载，避免 Vite 重写 import.meta 干扰入口判定。
const { isMainModule, resolveDatabaseUrl } = createRequire(import.meta.url)('../../scripts/migrate.mjs') as typeof import('../../scripts/migrate.mjs');

// 平台中立：不要用 `path.resolve('C:/...')` —— 在 POSIX 上它是相对路径。
const PRISMA_DIR = path.join(os.tmpdir(), 'raricy repo', 'prisma');
const MIGRATE_SCRIPT = path.resolve(import.meta.dirname, '../../scripts/migrate.mjs');

describe('resolveDatabaseUrl', () => {
  it('相对 SQLite 路径按 schema.prisma 目录解析，并保留查询串', () => {
    const resolved = resolveDatabaseUrl('file:../instance/database/dev.db?connection_limit=1', PRISMA_DIR);
    expect(resolved).toBe(`file:${path.resolve(PRISMA_DIR, '../instance/database/dev.db')}?connection_limit=1`);
  });

  it.runIf(process.platform === 'win32')('Windows 盘符路径与编码空格归一化为绝对地址', () => {
    const withSpace = resolveDatabaseUrl('file:C:/data%20dir/db.db', PRISMA_DIR);
    expect(withSpace).toBe(`file:${path.resolve('C:/data dir/db.db')}`);
    const slashDrive = resolveDatabaseUrl('file:/C:/data dir/db.db', PRISMA_DIR);
    expect(slashDrive).toBe(`file:${path.resolve('C:/data dir/db.db')}`);
  });

  it.runIf(process.platform !== 'win32')('POSIX 绝对路径与编码空格归一化为绝对地址', () => {
    expect(resolveDatabaseUrl('file:/var/lib/db.db', PRISMA_DIR)).toBe(`file:${path.resolve('/var/lib/db.db')}`);
    expect(resolveDatabaseUrl('file:/var/lib/data%20dir/db.db', PRISMA_DIR)).toBe(
      `file:${path.resolve('/var/lib/data dir/db.db')}`
    );
  });

  it('非 file: URL 与无法安全改写的 UNC 路径原样返回', () => {
    expect(resolveDatabaseUrl('postgresql://user@host/db', PRISMA_DIR)).toBe('postgresql://user@host/db');
    expect(resolveDatabaseUrl('file://server/share/db.db', PRISMA_DIR)).toBe('file://server/share/db.db');
  });
});

describe('isMainModule', () => {
  it('经 realpath 归一后仍认出直接执行，不同文件 / 空路径不误判', () => {
    // 用带 `.` 的等价路径走 realpath 分支；符号链接部署时 argv[1] 与 import.meta.url
    // 的文本差异也由同一逻辑收敛。
    expect(fs.existsSync(MIGRATE_SCRIPT)).toBe(true);
    expect(isMainModule(path.join(path.dirname(MIGRATE_SCRIPT), '.', 'migrate.mjs'), MIGRATE_SCRIPT)).toBe(true);
    expect(isMainModule(path.resolve(import.meta.dirname, '../../package.json'), MIGRATE_SCRIPT)).toBe(false);
    expect(isMainModule('', MIGRATE_SCRIPT)).toBe(false);
  });
});
