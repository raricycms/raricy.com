// counters.ts — 讨论未读计数：两个 raw SQL 查询的唯一出口
//
// 每个频道的读游标不同，Prisma 的 where 表达不了「逐行比较」，只能落到 SQL。
//   • countUnreadByChannel：成员行读游标 × 消息 → 各频道未读条数
//   • countLobbyMentionsSince：大区读游标之后「@ 到我」的条数
// 已软删消息（is_deleted = 0 或历史 NULL）与已注销作者一律不计；is_deleted 在库里
// 是 INTEGER 0/1，两个值都要挡。
// @ 判定必须与前端/通知同一份规则：SQL 的 LIKE 只做预筛（超集），精确判定交回
// extractMentions —— 不建 mention 表，落表等于多一份真相。
// 仅供 chat/channels.ts 与 chat/unread.ts 使用，不从 barrel 导出。

import { prisma } from '../db';
import { extractMentions } from '../mention-shared';
import { CHAT_LOBBY_ID } from '../chat-shared';
import { Prisma } from '@prisma/client';

/**
 * 各频道未读数（消息 id > 该频道读游标且未软删）。
 *
 * 每个频道的读游标不同，Prisma 的 where 表达不了「逐行比较」，只能落到 SQL：
 * chat_members × chat_messages 按各自游标过滤后按频道 group by。
 * （is_deleted 在库里是 INTEGER 0/1，且历史行可能为 NULL，两个都要挡。）
 * 返回 Map：channelId → 条数（无未读的频道不出现在结果里）。
 */
export async function countUnreadByChannel(
  userId: string,
  channelIds: string[]
): Promise<Map<string, number>> {
  if (!channelIds.length) return new Map();
  const rows = await prisma.$queryRaw<{ channelId: string; unread: number | bigint }[]>`
    SELECT m.channel_id AS channelId, COUNT(msg.id) AS unread
    FROM chat_members m
    LEFT JOIN chat_messages msg
      ON msg.channel_id = m.channel_id
     AND msg.id > m.last_read_message_id
     AND (msg.is_deleted = 0 OR msg.is_deleted IS NULL)
     AND EXISTS (SELECT 1 FROM users author WHERE author.id = msg.author_id AND author.archived_at IS NULL)
    WHERE m.user_id = ${userId}
      AND m.channel_id IN (${Prisma.join(channelIds)})
    GROUP BY m.channel_id
  `;
  return new Map(rows.map((r) => [r.channelId, Number(r.unread)]));
}

/**
 * 大区里「游标之后 @ 到我」的消息条数。
 *
 * 判定必须与前端 @ 高亮同一份规则 —— 所以**不建 mention 表**：落表等于多一份真相，
 * 还要迁移和回填。SQL 的 LIKE 只做预筛（超集：大小写不敏感、用户名里的 _ 是通配符），
 * 精确判定交回 extractMentions；预筛把取回行数从「全部未读」压到「字面含 @我」。
 */
export async function countLobbyMentionsSince(userId: string, cursor: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ content: string; username: string }[]>`
    SELECT msg.content AS content, u.username AS username
    FROM chat_messages msg
    JOIN users u ON u.id = ${userId}
    WHERE msg.channel_id = ${CHAT_LOBBY_ID}
      AND msg.id > ${cursor}
      AND (msg.is_deleted = 0 OR msg.is_deleted IS NULL)
      AND EXISTS (SELECT 1 FROM users author WHERE author.id = msg.author_id AND author.archived_at IS NULL)
      AND msg.author_id <> ${userId}
      AND msg.content LIKE '%@' || u.username || '%'
  `;
  return rows.filter((r) => extractMentions(r.content).includes(r.username)).length;
}
