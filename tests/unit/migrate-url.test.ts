// migrate.mjs 的 DATABASE_URL 归一化：相对路径按 prisma/ 解析、查询串保留、
// Windows 盘符 / 编码空格都改写成绝对路径。集成行为见 tests/service/migrate-entry.test.ts。

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule, resolveDatabaseUrl } from '../../scripts/migrate.mjs';

const PRISMA_DIR = path.resolve('C:/repo/prisma');
const MIGRATE_SCRIPT = path.resolve(import.meta.dirname, '../../scripts/migrate.mjs');

describe('resolveDatabaseUrl', () => {
  it('相对 SQLite 路径按 schema.prisma 目录解析，并保留查询串', () => {
    const resolved = resolveDatabaseUrl('file:../instance/database/dev.db?connection_limit=1', PRISMA_DIR);
    expect(resolved).toBe(`file:${path.resolve(PRISMA_DIR, '../instance/database/dev.db')}?connection_limit=1`);
  });

  it('绝对盘符路径与编码空格归一化为同一绝对地址', () => {
    const withSpace = resolveDatabaseUrl('file:C:/data%20dir/db.db', PRISMA_DIR);
    expect(withSpace).toBe(`file:${path.resolve('C:/data dir/db.db')}`);
    const slashDrive = resolveDatabaseUrl('file:/C:/data dir/db.db', PRISMA_DIR);
    expect(slashDrive).toBe(`file:${path.resolve('C:/data dir/db.db')}`);
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
