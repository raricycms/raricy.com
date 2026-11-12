'use client';

import type { LocalDocument } from 'reactive-md';
import { parseContentFormat } from '../content-format';
import { MAX_CARD_ITEMS, isFavoriteId } from '../favorite-refs';
import { MAX_REF_CONCURRENCY, createConcurrencyLimiter } from '../content-refs';
import { expandDocumentReferences } from './ref-adapter';
import type { ReferenceMode, ReferenceReader, ResolvedReference } from './ref-types';

/**
 * 预览 + 导出**共用**的真实取数闸门（R3-103）。
 *
 * 编辑器里预览面板与「导出 / 打印」各自调一次 `expandClientReferences`，同页并发时
 * 两边各自建闸门会让峰值变成 2×`MAX_REF_CONCURRENCY`（8 条真实 HTTP）。闸门放在
 * 模块级后，同一时刻在飞的请求封在 4 条；「实例级」指的是这一份共享实例，不是每次
 * 适配一份。
 *
 * ⚠️ **不要**把它挪进 `createClientReferenceReader`：reader 是**会话/草稿级**的
 * （见文件头），而闸门要跨 reader 共享 —— 两个 reader 同时取数时也应该一起封顶。
 * 也不用担心跨草稿串数据：闸门只排队、不缓存任何结果。
 */
const previewFetchGate = createConcurrencyLimiter(MAX_REF_CONCURRENCY);

export interface ClientReferenceReaderOptions {
  /** 仅测试注入；生产一律用全局 fetch（同源、只读）。 */
  fetchImpl?: typeof fetch;
}

const EMBED_REF_RE = /^[A-Za-z0-9]+$/;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function readClipboard(
  id: string,
  doFetch: typeof fetch
): Promise<ResolvedReference | undefined> {
  const res = await doFetch(`/api/clipboard/${id}`, { credentials: 'same-origin' });
  if (!res.ok) return { status: res.status === 403 ? 'forbidden' : 'error' };
  const data = (await res.json()) as {
    clip?: { title?: unknown; content?: unknown; format?: unknown; version?: unknown };
    content?: unknown;
  };
  const clip = data?.clip;
  if (!clip || typeof clip.content !== 'string') return { status: 'error' };
  // 兼容未带 format 的旧响应（与 ref-reader.ts 一致）；带了认不出的值
  // 绝不猜成 markdown —— 不给数据，适配器保留字面量。
  const format =
    clip.format === undefined ? 'markdown' : parseContentFormat(clip.format);
  if (!format) return { status: 'error' };
  const title = asString(clip.title) ?? '';
  return {
    status: 'ready',
    title,
    format,
    version: asString(clip.version),
    content: clip.content,
    // payload 只放渲染方真读的字段：标题由 `title` 带，链接按 ref 现拼。
    // 这里曾多写一个 `href`，全仓没有任何读者（R3-140）。
    payload: { title },
  };
}

interface RawVoteOption {
  id?: unknown;
  label?: unknown;
  count?: unknown;
  percentage?: unknown;
}

function readVote(id: string, doFetch: typeof fetch): Promise<ResolvedReference | undefined> {
  return doFetch(`/api/votes/${id}`, { credentials: 'same-origin' }).then(async (res) => {
    if (!res.ok) return { status: res.status === 403 ? 'forbidden' : 'error' } as const;
    const json = (await res.json()) as { code?: unknown; data?: unknown };
    if (json?.code !== 200 || !json.data || typeof json.data !== 'object') {
      return { status: 'error' } as const;
    }
    const data = json.data as {
      id?: unknown;
      title?: unknown;
      is_locked?: unknown;
      total_votes?: unknown;
      user_voted?: unknown;
      options?: unknown;
    };
    if (
      typeof data.title !== 'string' ||
      typeof data.is_locked !== 'boolean' ||
      typeof data.total_votes !== 'number' ||
      !(data.user_voted === null || typeof data.user_voted === 'number') ||
      !Array.isArray(data.options)
    ) {
      return { status: 'error' } as const;
    }
    const options = (data.options as RawVoteOption[])
      .filter(
        (o): o is { id: number; label: string; count: number; percentage: number } =>
          typeof o?.id === 'number' &&
          typeof o?.label === 'string' &&
          typeof o?.count === 'number' &&
          typeof o?.percentage === 'number'
      )
      .map(({ id: optionId, label, count, percentage }) => ({
        id: optionId,
        label,
        count,
        percentage,
      }));
    return {
      status: 'ready',
      title: data.title,
      payload: {
        // 不写 `id`：渲染方（parseVoteData）只认下面这些展示字段，
        // 投票 id 由宿主的 ref 决定，payload.id 全仓零读者（R3-140）。
        title: data.title,
        is_locked: data.is_locked,
        total_votes: data.total_votes,
        user_voted: data.user_voted,
        options,
      },
    } as const;
  });
}

function readFavorite(id: string, doFetch: typeof fetch): Promise<ResolvedReference | undefined> {
  return doFetch(`/api/spider/favorites/${id}`, { credentials: 'same-origin' }).then(
    async (res) => {
      if (!res.ok) return { status: res.status === 403 ? 'forbidden' : 'error' } as const;
      const data = (await res.json()) as {
        title?: unknown;
        author?: unknown;
        count?: unknown;
        blogs?: unknown;
      };
      if (!data || typeof data.title !== 'string') return { status: 'error' } as const;
      const items = Array.isArray(data.blogs)
        ? data.blogs
            .filter((b): b is { id: string; title: string } => {
              const o = b as { id?: unknown; title?: unknown };
              return typeof o?.id === 'string' && typeof o?.title === 'string';
            })
            .slice(0, MAX_CARD_ITEMS)
            // ★ 键名映射：API 是 `blogs[].id`，宿主解析器要的是 `items[].blogId` ★
            .map((b) => ({ blogId: b.id, title: b.title }))
        : [];
      return {
        status: 'ready',
        title: data.title,
        payload: {
          title: data.title,
          authorName: asString(data.author) ?? '',
          href: `/favorite/${id}`,
          count: typeof data.count === 'number' ? data.count : items.length,
          items,
        },
      } as const;
    }
  );
}

async function loadClientReference(
  slot: { kind: string; ref: string },
  doFetch: typeof fetch
): Promise<ResolvedReference | undefined> {
  if (!EMBED_REF_RE.test(slot.ref)) return undefined;
  try {
    if (slot.kind === 'clipboard') {
      if (slot.ref.length !== 8) return undefined;
      return await readClipboard(slot.ref, doFetch);
    }
    if (slot.kind === 'vote') {
      if (slot.ref.length !== 9) return undefined;
      return await readVote(slot.ref, doFetch);
    }
    if (slot.kind === 'favorite') {
      // 6 位白名单只有一处（favorite-refs 的 FAVORITE_ID_LEN/RE，R3-240）：
      // 曾在取数处手写 `/^\d{6}$/`，改长度时这里不跟随 → 收藏夹卡片静默消失。
      if (!isFavoriteId(slot.ref)) return undefined;
      return await readFavorite(slot.ref, doFetch);
    }
    // 图床 / 音频不取数：地址由适配器直接拼 raw 路由。
    return undefined;
  } catch {
    // 网络 / 解析失败只影响这一条引用；适配器据此保留字面量。
    return { status: 'error' };
  }
}

/**
 * 新建一份**会话级**客户端 reader（缓存 + 在飞去重都在这一份实例里）。
 * 编辑器每挂载一次就建一份，卸载即释放。
 */
export function createClientReferenceReader(
  options: ClientReferenceReaderOptions = {}
): ReferenceReader {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const cache = new Map<string, Promise<ResolvedReference | undefined>>();
  return (slot) => {
    const key = `${slot.kind}:${slot.ref}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = loadClientReference(slot, doFetch);
    cache.set(key, pending);
    return pending;
  };
}

export function expandClientReferences(document: LocalDocument, reader: ReferenceReader, mode: ReferenceMode) {
  return expandDocumentReferences(document, { mode, resolve: reader, scheduler: previewFetchGate });
}
