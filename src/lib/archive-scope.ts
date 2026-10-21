import type { PrismaClient } from '@prisma/client';
import { isBackendOps } from './audit-context';

/**
 * 账号归档的默认查询边界。网页端连管理页也不能绕过；CLI 的异步上下文才可查看。
 * 统一作用于列表、单条、计数和修改，避免分页/搜索/API 的结果集各漏一处。
 *
 * Prisma 的 query 扩展不处理嵌套 relation 或 raw SQL：评论/讨论的作者在各自序列化
 * 出口抹掉，管理端评论与 raw 审计查询另有显式谓词。新增 raw/嵌套读口须沿用此纪律。
 * 评论/讨论保留占位节点及回复结构；只有显式查未删除的集合才过滤归档作者。
 */
export function withArchiveScope(client: PrismaClient): PrismaClient {
  const active = { archivedAt: null };
  const author = { author: active };
  const user = { user: active };
  const reads = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
  const writes = new Set(['update', 'updateMany', 'delete', 'deleteMany']);
  return client.$extends({
    name: 'account-archive-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (isBackendOps() || (!reads.has(operation) && !writes.has(operation))) return query(args);
          const input = args as { where?: Record<string, unknown> };
          let scope: Record<string, unknown> | undefined;
          switch (model) {
            case 'User': scope = active; break;
            case 'DailyQuote': scope = { OR: [{ kind: 'builtin' }, { submitter: active }] }; break;
            case 'DailyQuoteFavorite': case 'DailyQuoteResonance': scope = user; break;
            case 'Blog': case 'ImageHosting': case 'AudioHosting': case 'ClipBoard': case 'Vote': scope = author; break;
            case 'BlogContent': scope = { blog: author }; break;
            case 'Favorite': case 'FishApiToken': case 'FishWebhookEndpoint': case 'FishWebhookDelivery':
            case 'OAuthAccessToken': case 'OAuthAuthorizationCode': case 'UserBan': scope = user; break;
            case 'OAuthApplication': scope = { createdBy: active }; break;
            case 'FavoriteItem': scope = { favorite: user, blog: author }; break;
            case 'BlogLike': case 'BlogFeed': scope = { ...user, blog: author }; break;
            case 'CommentLike': scope = user; break;
            case 'BlogComment':
              scope = { blog: author, ...(input.where?.isDeleted === false || writes.has(operation) || operation.startsWith('findUnique') ? author : {}) }; break;
            case 'ChatMessage':
              if (input.where?.isDeleted === false || writes.has(operation)) scope = author;
              break;
            case 'Notification': scope = { hiddenAt: null, recipient: active, OR: [{ actorId: null }, { actor: active }] }; break;
            case 'AdminActionLog': scope = { action: { notIn: ['archive_user', 'unarchive_user'] }, admin: active, OR: [{ targetUserId: null }, { targetUser: active }] }; break;
            case 'AdminActionAppeal': scope = { appellant: active }; break;
          }
          // 唯一查询保留顶层 id/username 等唯一键；附加 AND 不覆盖调用方的筛选。
          if (scope) {
            const previous = input.where?.AND;
            input.where = { ...input.where, AND: [...(Array.isArray(previous) ? previous : previous ? [previous] : []), scope] };
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
