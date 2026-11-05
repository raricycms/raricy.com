// ─────────────────────────────────────────────────────────────────────────────
// content-ref-resolver.ts — 博客 / 剪贴板正文 `[@…]` 引用的**取数与缓存层**
//
// 【职责边界】只回答「这条引用取到了什么」，**不**决定整篇替换位置、顺序与预算 ——
// 那是 content-ref-processor.ts 的事（盖码扫描 / 按区间切片 / MAX_BLOG_REF_ITEMS）。
// 本模块只被 ContentRefProcessor 与编辑器导出使用；别往里塞 Markdown 处理。
//
// 【两种模式，不是「展开 / 不展开」】
//   · 'expand'   —— 站内成员视图：带 same-origin 凭据请求三条 core+ 接口
//     （剪贴板正文 / 投票存在性探测 / 收藏夹卡片数据），图床永远只是拼 URL。
//   · 'external' —— 仅拼接图片与音频地址；所有成员引用保留原文，不取数。
//     不进对外视图是站长定的口径）。
//   判据是「这条引用的读口匿名取不取得到」，见 docs/architecture.md §7.3。
//
// 【缓存语义】
//   · 键 = `${type}:${id}`；模式在建实例时定死，不混键。
//   · 并发同键复用同一个 in-flight Promise —— 同一资源一次渲染里的多处引用不会重复请求。
//   · 失败也缓存（降级文案 / 错误标记）：不在每次按键时重试。
//   · 容量有上限（逐出最旧）。一篇正文的替换名额由 MAX_BLOG_REF_ITEMS 封顶，
//     但**去重后的 id 集合**可以超过它；逐出只是多一次重取，不影响正确性。
//   · **真实并发有上限**（MAX_REF_CONCURRENCY，实例级闸门）：同一时刻在飞的
//     HTTP 最多 4 条。整篇的引用是一次性 `Promise.all` 交下来的，没有闸门就是
//     「一篇塞满引用的正文同时打出几十条请求」。**图床（只拼 URL）与对外视图
//     （查字典、不发请求）不排队** —— 见 needsSlot。
// ─────────────────────────────────────────────────────────────────────────────

import type { VoteEmbedData } from '@/lib/blog-markdown';
import {
  MAX_REF_CONCURRENCY,
  clipboardFailureText,
  createConcurrencyLimiter,
} from '@/lib/content-refs';
import { parseContentFormat } from '@/lib/content-format';
import type { ContentFormat } from '@/lib/content-format';
import {
  MAX_CARD_ITEMS,
  buildFavoriteCardHtml,
  favoriteFailureText,
} from '@/lib/favorite-refs';

/** `contentRefs` 的两个取值，见文件头「两种模式」。 */
export type ContentRefMode = 'expand' | 'external';

/** 引用类别 —— 与 id 长度分流一一对应（8 剪贴板 / 9 投票 / 10 图床 / 6 位数字收藏夹）。 */
export type ContentRefType = 'clipboard' | 'vote' | 'image' | 'favorite';

/**
 * 一条引用的解析结果。字段沿用渲染层的既有形状：
 *   · clipboard / favorite —— `content` 是要替换进 Markdown 源文的串
 *     （剪贴板正文或收藏夹卡片 HTML；失败时是降级文案）。
 *   · vote —— 只做存在性探测：成功 `{ type:'vote' }`，失败 `error:true`。
 *     **顺带把小组件要的那份数据留下**（`data`）—— 探测与小组件取的是**同一个**
 *     `GET /api/votes/<id>`，丢掉再拉一次等于编辑器预览每停一下就多发一轮请求。
 *     正文页不用它（那条路自己拉，票数取当时的值），只有只读预览会读。
 *     注意 `data` 的**有无不影响成败语义**：只要响应 ok 就仍然不算 error。
 *   · image —— 不请求，`url` 直接拼 raw 路由（那边逐条判权，私有档 404）。
 */
export interface ResolvedRef {
  type: ContentRefType;
  content?: string;
  /**
   * 仅 clipboard：结果的正文格式。**缓存必须连格式一起存** —— 只存正文的话，
   * 下一次命中缓存就分不出「可以内联的 markdown」和「只能给链接的 reactive」。
   * 兼容旧响应时缺省按 markdown（见 load 里的说明）；认不出的值不给。
   */
  format?: ContentFormat | null;
  version?: string;
  error?: boolean;
  id?: string;
  url?: string;
  /** 仅 vote：小组件数据（探测那一条报文里的 `data`）。 */
  data?: VoteEmbedData;
}

/**
 * reactive 剪贴板在旧 Markdown 管线里的**唯一**合法形态：一个站内链接。
 *
 * 绝不内联源码：旧渲染器读不懂 reactive 语法，内联的结果是整段源码被当成
 * Markdown/HTML 重新解释（静默坏内容）。文案不掺标题等用户输入，id 再过滤一遍
 * 非字母数字字符 —— 这个字符串会被拼进 Markdown 再交给 marked。
 */
export function reactiveClipboardLink(id: string): string {
  const safeId = id.replace(/[^A-Za-z0-9]/g, '');
  return `[查看剪贴板](/clipboard/${safeId})`;
}

/**
 * 缓存容量上限（按条目数，逐出最旧）。
 *
 * 取 200 的由头：单篇正文替换名额是 50（MAX_BLOG_REF_ITEMS），编辑器会话里
 * 翻几份草稿也不容易碰到；而一条剪贴板正文最长 50000 字，200 条最坏约 10MB
 * 字符串 —— 再往上就是白留内存。
 */
export const RESOLVER_CACHE_CAP = 200;

export class ContentRefResolver {
  private entries = new Map<string, ResolvedRef>();
  private inflight = new Map<string, Promise<ResolvedRef | undefined>>();
  /**
   * 真实 HTTP 的并发闸门（**实例级**，上限 MAX_REF_CONCURRENCY）。
   * 挂在实例上而不是模块上：同一个 resolver 的多轮渲染会复用它，
   * 多轮同时在飞时并发仍封在 4 以内；不同 resolver 互不影响。
   */
  private schedule = createConcurrencyLimiter(MAX_REF_CONCURRENCY);

  /**
   * @param mode 见文件头「两种模式」。实例级固定，不随调用变。
   */
  constructor(private mode: ContentRefMode) {}

  /**
   * 取一条引用的解析结果。`undefined` = 「不替换、保留字面量」
   * （external 模式下剪贴板、投票与收藏夹均保留原文）。
   * 并发同键只发一次请求；失败不落异常，按各类的降级口径落缓存。
   */
  resolve(type: ContentRefType, id: string): Promise<ResolvedRef | undefined> {
    const key = `${type}:${id}`;
    const hit = this.entries.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    // 拼 URL（图床）与查字典（对外视图）的**不占并发名额** —— 它们不发请求。
    const task = (): Promise<ResolvedRef | undefined> => this.load(type, id);
    const started = this.needsSlot(type) ? this.schedule(task) : task();
    const p = started
      .catch((): ResolvedRef | undefined => undefined)
      .then((entry) => {
        // 只清理「还是自己」的那一格：同键的新请求可能已经换上去了，
        // 无条件 delete 会把新请求从表里摘掉，并发去重随即失效（同一资源发两次）。
        if (this.inflight.get(key) === p) this.inflight.delete(key);
        if (entry) this.store(key, entry);
        return entry;
      });
    this.inflight.set(key, p);
    return p;
  }

  /**
   * 这一格要不要占并发名额：**只有真正会发 HTTP 的**才占。
   *   · 图床 —— 两种模式都只是拼 `/api/images/<id>/raw`，不发请求；
   *   · 对外视图 —— 剪贴板、投票 / 收藏夹直接 undefined，一个请求都不发。
   * 判错（把不发请求的也塞进闸门）不会报错，只是白占名额、让真取数变慢。
   */
  private needsSlot(type: ContentRefType): boolean {
    return type !== 'image' && this.mode === 'expand';
  }

  private store(key: string, entry: ResolvedRef): void {
    this.entries.set(key, entry);
    while (this.entries.size > RESOLVER_CACHE_CAP) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private async load(type: ContentRefType, id: string): Promise<ResolvedRef | undefined> {
    if (type === 'image') {
      // 图床两种模式都只是拼 URL：raw 路由匿名可达、逐条判该不该给（私有档 404）。
      return { type: 'image', url: `/api/images/${id}/raw` };
    }

    if (type === 'clipboard') {
      if (this.mode === 'external') return undefined;
      try {
        const res = await fetch(`/api/clipboard/${id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('failed');
        const data = (await res.json()) as {
          clip?: { content?: unknown; format?: unknown; version?: unknown };
          content?: unknown;
        };
        const content =
          typeof data.clip?.content === 'string'
            ? data.clip.content
            : typeof data.content === 'string'
              ? data.content
              : '';
        // 兼容未带 format 的旧响应（同一部署里不会出现，但测试桩/旧缓存可能）；
        // 带了一个**认不出**的值时绝不猜成 markdown —— 只给链接。
        const rawFormat = data.clip?.format;
        const version = typeof data.clip?.version === 'string' ? data.clip.version : undefined;
        const format =
          rawFormat === undefined
            ? 'markdown'
            : parseContentFormat(rawFormat);
        if (format !== 'markdown') {
          return { type: 'clipboard', content: reactiveClipboardLink(id), format, version };
        }
        return { type: 'clipboard', content, format, version };
      } catch {
        return { type: 'clipboard', content: clipboardFailureText(id) };
      }
    }

    if (type === 'vote') {
      // 对外视图不请求（那条接口要 core+ 会话，匿名去问只有 401），保留字面量。
      if (this.mode === 'external') return undefined;
      try {
        const res = await fetch(`/api/votes/${id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('failed');
        const json = (await res.json()) as { code?: number; data?: VoteEmbedData };
        // 成败判据与以前**一模一样**（响应 ok 就不算失败）；这里只是**不再把报文丢掉**
        // —— 小组件读的就是同一份数据，编辑器预览因此不必再拉第二条。
        // 报文里没有可用数据（code 不是 200 / 缺 data）时照旧返回「成功但无数据」，
        // 由小组件自己走到兜底链接，与改动前逐字一致。
        return json?.code === 200 && json.data ? { type: 'vote', data: json.data } : { type: 'vote' };
      } catch {
        return { type: 'vote', error: true, id };
      }
    }

    // favorite —— 拉 spider 那条公开读路径（**需 core+**）。'expand' 的调用点都在
    // requireCoreUser() 之后且 fetch 带 same-origin 凭据，所以会话一定在。
    // 'external' 下不请求（会 401），保字面量。取不到（不存在 / 私密 / 已软删 /
    // 网络错误）一律降级成失败文案，静默不抛。
    if (this.mode === 'external') return undefined;
    try {
      const res = await fetch(`/api/spider/favorites/${id}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      return {
        type: 'favorite',
        content: buildFavoriteCardHtml({
          id,
          title: typeof data.title === 'string' ? data.title : '',
          count: typeof data.count === 'number' ? data.count : 0,
          author: typeof data.author === 'string' ? data.author : undefined,
          blogs: Array.isArray(data.blogs)
            ? data.blogs
                .filter((b: unknown): b is { id: string; title: string } => {
                  const o = b as { id?: unknown; title?: unknown };
                  return typeof o?.id === 'string' && typeof o?.title === 'string';
                })
                .slice(0, MAX_CARD_ITEMS)
            : [],
        }),
      };
    } catch {
      return { type: 'favorite', content: favoriteFailureText(id) };
    }
  }
}
