import { PrismaClient } from '@prisma/client';

// Next.js 开发模式热重载会反复 new PrismaClient，导致连接泄漏。
// 用全局单例避免（生产构建只实例化一次）。
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// SQLite 并发加固：WAL 让读不阻塞写、写不阻塞读；busy_timeout 避免高峰期
// 瞬时锁直接抛 "database is locked"。WAL 是持久设置(写进库头)，busy_timeout 逐连接。
// 仅初始化一次(全局单例)。真正的高并发写扩展仍建议迁 Postgres(见迁移文档)。
if (!globalForPrisma.prisma || process.env.NODE_ENV === 'production') {
  // 用 queryRaw（PRAGMA 会返回结果行，executeRaw 会因 "results not allowed" 报错）
  void prisma
    .$queryRawUnsafe('PRAGMA journal_mode=WAL')
    .then(() => prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000'))
    .catch(() => {
      /* 非致命：pragma 失败不应阻断启动 */
    });
}
