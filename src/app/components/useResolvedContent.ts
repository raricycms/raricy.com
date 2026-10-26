'use client';

// ─────────────────────────────────────────────────────────────────────────────
// useResolvedContent.ts — 把正文里的 `[@<8位剪贴板ID>]` 展开成剪贴板正文
//
// 【为什么必须留在 React 层】净化管线（src/lib/rich-text.ts）是**同步**的：
// renderCommentMarkdown 在 render 期间被同步调用（每棵子树每个节点一次），改成
// async 会把整个评论区翻成状态机。所以异步只留在这里 —— 取到正文后当普通字符串
// 交给渲染器，渲染器本身仍然又纯又可缓存。这与博客侧 MarkdownRenderer 的
// useEffect + cancelled 标志是同一种分层。
//
// 【图床图片为什么不在这个文件】`[@10位]` 不需要请求（只是拼 URL），所以它在
// 渲染器内部同步完成 —— 见 src/lib/content-refs.ts 的 embedImageRefs。
//
// 【加载中显示什么】就显示字面量 `[@abc12345]`。这是唯一既不跳版、又不需要额外
// 「加载态语法」的选择；而且取不到时的样子（未登录 / 非 core 读者）与加载中一致，
// 评论区那种「多数读者看不到剪贴板」的场景不会满屏报错。
//
// 【缓存】模块级：同一条剪贴板被 N 条消息引用时只请求一次；长会话滚动也不会
// 无界增长（FIFO + TTL）。**失败不进缓存** —— 下次挂载会重试。
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import {
  clipboardFailureText,
  firstClipboardRef,
  replaceClipboardRef,
  truncateClipboardContent,
} from '@/lib/content-refs';
import { parseContentFormat } from '@/lib/content-format';
import type { ContentFormat } from '@/lib/content-format';
import { reactiveClipboardLink } from '@/lib/content-ref-resolver';

/** 缓存条数上限（与 chat-markdown 的 CACHE_MAX 同量级即可）。 */
const CACHE_MAX = 200;
/**
 * 缓存有效期。剪贴板是可以被编辑的，永久缓存会让「改了剪贴板、别人的消息里还是
 * 旧文」一直持续到刷新页面为止。
 */
const CACHE_TTL_MS = 5 * 60_000;

/** 一条剪贴板取数结果。**格式与正文一起缓存** —— 只存正文就分不出能不能内联。 */
interface LoadedClip {
  text: string;
  /** null = 服务端给了个认不出的格式：已降级成安全链接，读取方别再当正文用。 */
  format: ContentFormat | null;
  version?: string;
}

const cache = new Map<string, LoadedClip & { at: number }>();
/** 并发去重：同一条剪贴板被多条消息同时引用时只发一次请求。 */
const inflight = new Map<string, Promise<LoadedClip>>();

/** 命中返回结果，未命中/过期返回 undefined。 */
function readCache(id: string): LoadedClip | undefined {
  const hit = cache.get(id);
  if (hit === undefined) return undefined;
  // 纯客户端缓存的新鲜度判断：两边都是真实时钟，与库内「UTC+8 墙上时间」无关
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(id);
    return undefined;
  }
  return { text: hit.text, format: hit.format, version: hit.version };
}

function writeCache(id: string, value: LoadedClip): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, { ...value, at: Date.now() });
}

/** 取剪贴板正文；失败回落成与博客一致的失败文案，且不写缓存。 */
function loadClipboard(id: string): Promise<LoadedClip> {
  const existing = inflight.get(id);
  if (existing) return existing;

  const task = (async (): Promise<LoadedClip> => {
    try {
      const res = await fetch(`/api/clipboard/${id}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('failed'); // 401/403/404 一视同仁
      const data: unknown = await res.json();
      const clip = (data as { clip?: { content?: unknown; format?: unknown; version?: unknown } })?.clip;
      const raw = typeof clip?.content === 'string' ? clip.content : '';
      // 未带 format 的旧响应按 markdown（兼容）；带了认不出的值**不猜 markdown**，
      // 与博客侧 ContentRefResolver 同一口径：只给一个安全的站内链接。
      const rawFormat = clip?.format;
      const version = typeof clip?.version === 'string' ? clip.version : undefined;
      const format =
        rawFormat === undefined ? 'markdown' : parseContentFormat(rawFormat);
      if (format !== 'markdown') {
        const value: LoadedClip = { text: reactiveClipboardLink(id), format, version };
        writeCache(id, value);
        return value;
      }
      const value: LoadedClip = { text: raw, format, version };
      writeCache(id, value);
      return value;
    } catch {
      // 失败不进缓存（下次挂载重试）—— 与改动前一致。
      return { text: clipboardFailureText(id), format: 'markdown' };
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, task);
  return task;
}

/**
 * 把正文里**第一条** `[@<8位ID>]` 换成剪贴板正文（一条消息最多 1 条）。
 *
 * 没有引用、或还没取到时原样返回 content —— 调用方无需区分「加载中」。
 */
export function useResolvedContent(content: string): string {
  const ref = useMemo(() => firstClipboardRef(content), [content]);
  const refId = ref?.id ?? null;
  const [resolved, setResolved] = useState<({ id: string } & LoadedClip) | null>(null);

  useEffect(() => {
    if (!refId) return;
    let cancelled = false;

    const cached = readCache(refId);
    if (cached !== undefined) {
      setResolved({ id: refId, ...cached });
      return;
    }

    void loadClipboard(refId).then((value) => {
      if (!cancelled) setResolved({ id: refId, ...value });
    });
    return () => {
      cancelled = true;
    };
  }, [refId]);

  return useMemo(() => {
    // 竞态守卫：正文换成了另一个引用时，旧的展开结果不能套用在新正文上
    if (!ref || !resolved || resolved.id !== ref.id) return content;
    // reactive 的结果已经是链接（不内联源码），不需要也不该按正文截断；
    // markdown 才走原来的「过长截断 + 回原剪贴板链接」。
    const replacement =
      resolved.format === 'markdown'
        ? truncateClipboardContent(resolved.text, ref.id)
        : resolved.text;
    return replaceClipboardRef(content, ref, replacement);
  }, [content, ref, resolved]);
}
