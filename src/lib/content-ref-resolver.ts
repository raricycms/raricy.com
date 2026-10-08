// ─────────────────────────────────────────────────────────────────────────────
// content-ref-resolver.ts — 博客 / 剪贴板正文 `[@…]` 引用的**取数与缓存层**
//
// 【职责边界】只回答「这条引用取到了什么」，**不**决定整篇替换位置、顺序与预算 ——
// 那是 content-ref-processor.ts 的事（盖码扫描 / 按区间切片 / MAX_BLOG_REF_ITEMS）。
// 本模块只被它与编辑器预览使用；别往里塞 Markdown 处理。
//
// 【两种模式，不是「展开 / 不展开」】
//   · 'expand'   —— 站内成员视图：带 same-origin 凭据请求三条 core+ 接口
//     （剪贴板正文 / 投票存在性探测 / 收藏夹卡片数据），图床永远只是拼 URL。
//   · 'external' —— 对外视图：**一个请求都不发**。剪贴板只认服务端随 payload
//     下发的公开档（externalClips，clipboard-service.resolvePublicClipRefs 判过），
//     投票与收藏夹一律 undefined（保留字面量 —— 两者读口都是 core+，且投票箱
//     不进对外视图是站长定的口径）。
//   判据是「这条引用的读口匿名取不取得到」，见 docs/architecture.md §7.3。
//
// 【缓存语义】
//   · 键 = `${type}:${id}`；模式在建实例时定死，不混键。
//   · 并发同键复用同一个 in-flight Promise —— 同一资源一次渲染里的多处引用、
//     以及编辑器预览的连续重渲染，都不会重复请求。
//   · 失败也缓存（降级文案 / 错误标记）：不在每次按键时重试。手动「刷新预览」
//     调 invalidate() 清空后才会重新请求 —— 401 / 403 不会被上一份成功缓存
//     掩盖，因为刷新先清缓存再渲染。
//   · invalidate() 是**代际切换**（见下面 generation）：已落账条目与在飞请求
//     一起作废。旧代请求仍会落地，但**既不写回缓存、也不动新代的 in-flight 表**。
//     ⚠️ 这里曾经只清 entries、保留在飞请求，注释还写着「旧响应可以充实合法缓存」
//     —— 接上编辑器「刷新预览」后那是错的：刷新前发出的那条请求拿的是**刷新前的
//     服务端状态**（比如引用方刚把剪贴板从私有改成公开），它落地时会把刚刚重取的
//     新结果覆盖回旧的，于是「刷新」看起来按了没用，且只在竞态窗口里复现。
//     「旧响应不得覆盖较新的预览」那一半仍由渲染层的 cancelled/generation 守卫
//     负责 —— 本层只保证**缓存里存的一定是本代取到的数**。
//   · 容量有上限（逐出最旧）。一篇正文的替换名额由 MAX_BLOG_REF_ITEMS 封顶，
//     但**去重后的 id 集合**可以超过它；编辑器会话级缓存还会跨多份草稿累积。
//     逐出只是多一次重取，不影响正确性。
//   · **真实并发有上限**（MAX_REF_CONCURRENCY，实例级闸门）：同一时刻在飞的
//     HTTP 最多 4 条。整篇的引用是一次性 `Promise.all` 交下来的，没有闸门就是
//     「一篇塞满引用的正文同时打出几十条请求」。**图床（只拼 URL）与对外视图
//     （查字典、不发请求）不排队** —— 见 needsSlot。排队期间被 invalidate() 的
//     请求**不再发出**（它拿的是过期状态），但**排队等着的那个 await 一定会 settle**
//     （按「这一格取不到」兑现），不会挂死。
// ─────────────────────────────────────────────────────────────────────────────

import type { VoteEmbedData } from '@/lib/blog-markdown';
import {
  MAX_REF_CONCURRENCY,
  clipboardFailureText,
  createConcurrencyLimiter,
} from '@/lib/content-refs';
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
  error?: boolean;
  id?: string;
  url?: string;
  /** 仅 vote：小组件数据（探测那一条报文里的 `data`）。 */
  data?: VoteEmbedData;
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
   * 代际计数器 —— 每次 invalidate() 自增。请求落地时对不上这一格就丢弃结果。
   * 没有它，「刷新预览」期间的在飞请求会把刷新前的旧数据写回刚清干净的缓存。
   */
  private generation = 0;
  /**
   * 真实 HTTP 的并发闸门（**实例级**，上限 MAX_REF_CONCURRENCY）。
   * 挂在实例上而不是模块上：编辑器预览那个共享 resolver 会跨多轮渲染复用它，
   * 多轮同时在飞时并发仍封在 4 以内；不同 resolver 互不影响。
   */
  private schedule = createConcurrencyLimiter(MAX_REF_CONCURRENCY);

  /**
   * @param mode          见文件头「两种模式」。实例级固定，不随调用变。
   * @param externalClips 'external' 下**服务端预先解析好**的公开剪贴板（id → 正文）。
   */
  constructor(
    private mode: ContentRefMode,
    private externalClips: Record<string, string> = {}
  ) {}

  /**
   * 取一条引用的解析结果。`undefined` = 「不替换、保留字面量」
   * （external 模式下不在下发表里的剪贴板、以及 external 模式的投票 / 收藏夹）。
   * 并发同键只发一次请求；失败不落异常，按各类的降级口径落缓存。
   */
  resolve(type: ContentRefType, id: string): Promise<ResolvedRef | undefined> {
    const key = `${type}:${id}`;
    const hit = this.entries.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const gen = this.generation;
    const task = (): Promise<ResolvedRef | undefined> => {
      // ★ 排队期间被刷新了就不发了 ★ 这条请求拿的是刷新**之前**那一刻的服务端状态，
      // 发出去也只是白发（结果一样会被判过期）。直接按「这一格取不到」兑现 ——
      // 调用方是旧代那一轮，本来就要丢它；关键是**排队等着的 await 一定 settle**，
      // 绝不挂死。还没开工的请求就这么消失，已经在飞的那条走正常流程。
      if (gen !== this.generation) return Promise.resolve(undefined);
      return this.load(type, id);
    };
    // 拼 URL（图床）与查字典（对外视图）的**不占并发名额** —— 它们不发请求。
    const started = this.needsSlot(type) ? this.schedule(task) : task();
    const p = started
      .catch((): ResolvedRef | undefined => undefined)
      .then((entry) => {
        // 只清理「还是自己」的那一格：刷新后同键可能已经换成新代的请求，
        // 无条件 delete 会把新请求从表里摘掉，并发去重随即失效（同一资源发两次）。
        if (this.inflight.get(key) === p) this.inflight.delete(key);
        // 刷新之后落地的旧代结果直接丢弃 —— 它是刷新前那一刻的服务端状态。
        if (gen === this.generation && entry) this.store(key, entry);
        return entry;
      });
    this.inflight.set(key, p);
    return p;
  }

  /**
   * 这一格要不要占并发名额：**只有真正会发 HTTP 的**才占。
   *   · 图床 —— 两种模式都只是拼 `/api/images/<id>/raw`，不发请求；
   *   · 对外视图 —— 剪贴板查下发表、投票 / 收藏夹直接 undefined，一个请求都不发。
   * 判错（把不发请求的也塞进闸门）不会报错，只是白占名额、让真取数变慢。
   */
  private needsSlot(type: ContentRefType): boolean {
    return type !== 'image' && this.mode === 'expand';
  }

  /**
   * 同步读**已落账**的那一份 —— 只在「这一格刚 resolve 过、且中间没人作废 / 淘汰」
   * 时才等于这一轮取到的结果。
   *
   * ⚠️ **`await resolve()` 本身不保证随后 peek 就有东西**：resolve 的**返回值**才是
   * 那一刻的真值，写不写进 entries 是另一回事 ——
   *   · 期间有人 `invalidate()`（点「刷新引用」、另一次预览渲染起来）→ entries 被清空，
   *     而且在飞的旧代结果落地时被判过期、**根本不写回来**；
   *   · 超过 `RESOLVER_CACHE_CAP` → 最早那几格被淘汰；
   *   · 这一格本来就取不到（403 降级 / 网络失败）→ 没有 entry 可读。
   * 所以替换阶段**不吃这条捷径**：`ContentRefProcessor.preprocessRound` 把本轮
   * resolve 的返回值收进 `entries` 一并交出来，导出与预览都用那一份。
   * 这个方法留给「要用的是缓存本身」的地方（测试断言缓存状态），
   * 别拿它当「刚取过就一定读得到」。
   */
  peek(type: ContentRefType, id: string): ResolvedRef | undefined {
    return this.entries.get(`${type}:${id}`);
  }

  /**
   * 「刷新预览」：作废本代全部结果，下一次 resolve 重新取数。
   *
   * 三件事一起做，缺一不可：
   *   · 代际 +1     —— 在飞的旧请求落地时被判为过期，不写回缓存；
   *   · 清 entries  —— 已落账的（含 403 降级文案）不再命中，真正重取；
   *   · 清 inflight —— 否则下一次 resolve 会拿到**刷新前**发出去的那条 Promise，
   *     压根不重取，等于刷新石沉大海。
   */
  invalidate(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
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
      if (this.mode === 'external') {
        // 服务端已替我们判过公开档：在表里的直接当内容用；不在表里的
        // （私有 / 已软删 / 不存在同形）保持字面量。**不缓存 undefined** ——
        // 同一篇的 payload 不变，重查一次字典没有成本，缓存它反而挡住
        // 「调用方随后补了一张更大的表」这种合法用法。
        const content = this.externalClips[id];
        return content === undefined ? undefined : { type: 'clipboard', content };
      }
      try {
        const res = await fetch(`/api/clipboard/${id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        return { type: 'clipboard', content: data.clip?.content ?? data.content ?? '' };
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
