// ─────────────────────────────────────────────────────────────────────────────
// chat-rmd/reference-reader.ts — 聊天引用的同源取数（剪贴板 / 名片）
//
// 唯一出口：createChatReferenceReader(options?)。URL、状态码到失败态的映射与
// reactive/client-compile.ts 的客户端 reader 保持同一口径：
//   · `GET /api/clipboard/:id`，同源 cookie 鉴权；403/401 = forbidden，404 = missing
//   · `GET /api/users/:name`，名字先 encodeURIComponent
//   · 其余状态、网络错误、响应形状不符 = error（调用方退回 token / 回链）
//
// 【缓存边界】剪贴板正文可能是私聊里的私密内容，**一律不缓存**，失败也不长期缓存。
// 名片只有公开字段（id / username / 头像框 URL），按 viewerScope 做页面级有界缓存：
// 同一页面的多条消息引用同一个人时只取一次（设计 §4「按查看者与页面作用域去重」）；
// 切账号或 provider 卸载时由 clearChatReferenceCache 清理，不会把 A 的缓存给 B。
// 每次读取都带调用方的 AbortSignal；取消后返回 error，不向界面抛异常。
// 并发闸门与单次适配内的资源去重由 references.ts 编排。
// ─────────────────────────────────────────────────────────────────────────────

import type { ContentFormat } from '../content-format';
import { parseContentFormat } from '../content-format';

/** 剪贴板正文语言；`unknown` = 库内认不出的格式（含显式 null），只给站内回链。 */
export type ChatClipboardFormat = ContentFormat | 'unknown';

export type ChatClipboardRead =
  | { status: 'ready'; content: string; format: ChatClipboardFormat }
  | { status: 'missing' | 'forbidden' | 'error' };

export interface ChatUserCard {
  id: string;
  username: string;
  /** 头像框贴图地址；null = 没戴 / 已过期（判定在服务端 frameUrlFor 完成）。 */
  frameUrl: string | null;
}

export type ChatUserCardRead =
  | { status: 'ready'; card: ChatUserCard }
  | { status: 'missing' | 'forbidden' | 'error' };

export interface ChatReferenceReaderOptions {
  /** 仅测试注入；生产一律用同源全局 fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * 页面查看者作用域。给出时名片读取按 `scope + username` 缓存（公开字段）；
   * 不给则完全无状态（测试与一次性取数）。
   */
  viewerScope?: string;
}

/** 名片缓存上限：一页最多几百条消息，256 个不同用户名足够且不会无限涨。 */
const CHAT_USER_CARD_CACHE_LIMIT = 256;

const globalForReader = globalThis as unknown as {
  __chatUserCardCache?: Map<string, ChatUserCard>;
};
const userCardCache: Map<string, ChatUserCard> = (globalForReader.__chatUserCardCache ??= new Map());

function userCardCacheKey(viewerScope: string, name: string): string {
  return `${viewerScope}\n${name}`;
}

function readCachedUserCard(key: string): ChatUserCardRead | null {
  const card = userCardCache.get(key);
  if (!card) return null;
  // 命中即刷新 LRU 顺序（Map 插入序）。
  userCardCache.delete(key);
  userCardCache.set(key, card);
  return { status: 'ready', card };
}

function writeCachedUserCard(key: string, read: ChatUserCardRead): void {
  if (read.status !== 'ready') return; // 失败/无权限不缓存：权限可能刚恢复
  if (userCardCache.size >= CHAT_USER_CARD_CACHE_LIMIT) {
    const oldest = userCardCache.keys().next().value;
    if (oldest !== undefined) userCardCache.delete(oldest);
  }
  userCardCache.set(key, read.card);
}

/** 切账号 / 离开聊天页时清理；不传 scope 清全部（仅供测试与退出登录）。 */
export function clearChatReferenceCache(viewerScope?: string): void {
  if (viewerScope === undefined) {
    userCardCache.clear();
    return;
  }
  const prefix = `${viewerScope}\n`;
  for (const key of [...userCardCache.keys()]) {
    if (key.startsWith(prefix)) userCardCache.delete(key);
  }
}

export interface ChatReferenceReader {
  readClipboard(id: string, signal: AbortSignal): Promise<ChatClipboardRead>;
  readUserCard(name: string, signal: AbortSignal): Promise<ChatUserCardRead>;
}

function failureForStatus(status: number): 'missing' | 'forbidden' | 'error' {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'missing';
  return 'error';
}

/**
 * 旧响应缺 format 时沿用 Markdown 兼容；显式 null / 未知值不猜成 Markdown。
 * （与 client-compile.ts 的 readClipboard 同一口径。）
 */
function resolveClipboardFormat(raw: unknown): ChatClipboardFormat {
  if (raw === undefined) return 'markdown';
  return parseContentFormat(raw) ?? 'unknown';
}

function readClipboardWith(
  doFetch: typeof fetch,
  id: string,
  signal: AbortSignal
): Promise<ChatClipboardRead> {
  if (signal.aborted) return Promise.resolve({ status: 'error' });
  return (async () => {
    try {
      const res = await doFetch(`/api/clipboard/${encodeURIComponent(id)}`, {
        credentials: 'same-origin',
        signal,
      });
      if (!res.ok) return { status: failureForStatus(res.status) } as const;
      const data = (await res.json()) as { clip?: { content?: unknown; format?: unknown } };
      const clip = data?.clip;
      if (!clip || typeof clip.content !== 'string') return { status: 'error' } as const;
      return {
        status: 'ready',
        content: clip.content,
        format: resolveClipboardFormat(clip.format),
      } as const;
    } catch {
      // 网络错误与 AbortError 一视同仁：这一处引用降级，不向页面抛。
      return { status: 'error' } as const;
    }
  })();
}

function readUserCardWith(
  doFetch: typeof fetch,
  name: string,
  signal: AbortSignal,
  viewerScope?: string
): Promise<ChatUserCardRead> {
  if (signal.aborted) return Promise.resolve({ status: 'error' });
  const cacheKey = viewerScope ? userCardCacheKey(viewerScope, name) : null;
  if (cacheKey) {
    const cached = readCachedUserCard(cacheKey);
    if (cached) return Promise.resolve(cached);
  }
  return (async () => {
    try {
      const res = await doFetch(`/api/users/${encodeURIComponent(name)}`, {
        credentials: 'same-origin',
        signal,
      });
      if (!res.ok) return { status: failureForStatus(res.status) } as const;
      const data = (await res.json()) as {
        user?: { id?: unknown; username?: unknown; frameUrl?: unknown };
      };
      const user = data?.user;
      if (!user || typeof user.id !== 'string' || !user.id) {
        return { status: 'error' } as const;
      }
      if (typeof user.username !== 'string' || !user.username) {
        return { status: 'error' } as const;
      }
      const result: ChatUserCardRead = {
        status: 'ready',
        card: {
          id: user.id,
          username: user.username,
          frameUrl: typeof user.frameUrl === 'string' ? user.frameUrl : null,
        },
      };
      if (cacheKey) writeCachedUserCard(cacheKey, result);
      return result;
    } catch {
      return { status: 'error' } as const;
    }
  })();
}

/** 一份 reader。剪贴板永远直读；名片在给出 viewerScope 时共享页面级有界缓存。 */
export function createChatReferenceReader(
  options: ChatReferenceReaderOptions = {}
): ChatReferenceReader {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const viewerScope = options.viewerScope;
  return {
    readClipboard: (id, signal) => readClipboardWith(doFetch, id, signal),
    readUserCard: (name, signal) => readUserCardWith(doFetch, name, signal, viewerScope),
  };
}