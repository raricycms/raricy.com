// chat-service.ts — 讨论域对外 API 聚合层（纯 barrel，实现在 src/lib/chat/）
//
// 仓内调用方只从本文件 import；导出名、签名、行为与拆分前逐一对应。**别在 barrel
// 加逻辑**：规则与实现属于 chat/ 下各模块（constants / prisma-errors / counters /
// unread / channels / messages），这里只做 re-export。
//
// chat-shared 的常量/类型也经这里再导出：客户端组件若 import 本文件会把 auth.ts →
// next/headers 打进浏览器包，故纯常量/类型住 chat-shared.ts；服务端照旧从本 barrel
// 取，别在别处重新定义一份。
//
// 依赖方向：chat-service → admin-user-service → user-service 单向链，后两者**不能
// import 本文件**（成环）。动红点的写路径只能：拒绝方向（禁言 / 降级到 user / 专注
// 模式勾选「屏蔽讨论大区」）推精确 `{chatUnread:false}`；放开方向推 `{refresh:true}`，
// 由客户端重拉 count 路由。

// 复用 chat-shared 的常量/类型（同时向后兼容旧导入路径）
export {
  CHAT_LOBBY_ID,
  CHAT_LOBBY_TITLE,
  CHAT_DELETED_TEXT,
  CHAT_FOCUS_BLOCKED_TITLE,
  CHAT_PREVIEW_MAX,
  CHAT_TEXT_MAX,
  CHAT_CAPTION_MAX,
  PAT_TARGET_FALLBACK,
  type ChatAuthorDTO,
  type ChatImageDTO,
  type ChatPatDTO,
  type ChatReplyDTO,
  type ChatMessageDTO,
  type ChatChannelDTO,
  type ChatUserLite,
} from './chat-shared';

export { CHAT_KIND_LOBBY, CHAT_KIND_DIRECT, CHAT_INITIAL_LIMIT } from './chat/constants';

export { extractMentions } from './mention-shared';

export {
  ensureLobbyChannel,
  ensureLobbyMembership,
  canAccessChannel,
  listChannelsForUser,
  toChannelDto,
  setChannelMuted,
  hideChannel,
  revealChannel,
  startDirectChannel,
  type ChannelPrefResult,
  type StartDirectResult,
} from './chat/channels';

export {
  getChatUnreadSummary,
  getChatDotFor,
  type ChatUnreadSummary,
} from './chat/unread';

export {
  searchChannelMessages,
  listMessages,
  listMessagesSince,
  sendMessage,
  CHAT_MENTION_ACTION,
  markChannelRead,
  softDeleteMessage,
  searchCoreUsers,
  type SearchMessagesResult,
  type ListMessagesParams,
  type ListMessagesResult,
  type SendMessageInput,
  type SendMessageResult,
  type DeleteActor,
  type DeleteMessageResult,
} from './chat/messages';
