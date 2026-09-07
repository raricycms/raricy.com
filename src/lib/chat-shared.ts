// ─────────────────────────────────────────────────────────────────────────────
// chat-shared.ts — 聊天区「纯常量 + DTO 类型」，供服务端与客户端共享。
//
// 【为什么要单独拆一个文件】ChatApp / NewChatModal 是客户端组件（'use client'），
// 而 chat-service.ts 依赖 auth.ts → next/headers（cookies）等 server-only 模块，
// 客户端若 import 它的**值**会把 next/headers 打进浏览器包 → 构建报错。
// 常量与类型是纯数据，无运行时副作用，放进这里让两端共享，避免重复定义。
// ─────────────────────────────────────────────────────────────────────────────

export const CHAT_LOBBY_ID = 'lobby';
export const CHAT_LOBBY_TITLE = '聊天大区';
export const CHAT_DELETED_TEXT = '[该消息已删除]';
// 专注模式禁用文案（聊天场景别名）：单一来源在 focus-mode.ts，聊天侧保留语义化名字
export { FOCUS_MODE_BLOCKED_TITLE as CHAT_FOCUS_BLOCKED_TITLE } from './focus-mode';

export interface ChatAuthorDTO {
  id: string;
  username: string;
  avatar_url: string;
  is_admin: boolean;
}

export interface ChatImageDTO {
  id: string;
  url: string;
  mime_type: string;
}

export interface ChatReplyDTO {
  id: number;
  content: string;
  author_name: string | null;
  is_deleted: boolean;
}

export interface ChatMessageDTO {
  id: number;
  channel_id: string;
  author: ChatAuthorDTO;
  content: string;
  image: ChatImageDTO | null;
  image_missing: boolean;
  reply: ChatReplyDTO | null;
  is_deleted: boolean;
  created_at: string | null;
}

export interface ChatChannelDTO {
  id: string;
  kind: 'lobby' | 'direct';
  title: string;
  peer: { id: string; username: string } | null;
  unread_count: number;
  last_message: {
    id: number | null;
    content: string;
    author_name: string | null;
    created_at: string | null;
  } | null;
  /** 专注模式下该频道不可进入（当前仅大区）：行保留但禁用、无预览、无未读。 */
  disabled?: boolean;
}

/** 发起私聊弹窗的用户搜索项。 */
export interface ChatUserLite {
  id: string;
  username: string;
  role: string;
}