// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/reference-types.ts — 聊天引用宿主组件与 hostData 的形状（C 的输入）
//
// 引用适配器（references.ts）把识别出的 token 改写成 `chat-ref` 宿主节点，节点 attrs
// 只留 slot；字符、URL、用户资料一律放 hostData，键就是同一个 slot。视图只信
// `hostData[slot]`，不解析 attrs 里的任何内容 —— 作者伪造的同名标签拿不到数据。
//
// 每个出现位置一个 slot（同一资源出现两次也各占一个），失败状态因此不会互相传染。
// 子剪贴板的宿主数据与父文档共用同一张 hostData（slot 全局唯一）。
// ─────────────────────────────────────────────────────────────────────────────

import type { LocalDocument } from 'reactive-md';
import { MAX_AUDIO_REFS } from '../audio-refs';
import { MAX_IMAGE_REFS } from '../content-refs';
import { MAX_STICKER_REFS } from '../sticker-refs';
import { MAX_USER_REFS } from '../user-refs';
import type { ChatReferenceBudget } from './types';

/** 聊天引用宿主组件的标签名（由适配器生成，视图按名字分发）。 */
export const CHAT_REF_HOST_TAG = 'chat-ref';

/** 宿主节点 attrs 的唯一键；值是对应 hostData 的 slot。 */
export const CHAT_REF_SLOT_ATTR = 'slot';

/** 槽位命名：同一条消息内单调递增，父文档与子剪贴板共用一个序列。 */
export function chatRefSlot(index: number): string {
  return `chat-ref-${index}`;
}

/**
 * 单条消息的默认引用预算（设计 §4 兼容矩阵）。
 * 调用方可通过 `ChatReferenceContext.budget` 覆盖；超限位置保留原 token。
 */
export const CHAT_REFERENCE_BUDGET: ChatReferenceBudget = Object.freeze({
  images: MAX_IMAGE_REFS,
  audio: MAX_AUDIO_REFS,
  stickers: MAX_STICKER_REFS,
  users: MAX_USER_REFS,
  clipboard: 1,
});

/** 10 位图床图片；权限仍由 `/api/images/:id/raw` 自己校验。 */
export interface ChatImageHostData {
  kind: 'image';
  slot: string;
  /** 原文 token（媒体加载失败时视图退回字面量）。 */
  token: string;
  imageId: string;
  url: string;
}

/** 音频床；失败由视图按 token 降级。 */
export interface ChatAudioHostData {
  kind: 'audio';
  slot: string;
  token: string;
  url: string;
}

/** 表情包；`emoji` 表示内置黄脸（静态清单，叠加行内尺寸类）。 */
export interface ChatStickerHostData {
  kind: 'sticker';
  slot: string;
  token: string;
  url: string;
  emoji: boolean;
}

/** 名片只使用公开字段；头像地址由适配器按 id 现拼。 */
export interface ChatUserCardPayload {
  id: string;
  username: string;
  avatar_url: string;
  frame_url: string | null;
}

export interface ChatUserHostData {
  kind: 'user';
  slot: string;
  token: string;
  user: ChatUserCardPayload;
}

/**
 * 剪贴板失败态：不携带标题 / 正文，失败时不把服务端私密内容带进聊天。
 * `format` 同时覆盖 reactive 与库内认不出的未知格式（只给站内回链）。
 */
export type ChatClipboardError = 'missing' | 'forbidden' | 'format';

export interface ChatClipboardHostData {
  kind: 'clipboard';
  slot: string;
  token: string;
  /** Markdown 子剪贴板独立编译后的文档；缺席时视图按 href 显示回链。 */
  document?: LocalDocument;
  /** 站内回链（`/clipboard/:id`），截断与失败态都用它。 */
  href?: string;
  /** 原文超过 2000 字，展示的是截断后的子文档。 */
  truncated?: boolean;
  error?: ChatClipboardError;
}

/** 无法内联时仍占一个宿主位置，视图原样显示 token。 */
export interface ChatFallbackHostData {
  kind: 'fallback';
  slot: string;
  token: string;
}

export type ChatHostData =
  | ChatImageHostData
  | ChatAudioHostData
  | ChatStickerHostData
  | ChatUserHostData
  | ChatClipboardHostData
  | ChatFallbackHostData;

export type ChatHostDataMap = Record<string, ChatHostData>;

const HOST_KINDS = new Set<string>([
  'image',
  'audio',
  'sticker',
  'user',
  'clipboard',
  'fallback',
]);

/** 视图侧防御性判据：只认适配器定义的六种载荷。 */
export function isChatHostData(value: unknown): value is ChatHostData {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string' && HOST_KINDS.has(record.kind) &&
    typeof record.slot === 'string' && typeof record.token === 'string';
}