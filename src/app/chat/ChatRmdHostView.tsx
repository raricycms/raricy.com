'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChatRmdHostView.tsx — `chat-ref` 宿主组件的渲染器（聊天静态视图）
//
// 数据来源只有一个：`env.hostData[slot]`，slot 来自节点 attrs 的 `slot`。节点上的
// 其他内容一概不解析 —— 作者伪造同名标签只能拿到「没有数据」的 token，不会获得
// 媒体、名片或剪贴板能力。每个载荷在这里再做一次字段校验，URL 全部由**校验过的
// id / 白名单前缀**重拼，hostData 里带来的 url 不可信。
//
// 图片 / 表情失败按 slot 上报给 ChatRmdMessage 汇总（撤销单图类），渲染回退是原
// token 的 React 文本节点；音频是自包含控件，解码错误也保留播放器结构，不换回
// token。所有回退都不共享失败状态、不构造 dangerouslySetInnerHTML。
//
// 剪贴板的 Markdown 子文档用内层 static `ChatRmdDocument` 渲染：同一 hostData、
// 同一 URL 策略，宿主渲染器带 `allowClipboard:false` —— 子剪贴板不再递归展开。
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import type { LocalDocument, LocalNode } from 'reactive-md';
import type { LocalHostData } from 'reactive-md/react';
import Avatar from '@/app/components/Avatar';
import { audioUrl } from '@/lib/audio-refs';
import { AVATAR_URL_PREFIX, avatarUrl } from '@/lib/avatar-refs';
import { EMOJI_FACES, emojiUrl } from '@/lib/emoji-faces';
import { isStickerSegment, stickerUrl } from '@/lib/sticker-refs';
import {
  CHAT_REF_SLOT_ATTR,
  isChatHostData,
  type ChatHostData,
} from '@/lib/chat-rmd/reference-types';
import type { LocalUrlPolicy } from 'reactive-md/react';
import ChatRmdDocument from './ChatRmdDocument';

const IMAGE_ID_RE = /^[A-Za-z0-9]{10}$/;
const AUDIO_PATH_RE = /^\/api\/audio\/([A-Za-z0-9]{10})\/raw$/;
const CLIPBOARD_HREF_RE = /^\/clipboard\/[A-Za-z0-9]{8}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FRAME_PATH_RE = /^\/api\/frames\/[A-Za-z0-9_-]{1,32}$/;
const STICKER_PATH_RE = /^\/api\/stickers\/([^/?#]+)\/([^/?#]+)$/;

/** 内置黄脸只认编译期清单里的地址，URL 里拼不出任意静态文件。 */
const EMOJI_URLS: ReadonlySet<string> = new Set(
  EMOJI_FACES.map((face) => emojiUrl(face.file))
);

export interface ChatRmdHostEnvironment {
  /** 适配器登记的槽位数据；键就是节点 attrs 里的 slot。 */
  hostData?: LocalHostData;
  /** 已失败的槽位；失败槽位直接显示 token（由消息层汇总）。 */
  failedSlots?: ReadonlySet<string>;
  /** 整条正文只有一张内置黄脸时，该槽位叠加 `rich-emoji-solo`。 */
  soloEmojiSlot?: string | null;
  /** 子剪贴板渲染时为 false：只给回链，不递归展开。 */
  allowClipboard?: boolean;
  /** 内层子文档沿用父文档的 URL 策略。 */
  urlPolicy?: LocalUrlPolicy;
  onImageClick?: (url: string) => void;
  /** 媒体 load / error 统一上报；failed=true 表示该槽位永久降级为 token。 */
  onMediaSettled?: (slot: string, failed: boolean) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocalDocument(value: unknown): value is LocalDocument {
  return isRecord(value) && Array.isArray(value.nodes);
}

function readSlot(node: LocalNode): string | null {
  const slot = node.attrs?.[CHAT_REF_SLOT_ATTR];
  return typeof slot === 'string' && slot.length > 0 ? slot : null;
}

function readPayload(env: ChatRmdHostEnvironment, slot: string): ChatHostData | null {
  const data = env.hostData?.[slot];
  if (isChatHostData(data) && data.slot === slot) return data;
  // 登记表里存在、但 kind / 字段形状不可识别：仍把原文 token 还给读者，
  // 而不是让整处引用静默消失（「未知 kind 直接显示 token」）。
  if (isRecord(data) && typeof data.token === 'string') {
    return { kind: 'fallback', slot, token: data.token };
  }
  return null;
}

function imageSource(imageId: unknown): string | null {
  if (typeof imageId !== 'string' || !IMAGE_ID_RE.test(imageId)) return null;
  return `/api/images/${imageId}/raw`;
}

function audioSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = AUDIO_PATH_RE.exec(raw);
  if (!match) return null;
  // 由 id 重拼，避免 hostData 里的 url 被替换成其他受控前缀。
  return audioUrl(match[1]);
}

function stickerSource(raw: unknown, emoji: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (emoji === true) return EMOJI_URLS.has(raw) ? raw : null;
  if (emoji !== false) return null;
  const match = STICKER_PATH_RE.exec(raw);
  if (!match) return null;
  let collection: string;
  let name: string;
  try {
    collection = decodeURIComponent(match[1]);
    name = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!isStickerSegment(collection) || !isStickerSegment(name)) return null;
  return stickerUrl(collection, name) === raw ? raw : null;
}

function avatarSource(raw: unknown, userId: string): string | undefined {
  if (
    typeof raw === 'string' &&
    raw.startsWith(AVATAR_URL_PREFIX) &&
    /^[A-Za-z0-9_-]{1,64}$/.test(raw.slice(AVATAR_URL_PREFIX.length))
  ) {
    return raw;
  }
  return avatarUrl(userId);
}

function frameSource(raw: unknown): string | null {
  return typeof raw === 'string' && FRAME_PATH_RE.test(raw) ? raw : null;
}

function ClipboardLink({ href, truncated }: { href: string; truncated: boolean }): ReactNode {
  return (
    <a className="chat-rmd-clipboard-link" href={href} rel="noopener noreferrer">
      {truncated ? '查看完整剪贴板' : '剪贴板'}
    </a>
  );
}

function ClipboardRef({
  payload,
  env,
}: {
  payload: Extract<ChatHostData, { kind: 'clipboard' }>;
  env: ChatRmdHostEnvironment;
}): ReactNode {
  const href =
    typeof payload.href === 'string' && CLIPBOARD_HREF_RE.test(payload.href)
      ? payload.href
      : null;
  const truncated = payload.truncated === true;
  const canInline =
    env.allowClipboard !== false && isLocalDocument(payload.document) && href !== null;

  if (!canInline) {
    return href ? <ClipboardLink href={href} truncated={truncated} /> : payload.token;
  }

  return (
    <div className="chat-rmd-clipboard">
      <ChatRmdDocument
        document={payload.document as LocalDocument}
        hostData={env.hostData}
        hostRenderer={(node, data, ctx) =>
          ChatRmdHostView(node, data, ctx, { ...env, allowClipboard: false })
        }
        urlPolicy={env.urlPolicy}
      />
      {truncated && href ? <ClipboardLink href={href} truncated /> : null}
    </div>
  );
}

function UserRef({
  payload,
}: {
  payload: Extract<ChatHostData, { kind: 'user' }>;
}): ReactNode {
  const card = isRecord(payload.user) ? payload.user : null;
  const id = card && typeof card.id === 'string' ? card.id : '';
  const username = card && typeof card.username === 'string' ? card.username : '';
  if (!USER_ID_RE.test(id) || username.length === 0 || username.length > 64) {
    return payload.token;
  }
  const frame = card ? frameSource(card.frame_url) : null;
  const avatar = avatarSource(card?.avatar_url, id);
  return (
    <a className="rich-user-ref" href={`/u/${id}`} title={`访问 ${username} 的主页`}>
      <Avatar
        userId={id}
        src={avatar}
        frameUrl={frame}
        alt=""
        className="rich-user-ref__avatar"
        loading="lazy"
      />
      <span className="rich-user-ref__name">{username}</span>
    </a>
  );
}

function ChatRefBody({
  payload,
  env,
  slot,
}: {
  payload: ChatHostData;
  env: ChatRmdHostEnvironment;
  slot: string;
}): ReactNode {
  switch (payload.kind) {
    case 'image': {
      const src = imageSource(payload.imageId);
      if (!src) return payload.token;
      return (
        <img
          className="rich-image-ref"
          src={src}
          alt={payload.imageId}
          loading="lazy"
          draggable={false}
          onClick={env.onImageClick ? () => env.onImageClick?.(src) : undefined}
          onLoad={() => env.onMediaSettled?.(slot, false)}
          onError={() => env.onMediaSettled?.(slot, true)}
        />
      );
    }
    case 'audio': {
      const src = audioSource(payload.url);
      if (!src) return payload.token;
      return (
        <audio
          className="rich-audio-ref chat-rmd-audio"
          src={src}
          controls
          preload="none"
          aria-label="音频播放器"
          onLoadedMetadata={() => env.onMediaSettled?.(slot, false)}
          // 音频错误不回退 token：0 秒录音、只有 ID3 头的文件在浏览器里会报
          // 解码错误，但引用本身仍应保留播放器结构，而不是缩回 `[@音频/…]`。
        />
      );
    }
    case 'sticker': {
      const src = stickerSource(payload.url, payload.emoji);
      if (!src) return payload.token;
      const solo = payload.emoji && env.soloEmojiSlot === slot;
      const className = payload.emoji
        ? `rich-sticker-ref rich-emoji-ref${solo ? ' rich-emoji-solo' : ''}`
        : 'rich-sticker-ref';
      return (
        <img
          className={className}
          src={src}
          alt={payload.token}
          loading="lazy"
          draggable={false}
          onLoad={() => env.onMediaSettled?.(slot, false)}
          onError={() => env.onMediaSettled?.(slot, true)}
        />
      );
    }
    case 'user':
      return <UserRef payload={payload} />;
    case 'clipboard':
      return <ClipboardRef payload={payload} env={env} />;
    case 'fallback':
      return payload.token;
    default:
      return null;
  }
}

/**
 * 宿主渲染入口：签名与 `LocalHostRenderer` 一致（由 `hostRenderer` 直接调用）。
 * 自身不持有 hooks，交互态全部留在消息层，直接调用也安全。
 */
export function ChatRmdHostView(
  node: LocalNode,
  data: unknown,
  ctx: unknown,
  env: ChatRmdHostEnvironment = {}
): ReactNode {
  // 适配器的节点只有 slot；上游传入的 data 为空。保留参数只为签名对齐。
  void data;
  void ctx;

  const slot = readSlot(node);
  if (!slot) return null;
  const payload = readPayload(env, slot);
  if (!payload) return null;
  if (env.failedSlots?.has(slot)) return payload.token;
  return <ChatRefBody payload={payload} env={env} slot={slot} />;
}

export default ChatRmdHostView;