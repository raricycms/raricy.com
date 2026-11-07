// ─────────────────────────────────────────────────────────────────────────────
// admin-log-extra.ts —— `admin_action_logs.extra` 的唯一读写入口
//
// 【为什么需要绕行 raw SQL】该列在 SQLite 里的声明类型是 JSON；Prisma 的 SQLite
// 连接器在驱动层拒绝读写它（`Value JSON not supported`），即使 schema 里映射成 String
// 也一样。所以写要参数化 `UPDATE ... SET extra = ?`，读要 `CAST(extra AS TEXT)`。
//
// 【为什么单独一个文件】这段绕行此前在四处各抄一份（写：logAdminActionTx +
// user-archive-service 的旧副本；读：listPublicLogs + listAdminLogs）。SQL 文本、
// 列名、参数顺序任何一处改动都不会带动其余几处 —— 出错方式是运行期而不是编译期。
// 现在写只有 `writeLogExtra`、读只有 `readLogExtra`，四（三）个调用点共用。
//
// 【签名为什么收 `PrismaClient | Prisma.TransactionClient`】归档/恢复必须在业务事务内
// 写日志（`user-archive-service`），网页/CLI 的普通写走全局 client；两个对象上这两个
// raw 方法同名同签名，所以同一个函数可以同时吃。
//
// 【JSON 形状不变】写入仍是 `JSON.stringify(metadata)`、读出仍是原文字符串；
// 调用方自己 JSON.parse（各页面已有的处理不动）。
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, type PrismaClient } from '@prisma/client';

export type AdminLogDb = PrismaClient | Prisma.TransactionClient;

/**
 * 写一条日志的 `extra` 列（metadata 为空时**一条 SQL 都不发**）。
 *
 * 空 metadata 不写：`extra='{}'` 与 NULL 对读侧等价，白跑一条 UPDATE 没有意义
 * （历史实现里 unarchive 每次都会多发这一条，已去掉）。
 */
export async function writeLogExtra(
  db: AdminLogDb,
  logId: number,
  metadata: Record<string, unknown> | null | undefined
): Promise<void> {
  if (!metadata || Object.keys(metadata).length === 0) return;
  // 参数化：? 占位符由驱动绑定，不存在注入
  await db.$executeRawUnsafe(
    'UPDATE admin_action_logs SET extra = ? WHERE id = ?',
    JSON.stringify(metadata),
    logId
  );
}

/**
 * 批量取 `extra` 原文（`CAST(extra AS TEXT)`，绕过 JSON 列的驱动层转换问题）。
 * 返回 logId → 原文（没有该列值 / 空数组时返回空 Map）。
 */
export async function readLogExtra(
  db: AdminLogDb,
  logIds: number[]
): Promise<Map<number, string | null>> {
  const extraMap = new Map<number, string | null>();
  if (logIds.length === 0) return extraMap;
  const extraRows = await db.$queryRaw<Array<{ id: number; extra: string | null }>>(Prisma.sql`
    SELECT id, CAST(extra AS TEXT) AS extra FROM admin_action_logs WHERE id IN (${Prisma.join(logIds)})
  `);
  for (const er of extraRows) extraMap.set(Number(er.id), er.extra);
  return extraMap;
}
