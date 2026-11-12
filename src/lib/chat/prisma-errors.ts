// prisma-errors.ts — 讨论域内两类「预期内」的 Prisma 写失败判定
//
// isUniqueViolation（P2002）：并发「先查后建」输了 → 回读对方建的行，把竞争转成
//   幂等成功。大区成员行懒建依赖它：P2002 漏到 poll 路由会变成 500。
// isForeignKeyViolation（P2003）：目标用户/频道刚被删 → 映射成 notFound 业务错误。
// 仅供 chat/ 内部使用，不从 barrel 导出。

import { Prisma } from '@prisma/client';

function isForeignKeyViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Prisma.PrismaClientKnownRequestError).code === 'P2003'
  );
}

/** 唯一约束冲突（P2002）—— 并发「先查后建」时用来把竞争转成幂等成功。 */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Prisma.PrismaClientKnownRequestError).code === 'P2002'
  );
}

export { isForeignKeyViolation, isUniqueViolation };
