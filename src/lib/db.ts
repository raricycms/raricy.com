import { PrismaClient } from '@prisma/client';
import { withArchiveScope } from './archive-scope';

// Next.js 开发模式热重载会反复 new PrismaClient，导致连接泄漏。
// 用全局单例避免（生产构建只实例化一次）。
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// 本次模块求值是否**新建**了 client。连接级初始化（PRAGMA）只对新建的那一个做一次。
//
// 不能像以前那样「先写 global、再读 global」来判断：dev/test 下上一行已经把 global
// 赋成刚创建的实例，条件恒假 → busy_timeout 在 dev/test 从来没生效过（只有 production
// 因为不写 global 才碰巧跑了一次）。这里用局部布尔，语义与注释「仅初始化一次」一致。
const createdClient = !globalForPrisma.prisma;

export const prisma =
  globalForPrisma.prisma ??
  withArchiveScope(new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  }));

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// SQLite 并发加固：WAL 让读不阻塞写、写不阻塞读；busy_timeout 避免高峰期
// 瞬时锁直接抛 "database is locked"。WAL 是持久设置(写进库头)，busy_timeout 逐连接。
// 只在本进程新建 client 时跑一次（dev 热重载复用全局单例，不会重复发）。真正的高并发
// 写扩展仍建议迁 Postgres(见迁移文档)。
if (createdClient) {
  // 用 queryRaw（PRAGMA 会返回结果行，executeRaw 会因 "results not allowed" 报错）
  void prisma
    .$queryRawUnsafe('PRAGMA journal_mode=WAL')
    .then(() => prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000'))
    .catch(() => {
      /* 非致命：pragma 失败不应阻断启动 */
    });
}
