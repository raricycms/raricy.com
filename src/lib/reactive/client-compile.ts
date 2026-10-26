'use client';

// ─────────────────────────────────────────────────────────────────────────────
// client-compile.ts — 编辑器预览的**客户端**取数 + 编译
//
// 【职责】把作者原文按站内 `[@…]` 引用规则适配成 ReactiveMD 源码，并在浏览器里
// 编译出一份可渲染的文档。阅读页那条路走服务端（`compile.ts`），这里只服务
// `MarkdownEditor` 的预览面板。
//
// 【为什么取数在客户端】预览必须能看见「作者此刻能看到的东西」：私有的剪贴板、
// 本人投过票的投票、私密收藏夹都依赖**当前会话**。服务端渲染预览等于把作者
// 的会话带进一次后台任务，既慢又多一套权限分叉。
//
// 【只复用既有读口，绝不发明端点、绝不发写请求】
//   剪贴板 `GET /api/clipboard/<id>`、投票 `GET /api/votes/<id>`、
//   收藏夹 `GET /api/spider/favorites/<id>` —— 与 `ContentRefResolver` 的
//   'expand' 模式逐字一致（含 `credentials: 'same-origin'`）。本模块只发 GET。
//   图床与音频**不取数**：适配器只拼 `/api/images|audio/<id>/raw`，权限由 raw
//   路由逐条判。
//
// 【数据形状对齐服务端 ref-reader】适配器把 `payload` 原样塞进 hostData，
// `SiteEmbedView` / `site-embed-static` 又按自己的 parser 读它。所以这里的
// payload 必须与 `ref-reader.ts` 同形：
//   · 投票 —— `{id,title,is_locked,total_votes,user_voted,options}`；
//   · 收藏夹 —— `{title,authorName,href,count,items:[{blogId,title}]}`；
//   · 剪贴板 —— `{href,title}`，**不携带正文**（首期一律链接卡片，见 ref-adapter【6】）。
//   `/api/spider/favorites/<id>` 返回的列表键是 `blogs[].id`，不是 `blogId` ——
//   少这一笔映射，卡片会静默变成「0 篇」。
//
// 【reader 是会话级的，不是模块级】`createClientReferenceReader()` 每次调用新建
// 一份缓存与在飞去重；模块级单例会让 A 篇草稿的私有数据漏进 B 篇，也会让
// 「刷新引用」再也取不到新数据。缓存失败结果与旧 resolver 同口径：不在每次按键
// 时重试 —— 要重试就由调用方换一份新 reader（`ReactivePreview` 的 refreshToken
// 正是这么做的：成功与失败的缓存一起作废）。
// ─────────────────────────────────────────────────────────────────────────────

import { compileLocal, type LocalCompileResult } from 'reactive-md';
import { parseContentFormat } from '../content-format';
import { MAX_CARD_ITEMS } from '../favorite-refs';
import { reactiveCompileOptions } from './host-components';
import { adaptReactiveReferences } from './ref-adapter';
import type { ReferenceReader, ResolvedReference, SiteHostData } from './ref-types';

/** 适配后的预览源码 + 渲染它所需的 hostData（与 `adaptReactiveReferences` 同形）。 */
export interface AdaptedReactivePreview {
  adaptedSource: string;
  hostData: SiteHostData;
}

export interface ReactivePreviewCompile extends AdaptedReactivePreview {
  result: LocalCompileResult;
}

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
  // 兼容未带 format 的旧响应（与 ContentRefResolver 一致）；带了认不出的值
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
    payload: { href: `/clipboard/${id}`, title },
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
        id: asString(data.id) ?? id,
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
      if (!/^\d{6}$/.test(slot.ref)) return undefined;
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

/**
 * 只做引用适配（不编译）。预览要先在这里拿到 `adaptedSource`，再交给
 * `LocalCompileScheduler`（worker 或主线程回退）编译。
 */
export async function adaptReactivePreview(
  source: string,
  reader: ReferenceReader
): Promise<AdaptedReactivePreview> {
  const adapted = await adaptReactiveReferences(source, { mode: 'expand', resolve: reader });
  return { adaptedSource: adapted.adaptedSource, hostData: adapted.hostData };
}

/**
 * 适配 + 主线程编译的一步版本。供单测 / 不需要 worker 的调用方使用；
 * 编辑器预览走 `adaptReactivePreview` + 调度器，避免编译两遍。
 */
export async function compileReactivePreview(
  source: string,
  reader: ReferenceReader
): Promise<ReactivePreviewCompile> {
  const adapted = await adaptReactivePreview(source, reader);
  return {
    ...adapted,
    result: compileLocal(adapted.adaptedSource, reactiveCompileOptions('reactive')),
  };
}
