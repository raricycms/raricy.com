// @ 选人读路径：只返回当前评论区 / 会话里可被提及的用户，不暴露角色或成员状态。
import { prisma } from './db';
import { nowForDb } from './db-time';
import { canAccessChannel, CHAT_KIND_LOBBY } from './chat-service';
import type { Prisma } from '@prisma/client';
import type { MentionScope, MentionUser } from './mention-shared';

export async function suggestMentionUsers(
  scope: MentionScope,
  query: string,
  viewer: { id: string; lobbyBlocked: boolean },
): Promise<MentionUser[] | null> {
  const where: Prisma.UserWhereInput = {
    role: { in: ['core', 'admin', 'owner'] },
    id: { not: viewer.id },
    username: { startsWith: query },
  };
  if (scope.kind === 'comment') {
    // 评论对所有 core+ 可读；文章的对外档位不改变评论区的权限。
    const blog = await prisma.blog.findFirst({
      where: { id: scope.id, ignore: false }, select: { id: true },
    });
    if (!blog) return null;
  } else {
    const access = await canAccessChannel(scope.id, viewer.id, viewer.lobbyBlocked);
    if (!access.allowed) return null;
    // 与讨论提及通知同档：禁言者进不了讨论，大区对「屏蔽了大区」的账号不可见。
    where.OR = [
      { isBanned: false }, { isBanned: null }, { banUntil: { lt: nowForDb() } },
    ];
    where.chatMembers = access.kind === CHAT_KIND_LOBBY
      ? { none: { channelId: scope.id, mutedAt: { not: null } } }
      : { some: { channelId: scope.id, mutedAt: null } };
    // 大区候选人不含「专注模式屏蔽了大区」的账号（他们收不到大区 @ 通知，列出来
    // 会让发送者以为叫得动）。判据与 chat-service 共用 isFocusLobbyBlocked：
    // NOT (focusMode AND focusBlockLobby)。
    if (access.kind === CHAT_KIND_LOBBY) {
      where.NOT = { focusMode: true, focusBlockLobby: true };
    }
  }
  return prisma.user.findMany({
    where, select: { id: true, username: true }, orderBy: { username: 'asc' }, take: 8,
  });
}
