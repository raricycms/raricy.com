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
/** 侧栏消息预览截断长度（服务端 listChannelsForUser 与客户端本地累加共用同一口径）。 */
export const CHAT_PREVIEW_MAX = 60;
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

/** 消息里引用的博客（读时按当前 Blog 行解析，不存快照）。 */
export interface ChatBlogDTO {
  id: string;
  title: string;
  description: string;
  author: string | null; // 作者 username
  updated_at: string | null; // ISO；渲染期可选展示
}

/** 拍一拍：目标用户（读时按当前 User 行解析 username，不存快照）。 */
export interface ChatPatDTO {
  target_id: string;
  /** 目标已不存在时的占位见 PAT_TARGET_FALLBACK */
  target_name: string;
}

/** pat_target_id 有值但用户行缺失 → 目标名占位 */
export const PAT_TARGET_FALLBACK = '某位用户';

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
  blog: ChatBlogDTO | null;
  /** blog_id 有值但博客缺失/已软删 → 占位（对齐 image_missing）。 */
  blog_missing: boolean;
  /** 非空即拍一拍消息：渲染为居中系统行，正文/图片/博客一律为空 */
  pat: ChatPatDTO | null;
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
  /** 私聊：对方读到的最新消息 id（已读回执用；大区为 null）。 */
  peer_last_read_message_id?: number | null;
  /** 该会话已静音（只影响通知，未读徽标照常） */
  muted?: boolean;
  last_message: {
    id: number | null;
    content: string;
    author_name: string | null;
    created_at: string | null;
  } | null;
  /** 专注模式下该频道不可进入（当前仅大区）：行保留但禁用、无预览、无未读。 */
  disabled?: boolean;
}

/** 发起私聊弹窗的用户搜索项（不含 role：客户端用不到，少暴露一点）。 */
export interface ChatUserLite {
  id: string;
  username: string;
}

// ── SSE 实时流（/api/chat/stream）────────────────────────────────────────────
// 单条流按用户维度推送：活动频道的新消息、以及非活动频道用于本地累加未读的消息。
// 事件类型放在 JSON 体内（而非 SSE 的 event: 字段），客户端只挂一个 onmessage。

/** 一条新消息（大区广播 / 私聊推成员；含发送者自己的其他标签页）。 */
export interface ChatStreamMessageEvent {
  type: 'message';
  channel_id: string;
  message: ChatMessageDTO;
}

/**
 * 断线太久、补齐窗口不够 → 客户端应重新拉取当前频道首页并做一次对账。
 * （服务端补齐有上限，超过就不再逐条补，改让客户端整页重拉。）
 */
export interface ChatStreamResyncEvent {
  type: 'resync';
}

/** 有人正在输入（不落库、只走长连接；客户端 3 秒后自动消失）。 */
export interface ChatStreamTypingEvent {
  type: 'typing';
  channel_id: string;
  user_id: string;
  username: string;
}

/** 对方已读到某条消息（私聊已读回执）。 */
export interface ChatStreamReadEvent {
  type: 'read';
  channel_id: string;
  user_id: string;
  message_id: number;
}

export type ChatStreamEvent =
  | ChatStreamMessageEvent
  | ChatStreamResyncEvent
  | ChatStreamTypingEvent
  | ChatStreamReadEvent;