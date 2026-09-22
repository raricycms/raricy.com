// ─────────────────────────────────────────────────────────────────────────────
// chat-shared.ts — 讨论区「纯常量 + DTO 类型」，供服务端与客户端共享。
//
// 【为什么要单独拆一个文件】ChatApp / NewChatModal 是客户端组件（'use client'），
// 而 chat-service.ts 依赖 auth.ts → next/headers（cookies）等 server-only 模块，
// 客户端若 import 它的**值**会把 next/headers 打进浏览器包 → 构建报错。
// 常量与类型是纯数据，无运行时副作用，放进这里让两端共享，避免重复定义。
// ─────────────────────────────────────────────────────────────────────────────

import { stripAudioTokens } from './audio-refs';
import { stripStickerTokens } from './sticker-refs';
import { stripUserCardTokens } from './user-refs';

export const CHAT_LOBBY_ID = 'lobby';
/** 纯文本消息上限。 */
export const CHAT_TEXT_MAX = 5000;
/**
 * 带附件（图床图片 / 引用博客）消息的图注上限。
 *
 * 【2026-09 起与纯文本档同值】此前是 500。理由与「为什么仍留两个常量」见
 * src/lib/comment-shared.ts 的 COMMENT_CAPTION_MAX —— 两边刻意保持同一口径，
 * 改一处请同步另一处。
 */
export const CHAT_CAPTION_MAX = 5000;
export const CHAT_LOBBY_TITLE = '讨论大区';
export const CHAT_DELETED_TEXT = '[该消息已删除]';
/** 侧栏消息预览截断长度（服务端 listChannelsForUser 与客户端本地累加共用同一口径）。 */
export const CHAT_PREVIEW_MAX = 60;
/**
 * 讨论 @ 提及通知的 objectType；objectId 即频道 id（大区就是 `lobby`）。
 *
 * 【为什么要有这个常量】它是「通知」与「讨论」之间唯一的连线，两头各认一次：
 * 通知侧按它清某个会话的已读（notification-service.markChannelNotificationsRead），
 * 列表侧按它渲染「查看讨论」入口（NotificationItems）。写歪一个字符不报错 ——
 * 通知照发、只是永远清不掉 / 点不动，所以字面量收在这里一处。
 */
export const CHAT_NOTIFY_OBJECT_TYPE = 'chat_channel';
// 专注模式禁用文案（讨论场景别名）：单一来源在 focus-mode.ts，讨论侧保留语义化名字
export { FOCUS_MODE_BLOCKED_TITLE as CHAT_FOCUS_BLOCKED_TITLE } from './focus-mode';

/**
 * 把正文里的**内联 token** 换成可读的短标记 —— 侧栏预览 / 引用块 / 通知摘要共用。
 *
 * 表情 → `[表情]`、音频 → `[音频]`（与既有的 `[图片]` / `[博客]` 同口径）；
 * 用户名片 → `@张三`（摘要里看得懂谁被提到了才有意义，换成一个固定词等于没说）。
 *
 * 【为什么住在这里】服务端（chat-service 的三处）与客户端（ChatApp 的
 * previewOfMessage）必须**逐字一致** —— 那两处的注释一直互相指着对方，而这正是
 * 最容易漂的一类。chat-shared 本来就是「给两端共用」而拆出来的模块（它 import 的
 * 三个 refs 模块都是零依赖、两端都能进），放这儿之后这句话成了结构上的事实。
 *
 * ⚠️ 顺序：先名片后表情。表情那条正则虽然已经让开了 `用户` / `音频` 这两个合集名
 * （见 sticker-refs.ts 的 RESERVED_CARD_COLLECTION），但顺序写死，读的人不用去推
 * 那层保证。音频排最后：它认的是 `[@音频/<ID>]`，与另两条的正则都不重叠，
 * 放哪儿都对，写在末尾只是让「新加的排最后」这条习惯保持可见。
 */
export function stripPreviewTokens(text: string): string {
  return stripAudioTokens(stripStickerTokens(stripUserCardTokens(text)));
}

export interface ChatAuthorDTO {
  id: string;
  username: string;
  avatar_url: string;
  /** 头像框贴图地址；null = 没戴 / 已过期 / 素材缺失。**判定已在服务层做完**。 */
  frame_url: string | null;
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
  /**
   * 被引用消息是图片消息且图仍可展示 → 缩略图 URL（此时 content 为空，前端渲染
   * 「作者：<缩略图>」）；图已删/缺失为 null，由服务端在 content 里给占位文案。
   */
  image_url: string | null;
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
  peer: { id: string; username: string; frame_url: string | null } | null;
  unread_count: number;
  /**
   * 大区专属：未读消息里 @ 到我的条数（私聊恒为 undefined —— 私聊只有两人，
   * @ 无意义）。大区的未读提示只认这个：公共频道里普通新消息不打扰，
   * 只有「有人叫你」才亮红点。见 chat-service.listChannelsForUser。
   */
  mention_count?: number;
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
  /** 头像框贴图地址；null = 没戴 / 已过期 / 素材缺失。**判定已在服务层做完**。 */
  frame_url: string | null;
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