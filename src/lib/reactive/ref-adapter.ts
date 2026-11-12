// ─────────────────────────────────────────────────────────────────────────────
// ref-adapter.ts — `[@…]` 站点引用 → ReactiveMD 宿主组件的**纯适配层**
//
// 【职责】把作者源码里的五类引用改写成新渲染器认得的东西，并把渲染它们所需的
// 数据**在同一次调用里**一起交出来：
//
//   图床（10 位 / 旧语法）→ Markdown `![id](/api/images/id/raw)`（不用宿主组件）
//   音频 `[@音频/<10位>]`  → `<site-embed kind="audio" ref="…" />` + hostData
//   投票（9 位）           → `<site-embed kind="vote" ref="…" />` + hostData
//   收藏夹（6 位数字）      → `<site-embed kind="favorite" ref="…" />` + hostData
//   剪贴板（8 位）          → `<site-embed kind="clipboard" ref="…" />` + hostData
//   历史 HTML 音视频        → compat 的 `[[媒体/<10 hex>]]` → `media` kind + hostData
//
// 【不是渲染器，也不是取数层】本模块不 import prisma、不发 HTTP、不碰 React。
// `resolve` 是调用方按当前权限上下文注入的 `ReferenceReader`（阅读页是
// ref-reader.ts 的 createServiceReferenceReader，编辑器预览是 client-compile.ts
// 的客户端 reader）；对外视图则一个请求都不发，也不读剪贴板、投票与收藏夹，
// 只展开图床与音频 —— 两档因此得到不同但都正确的适配结果。
//
// ── 六条「错了也不报错」的纪律 ────────────────────────────────────────────────
//
// 【1】代码块与行内代码里的 token **绝不展开**。扫描跑在 `maskMarkdownCode` 的
//   盖码副本上（与音频收集器、版本指令扫描同一口径）—— 这是
//   《内容引用语法指南》对读者的承诺。输出阶段只切原文，盖码副本只用于定位。
//
// 【2】作者伪造的 `<site-embed` 必须**在盖码之后**转义成 `&lt;site-embed`。否则
//   作者手打一个标签就能让站点把它当合法宿主节点（随后因缺数据渲染成
//   `local-host-unavailable` 占位）。代码块里的同形文本原样保留。
//
// 【3】标签与数据**原子成对**。发了 `<site-embed>` 却没写 hostData 键，ReactiveMD
//   会渲染一行可见占位（不是白屏，但也是坏页面）；反过来有数据没标签只是白算。
//   所以两者在同一个分支里决定，缺数据时**保留字面量 token**，不发标签。
//
// 【4】预算与既有口径一致：图片/投票/剪贴板共 50 处替换，收藏夹另 3 处；50 次取数
//   （`MAX_REF_FETCHES`，按 `${kind}:${ref}` 去重）、4 并发
//   （`MAX_REF_CONCURRENCY`）、展开后总长 50 万字符（`MAX_REF_EXPAND_CHARS`）、
//   音频最多 3 条（由 `collectAudioRefs` 自带）。图片与音频**不取数**。
//   超预算 / 取不到的那一处**保留字面量**，绝不吃掉后面那些取得到的名额。
//
// 【5】单个引用失败只影响它自己（`resolve` 抛错 / 返回 undefined → 保留 token），
//   绝不整篇回退，也绝不因为一个坏 token 丢掉正文 —— 输出是逐段拼的，任何一段
//   没被接受就原样留在 `source` segment 里。
//
// 【6】剪贴板**不把正文拼进父源码**。Markdown 子剪贴板在 expand 下会生成一份
//   独立的同版本静态产物（compat → external 适配 → 同一组编译选项），放在
//   hostData 的 `document` / `hostData` 两格里；父文档只拿到 `<site-embed>` 标签。
//   子正文按 Markdown 语义单独编译，代码屏蔽与伪造标签转义都在它自己的那趟里完成，
//   **不递归读取**私有资源（子适配固定 external），绑定 / 表达式也不会进入父作用域。
//   Reactive 子剪贴板仍只给链接卡片（不嵌套 Reactive 运行时）；external 视图
//   对剪贴板保留字面量，因此快照里永远没有子产物。
//
// 数字 token 保留旧博客管线的宽松形态 `\[@\s*(\w+)\s*\]`（内部空白、下划线都认），
// 按 id **长度**分流；具名音频 token 继续用 `audio-refs.ts` 自己的白名单正则。
// 两套正则都不会把中文吃成数字 id，所以合并时不会重叠。
//
// 本模块零 DOM / 零 React / 零 prisma，可直接单测
// （tests/unit/reactive-ref-adapter.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import {
  compileLocal,
  LOCAL_SYNTAX_VERSION,
  localCompileOptionsKey,
  type LocalDocument,
} from 'reactive-md';
import {
  CLIPBOARD_ID_LEN,
  IMAGE_ID_LEN,
  MAX_BLOG_REF_ITEMS,
  MAX_REF_CONCURRENCY,
  MAX_REF_EXPAND_CHARS,
  MAX_REF_FETCHES,
  VOTE_ID_LEN,
  createConcurrencyLimiter,
} from '@/lib/content-refs';
import { collectAudioRefs } from '@/lib/audio-refs';
import { isFavoriteId, maskMarkdownCode, MAX_FAVORITE_REFS } from '@/lib/favorite-refs';
import { applyLegacyHtmlCompat, LEGACY_COMPAT_VERSION } from './legacy-compat';
import {
  REACTIVE_COMPILER_VERSION,
  REACTIVE_COMPILE_OPTIONS,
} from './host-components';
import { literalizeReactiveSyntax } from './detect-format';
import {
  checkSyntaxBudget,
  MAX_UNCLOSED_INTERPOLATIONS,
  MAX_UNCLOSED_TAGS,
} from './syntax-budget';
import { BoundedLruCache } from './bounded-cache';
import type {
  DataImageSource,
  ReferenceKind,
  ReferenceMode,
  ReferenceReader,
  ReferenceSlot,
  ResolvedReference,
  SiteEmbedData,
  SiteEmbedKind,
  SiteHostData,
  SiteMediaPayload,
  SiteMediaSources,
} from './ref-types';

/**
 * 适配器版本。进缓存键（见 docs/plan/reactive-md-migration-plan.md §5.3）。
 * **每次改变输出形状或转义规则都必须递增** —— 否则旧缓存会继续发一份
 * 按旧规则生成的源码。
 */
export const ADAPTER_VERSION = 'reactive-ref-adapter/5';

/**
 * site-embed 的 ref 属性必须与宿主 schema 的 pattern 一致（`^[A-Za-z0-9]{1,32}$`，
 * 见计划 D1）。不匹配的 id（旧语法里的下划线）保留字面量：发了标签也只会得到
 * `local.host.attribute` 诊断，不如不换。
 */
const EMBED_REF_RE = /^[A-Za-z0-9]{1,32}$/;

/** 旧博客管线的数字引用形态：内部空白与 `\w`（含下划线）都认。 */
const NUMERIC_REF_PATTERN = /\[@\s*(\w+)\s*\]/g;

/** 兼容层为受限 data 位图生成的短 token（24 位十六进制内容寻址）。 */
const DATA_IMAGE_PATTERN = /\[@图片\/([a-f0-9]{24})\]/g;

/**
 * 兼容层为历史 HTML 音视频生成的短 token。
 *
 * 固定 10 位十六进制：token 总长 17，最短的可播放成对区块（约 21 字符）也装得下，
 * compat 因此能保持**等长改写**。用 `[[媒体:…]]` 而不是 `[@媒体/…]`，避免落进
 * 表情 `[@合集/表情]` 的命名空间。
 */
const MEDIA_TOKEN_PATTERN = /\[\[媒体:([a-f0-9]{10})\]\]/g;

/** 作者伪造的宿主标签前缀（只匹配到标签名，尖括号随后被转义）。 */
const FORGED_EMBED_PATTERN = /<site-embed(?=[\s/>])/gi;

export interface ReactiveAdaptOptions {
  mode: ReferenceMode;
  /** 兼容层提取的受限 data 位图；只由 token 引用，不自行扫描。 */
  dataImages?: Readonly<Record<string, DataImageSource>>;
  /**
   * 兼容层提取的历史 HTML 音视频（`[[媒体:<10 hex>]]` → `media` kind）。
   *
   * **external 也要带上**：URL 已在 compat 里过策略，不含成员私有载荷；
   * 渲染权限仍由原资源路由判。缺键时 token 保留字面量。
   * 直接读 `compat.mediaSources`（`LegacyCompatResult` 的必填字段）——
   * 原先的 `compatMediaSources` 前向桥已无必要（R3-130）。
   */
  mediaSources?: SiteMediaSources;
  /** `expand` 模式下的取数函数。`external` 模式**绝不调用**它。 */
  resolve?: ReferenceReader;
  /**
   * 真实取数的并发闸门（R3-103）。
   *
   * 不传 = 本次适配自建一个（单次适配峰值 ≤ `MAX_REF_CONCURRENCY`，与旧行为一致）。
   * **同一页面上多处适配并发时必须传同一个**：编辑器预览与导出各自调一次
   * `adaptReactiveReferences`，各建一个闸门就让「同一时刻最多 4 条真实请求」的承诺
   * 退化成 2×4。共享的那一个由调用方持有（client-compile.ts 的模块级闸门）。
   */
  scheduler?: ReturnType<typeof createConcurrencyLimiter>;
}

export interface ReactiveAdaptResult {
  adaptedSource: string;
  /** 键 = `${kind}:${ref}`，与 `<site-embed>` 的 `kind` / `ref` 属性一一对应。 */
  hostData: SiteHostData;
}

/** 一处输出改写：原文 `[start, end)` → `text`。 */
interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

function classifyNumericRef(ref: string): ReferenceKind | null {
  // 顺序与旧管线一致：先按长度分流，6 位再要求纯数字（`isFavoriteId`）。
  // 8 位全数字也是剪贴板 —— 长度优先，别让「收藏夹」把 8 位数字抢走。
  if (ref.length === IMAGE_ID_LEN) return 'image';
  if (ref.length === CLIPBOARD_ID_LEN) return 'clipboard';
  if (ref.length === VOTE_ID_LEN) return 'vote';
  if (isFavoriteId(ref)) return 'favorite';
  return null;
}

function scanMasked(source: string, masked: string): ReferenceSlot[] {
  const slots: ReferenceSlot[] = [];

  const re = new RegExp(NUMERIC_REF_PATTERN.source, 'g');
  for (const m of masked.matchAll(re)) {
    const ref = m[1];
    const kind = classifyNumericRef(ref);
    if (!kind) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    slots.push({ kind, ref, token: source.slice(start, end), start, end });
  }

  // 兼容层生成的受限 data 位图 token。它们只可能来自 Immutable 的 compat 输出，
  // 内容寻址 id 必须与 compat 的 24 位十六进制一致。
  for (const m of masked.matchAll(new RegExp(DATA_IMAGE_PATTERN.source, 'g'))) {
    const ref = m[1];
    const start = m.index ?? 0;
    slots.push({ kind: 'image', ref, token: source.slice(start, start + m[0].length), start, end: start + m[0].length });
  }

  // 兼容层生成的历史 HTML 音视频 token。与 data 位图同一条纪律：只认 compat
  // 写在原文里的固定形状，代码块里同形文本不展开（扫描跑在盖码副本上）。
  for (const m of masked.matchAll(new RegExp(MEDIA_TOKEN_PATTERN.source, 'g'))) {
    const ref = m[1];
    const start = m.index ?? 0;
    slots.push({
      kind: 'media',
      ref,
      token: source.slice(start, start + m[0].length),
      start,
      end: start + m[0].length,
    });
  }

  // 音频走现有 collector：它自带 `MAX_AUDIO_REFS=3`，且白名单字符集与
  // `audio-refs.ts` 的对外承诺一致。`match` 取自原文，两边等长。
  for (const audio of collectAudioRefs(source, masked)) {
    slots.push({
      kind: 'audio',
      ref: audio.id,
      token: audio.match,
      start: audio.start,
      end: audio.start + audio.match.length,
    });
  }

  // 原文顺序是预算与占位的唯一依据。同一位置不会同时被两套正则命中，
  // 但仍按 end 做次级排序，保证输出完全确定。
  slots.sort((a, b) => a.start - b.start || a.end - b.end);
  return slots;
}

/**
 * 扫出正文里所有受支持的 `[@…]` 引用（代码块 / 行内代码里的不算）。
 *
 * 返回的是**候选**，不是「一定会被展开」的集合：预算、权限、数据缺失都在
 * `adaptReactiveReferences` 里逐条判。这里保持零 I/O、纯函数。
 */
export function scanReactiveReferences(source: string): ReferenceSlot[] {
  return scanMasked(source, maskMarkdownCode(source));
}

function normalizeStatus(value: unknown): ResolvedReference['status'] {
  return value === 'ready' || value === 'error' || value === 'forbidden' ? value : 'error';
}

function normalizeResolved(raw: ResolvedReference | undefined): ResolvedReference | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return { ...raw, status: normalizeStatus(raw.status) };
}

/**
 * 选出**需要取数**的引用：`expand` 模式下的剪贴板 / 投票 / 收藏夹。
 *
 * 图床只拼 URL、音频自带 id（raw 路由逐条判权），两者都不发请求，因此不占
 * `MAX_REF_FETCHES` 名额 —— 与旧管线的 `needsSlot` 同一条判据。`external`
 * 模式一个请求都不发，候选集为空。
 */
function collectCandidates(
  slots: readonly ReferenceSlot[],
  mode: ReferenceMode
): Map<string, ReferenceSlot> {
  const candidates = new Map<string, ReferenceSlot>();
  if (mode !== 'expand') return candidates;
  for (const slot of slots) {
    if (slot.kind !== 'clipboard' && slot.kind !== 'vote' && slot.kind !== 'favorite') continue;
    const key = `${slot.kind}:${slot.ref}`;
    if (candidates.has(key)) continue;
    if (candidates.size >= MAX_REF_FETCHES) break;
    candidates.set(key, slot);
  }
  return candidates;
}

/**
 * 按闸门取数（默认上限 4 并发）；单条失败 / 抛错一律折算成 `undefined`，保留字面量。
 *
 * 闸门由调用方注入（`options.scheduler`）—— 预览 + 导出这类同页多处适配共用同一个，
 * 十几处引用同时展开时真实 HTTP 仍封在 `MAX_REF_CONCURRENCY` 条（R3-103）。
 * 没注入时按本次适配自建一个：单次适配的峰值上限不变，只是不跨适配共享。
 */
async function resolveCandidates(
  candidates: ReadonlyMap<string, ReferenceSlot>,
  reader: ReferenceReader | undefined,
  scheduler?: ReturnType<typeof createConcurrencyLimiter>
): Promise<Map<string, ResolvedReference | undefined>> {
  const resolved = new Map<string, ResolvedReference | undefined>();
  const entries = [...candidates.entries()];
  if (!reader || entries.length === 0) {
    for (const [key] of entries) resolved.set(key, undefined);
    return resolved;
  }

  const schedule = scheduler ?? createConcurrencyLimiter(MAX_REF_CONCURRENCY);
  // 先落成 const：闭包里用收窄后的参数在某些 TS 配置下不被保留。
  const read = reader;
  const results = await Promise.all(
    entries.map(([, slot]) =>
      schedule(() => Promise.resolve().then(() => read(slot))).catch(() => undefined)
    )
  );
  entries.forEach(([key], index) => resolved.set(key, normalizeResolved(results[index])));
  return resolved;
}

function embedTag(kind: SiteEmbedKind, ref: string): string | null {
  if (!EMBED_REF_RE.test(ref)) return null;
  // 块级嵌入：标签独占一行（计划 §M3）。前后各留一个换行，避免与紧邻的文字
  // 粘成同一段；Markdown 本来就会把多余空行折叠，不会在页面上多出空白。
  return `\n<site-embed kind="${kind}" ref="${ref}" />\n`;
}

function makeEmbedData(
  kind: SiteEmbedKind,
  ref: string,
  resolved: ResolvedReference,
  includeBody: boolean
): SiteEmbedData {
  const data: SiteEmbedData = { kind, ref, status: resolved.status };
  if (resolved.title !== undefined) data.title = resolved.title;
  if (resolved.format !== undefined) data.format = resolved.format;
  if (resolved.version !== undefined) data.version = resolved.version;
  if (includeBody) {
    if (resolved.content !== undefined) data.content = resolved.content;
    if (resolved.payload !== undefined) data.payload = resolved.payload;
  }
  return data;
}

interface PlannedReplacement {
  text: string;
  data?: SiteEmbedData;
}

/** hostData 里 media payload 的最小形状检查；完整 URL / 属性白名单在渲染器。 */
function isSiteMediaPayload(value: unknown): value is SiteMediaPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<SiteMediaPayload>;
  if (payload.media !== 'video' && payload.media !== 'audio') return false;
  const hasSrc = typeof payload.src === 'string' && payload.src.length > 0;
  const hasSources =
    Array.isArray(payload.sources) &&
    payload.sources.some(
      (source) => source && typeof source.src === 'string' && source.src.length > 0
    );
  return hasSrc || hasSources;
}

/**
 * 把**一处** token 变成输出文本（以及可能的 hostData）。返回 `null` = 保留字面量。
 * 这一处不判预算；各类别显示预算由调用方统一执行，顺序才与旧管线一致。
 */
function planReplacement(
  slot: ReferenceSlot,
  mode: ReferenceMode,
  resolvedByKey: ReadonlyMap<string, ResolvedReference | undefined>,
  dataImages: Readonly<Record<string, DataImageSource>>,
  mediaSources: SiteMediaSources
): PlannedReplacement | null {
  if (slot.kind === 'image') {
    const image = dataImages[slot.ref];
    if (image) {
      const tag = embedTag('image', slot.ref);
      if (!tag) return null;
      return {
        text: tag,
        data: {
          kind: 'image',
          ref: slot.ref,
          status: 'ready',
          payload: {
            src: image.url,
            alt: image.alt,
            ...(image.width ? { width: image.width } : {}),
            ...(image.height ? { height: image.height } : {}),
          },
        },
      };
    }
    // 只拼 URL，不取数。raw 路由逐条判权（私有档 404），与旧管线逐字一致。
    return { text: `![${slot.ref}](/api/images/${slot.ref}/raw)` };
  }

  if (slot.kind === 'audio') {
    // 音频不需要取数：id 就是地址，权限由 /api/audio/<id>/raw 判。
    // 但**必须**同时给 hostData，否则 ReactiveMD 渲染占位。
    const tag = embedTag('audio', slot.ref);
    if (!tag) return null;
    return { text: tag, data: { kind: 'audio', ref: slot.ref, status: 'ready' } };
  }

  if (slot.kind === 'media') {
    // 历史 HTML 音视频：数据只来自 compat 的 mediaSources（正文派生、纯 JSON），
    // **不取数、不读成员资源**。external 与 expand 都展开；缺条目保留字面量 token。
    const media = mediaSources[slot.ref];
    if (!isSiteMediaPayload(media)) return null;
    const tag = embedTag('media', slot.ref);
    if (!tag) return null;
    return {
      text: tag,
      data: { kind: 'media', ref: slot.ref, status: 'ready', payload: media },
    };
  }

  const key = `${slot.kind}:${slot.ref}`;

  if (slot.kind === 'clipboard') {
    if (mode === 'external') return null;
    const resolved = resolvedByKey.get(key);
    if (!resolved) return null;
    const tag = embedTag('clipboard', slot.ref);
    if (!tag) return null;
    // 内联与否由**子剪贴板格式**决定，与父文档是 Markdown 还是 Reactive 无关：
    // 普通 Markdown 追加组件后 format 会自动升为 reactive，若这时改成链接卡片，
    // 同一篇正文保存前后的阅读结果就变了。Reactive 子剪贴板仍只给链接卡片
    // （不嵌套 Reactive 运行时）；Markdown 子正文由宿主单独渲染，字面表达式不会
    // 进入父文档绑定作用域。
    const inline =
      resolved.format === 'markdown' && typeof resolved.content === 'string';
    return { text: tag, data: makeEmbedData('clipboard', slot.ref, resolved, inline) };
  }

  // vote / favorite：对外视图保持字面量（两条读口都要 core+，且投票箱不进对外视图）。
  // 计划 M3 的 external 口径：投票 / 收藏夹**一个请求都不发**。
  if (mode !== 'expand') return null;
  const resolved = resolvedByKey.get(key);
  if (!resolved) return null;
  const tag = embedTag(slot.kind, slot.ref);
  if (!tag) return null;
  return { text: tag, data: makeEmbedData(slot.kind, slot.ref, resolved, true) };
}

/** 内联 Markdown 子剪贴板的静态产物（与详情页同一套 compat / options）。 */
export interface InlineMarkdownArtifact {
  document: LocalDocument;
  hostData: SiteHostData;
}

/** 产物形状版本：改 `InlineMarkdownArtifact` 形状时递增，别只依赖 ADAPTER_VERSION。 */
const INLINE_ARTIFACT_VERSION = 'inline-artifact/1';

/**
 * 子编译缓存键的身份段。**所有会改变产物的版本都在这里**：
 * adapter（本文件输出形状）/ compat（历史 HTML 规则）/ 编译器 / 语法版本 / 选项键。
 * 漏一段就会静默命中「另一次编译」的产物。
 */
const INLINE_CACHE_IDENTITY = [
  INLINE_ARTIFACT_VERSION,
  ADAPTER_VERSION,
  LEGACY_COMPAT_VERSION,
  REACTIVE_COMPILER_VERSION,
  LOCAL_SYNTAX_VERSION,
  localCompileOptionsKey(REACTIVE_COMPILE_OPTIONS),
  // 预算阈值变了，旧的 null（超预算）不能继续命中。
  `${MAX_UNCLOSED_TAGS}:${MAX_UNCLOSED_INTERPOLATIONS}`,
].join('|');

const INLINE_CACHE_MAX_ENTRIES = 64;
const INLINE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

interface InlineCacheGlobal {
  __raricyInlineMarkdownCache?: BoundedLruCache<InlineMarkdownArtifact | null>;
}

/** 只估算有界性；失败返回 null = 不缓存（缓存失败绝不拖垮渲染）。 */
function estimateInlineArtifactBytes(value: InlineMarkdownArtifact | null): number | null {
  if (value === null) return 4;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized.length : null;
  } catch {
    return null;
  }
}

function getInlineCache(): BoundedLruCache<InlineMarkdownArtifact | null> {
  const g = globalThis as typeof globalThis & InlineCacheGlobal;
  if (!g.__raricyInlineMarkdownCache) {
    g.__raricyInlineMarkdownCache = new BoundedLruCache<InlineMarkdownArtifact | null>({
      maxEntries: INLINE_CACHE_MAX_ENTRIES,
      maxBytes: INLINE_CACHE_MAX_BYTES,
      sizeOf: estimateInlineArtifactBytes,
    });
  }
  return g.__raricyInlineMarkdownCache;
}

function inlineCacheKey(content: string): string {
  return `${INLINE_CACHE_IDENTITY}\u0000${content}`;
}

/** 仅测试：清空子编译缓存，避免用例之间共享同一份产物。 */
export function __resetInlineMarkdownCacheForTests(): void {
  const g = globalThis as typeof globalThis & InlineCacheGlobal;
  g.__raricyInlineMarkdownCache?.clear();
}

/** 仅测试 / 观测：当前缓存条数与近似占用。 */
export function inlineMarkdownCacheStats(): { entries: number; bytes: number } {
  const cache = getInlineCache();
  return { entries: cache.size, bytes: cache.bytes };
}

/**
 * 子正文的一趟完整准备：compat → external 引用适配 → 当前 Markdown 编译选项。
 *
 * 子正文和父正文一样必须先过共享的 `checkSyntaxBudget`；`compileLocal` 对海量
 * 未闭合 `<` / `{{` 是超线性的，而这段编译可能被 50k 的成员剪贴板内容触发。
 */
async function buildInlineMarkdown(source: string): Promise<{
  result: ReturnType<typeof compileLocal>;
  hostData: SiteHostData;
}> {
  const compat = applyLegacyHtmlCompat(source);
  // ★ 固定 external ★：子剪贴板里的剪贴板 / 投票 / 收藏夹 token 保持字面量，
  // 不递归取私有资源；图床 / 音频 / 历史媒体只拼地址或 id，权限仍由原路由判。
  const adapted = await adaptReactiveReferences(compat.source, {
    mode: 'external',
    dataImages: compat.dataImages,
    mediaSources: compat.mediaSources,
  });
  return {
    result: compileLocal(adapted.adaptedSource, REACTIVE_COMPILE_OPTIONS),
    hostData: adapted.hostData,
  };
}

/**
 * 把一段 Markdown 子正文编译成可随 hostData 下发的静态产物。
 *
 * 与阅读 Markdown 的容错顺序一致：首次失败时先字面化 `{{ }}` / 组件标签再编译一次，
 * 仍失败就返回 `null`（调用方退回链接卡片，绝不把源码塞进正文）。
 *
 * 只做**一层**：子适配是 external，剪贴板 token 不会被展开，因此这里不可能递归。
 *
 * 【缓存只放纯产物】键 = 内容 + adapter/compat/compiler/syntax/options；值是
 * `document` 与子 `hostData`（正文派生，不含任何成员权限数据）。父视图的 hostData
 * 与 runtime 绝不进这里。
 */
export async function prepareInlineMarkdownDocument(
  content: string
): Promise<InlineMarkdownArtifact | null> {
  if (typeof content !== 'string' || content.length === 0) return null;

  const cache = getInlineCache();
  const key = inlineCacheKey(content);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    // ★ 共享预算闸门 ★ 与 compile.ts / detect-format.ts 同一条规则；命中即
    // 明确不编译，返回 null 让调用方走链接卡片。
    if (checkSyntaxBudget(content)) {
      cache.set(key, null);
      return null;
    }

    let built = await buildInlineMarkdown(content);
    if (!built.result.ok) {
      const literal = literalizeReactiveSyntax(content);
      if (literal.changed) built = await buildInlineMarkdown(literal.source);
    }
    const artifact =
      built.result.ok
        ? { document: built.result.document, hostData: built.hostData }
        : null;
    cache.set(key, artifact);
    return artifact;
  } catch {
    // 子正文的任何失败只影响这一处：调用方看到 null，退回链接卡片。
    cache.set(key, null);
    return null;
  }
}

/**
 * 为已生成的剪贴板 hostData 补上子产物，并移除原始正文。
 *
 * 原始 `content` 只用于这一趟编译；继续留在 hostData 里既没有消费者，也会让一份
 * 私有正文随 RSC 多走一遍。`document` / `hostData` 必须成对写入；编译失败就都
 * 不写，渲染端看到的就是链接卡片。
 */
async function attachInlineMarkdownDocuments(
  hostData: Record<string, SiteEmbedData>
): Promise<void> {
  for (const data of Object.values(hostData)) {
    if (data.kind !== 'clipboard' || typeof data.content !== 'string') continue;
    const content = data.content;
    // 原始正文只用于这一趟编译，任何状态下都不随 hostData 下发。
    delete data.content;
    if (data.status !== 'ready' || data.format !== 'markdown' || content.length === 0) continue;
    const artifact = await prepareInlineMarkdownDocument(content);
    if (!artifact) continue;
    data.document = artifact.document;
    data.hostData = artifact.hostData;
  }
}

/** 作者伪造的宿主标签：盖码后定位，只转义开头的 `<`。 */
function collectForgedEmbedEdits(source: string, masked: string): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const re = new RegExp(FORGED_EMBED_PATTERN.source, 'gi');
  for (const m of masked.matchAll(re)) {
    const at = m.index ?? 0;
    if (at < 0 || at >= source.length) continue;
    edits.push({ start: at, end: at + 1, text: '&lt;' });
  }
  return edits;
}

/** 按 `[start, end) → text` 应用改写，返回适配后源码。 */
function assemble(source: string, edits: readonly SourceEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let adaptedSource = '';
  let cursor = 0;

  for (const edit of ordered) {
    // 防御：未知输入下万一出现重叠 / 越界，跳过它而不是破坏整篇。
    if (edit.start < cursor || edit.end > source.length || edit.start > edit.end) continue;
    if (edit.start > cursor) adaptedSource += source.slice(cursor, edit.start);
    adaptedSource += edit.text;
    cursor = edit.end;
  }

  if (cursor < source.length) adaptedSource += source.slice(cursor);
  return adaptedSource;
}

/**
 * 适配一篇正文：扫描 → 取数（仅 expand）→ 逐处替换 / 转义 → 产出 hostData。
 * 永不抛「整篇失败」：任何一处引用出问题都只保留它的字面量。
 */
export async function adaptReactiveReferences(
  source: string,
  options: ReactiveAdaptOptions
): Promise<ReactiveAdaptResult> {
  const mode = options.mode;
  const masked = maskMarkdownCode(source);
  const slots = scanMasked(source, masked);

  const candidates = collectCandidates(slots, mode);
  const resolvedByKey = await resolveCandidates(candidates, options.resolve, options.scheduler);

  // 伪造标签的转义与预算无关 —— 那是安全改写，哪怕是超长正文也必须做。
  const edits: SourceEdit[] = collectForgedEmbedEdits(source, masked);

  const hostData: Record<string, SiteEmbedData> = {};
  const dataByKey = new Map<string, SiteEmbedData>();

  // 预算语义与旧管线一致：从原文长度起算，只累加**被接受**替换的净增；
  // 原文本身已超预算时一律不替换（保留原文，不再增长）。
  const sourceFits = source.length <= MAX_REF_EXPAND_CHARS;
  let used = source.length;
  let replaced = 0;
  let favoritesReplaced = 0;

  for (const slot of slots) {
    if (!sourceFits) break;
    // The legacy pipeline gives favorite and audio embeds their own budgets.
    if (slot.kind === 'favorite' && favoritesReplaced >= MAX_FAVORITE_REFS) continue;
    if (slot.kind !== 'favorite' && slot.kind !== 'audio' && replaced >= MAX_BLOG_REF_ITEMS) continue;

    const planned = planReplacement(
      slot,
      mode,
      resolvedByKey,
      options.dataImages ?? {},
      options.mediaSources ?? {}
    );
    if (!planned) continue;

    const delta = planned.text.length - (slot.end - slot.start);
    if (used + delta > MAX_REF_EXPAND_CHARS) continue; // 装不下这一处，保留 token

    used += delta;
    if (slot.kind === 'favorite') favoritesReplaced += 1;
    else if (slot.kind !== 'audio') replaced += 1;
    edits.push({
      start: slot.start,
      end: slot.end,
      text: planned.text,
    });

    if (planned.data) {
      const key = `${slot.kind}:${slot.ref}`;
      // 同一 id 的多处引用共享同一个数据对象：hostData 稳定、比较也便宜。
      const cached = dataByKey.get(key);
      if (cached) hostData[key] = cached;
      else {
        dataByKey.set(key, planned.data);
        hostData[key] = planned.data;
      }
    }
  }

  const adaptedSource = assemble(source, edits);

  // 子产物在父 hostData 定稿后补齐：它需要自己的那趟 compat / 适配 / 编译，
  // 且只认本次权限下的 `content`。external 模式下这里没有任何剪贴板数据。
  await attachInlineMarkdownDocuments(hostData);

  return { adaptedSource, hostData };
}
