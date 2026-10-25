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
//
// 【不是渲染器，也不是取数层】本模块不 import prisma、不发 HTTP、不碰 React。
// `resolve` 是调用方按当前权限上下文注入的 `ReferenceReader`（站内 expand 视图
// 就是 `ContentRefResolver` 那一套）；对外视图则一个请求都不发，只用服务端随
// payload 下发的公开剪贴板（`externalClips`）。这样同一份源码在两种视图下可以
// 得到不同但都正确的适配结果。
//
// ── 六条「错了也不报错」的纪律 ────────────────────────────────────────────────
//
// 【1】代码块与行内代码里的 token **绝不展开**。扫描跑在 `maskMarkdownCode` 的
//   盖码副本上（与 content-ref-processor / 音频 / 收藏夹那几趟同口径）—— 这是
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
// 【4】预算与旧管线一致：图片/投票/剪贴板共 50 处替换，收藏夹另 3 处；50 次取数
//   （`MAX_REF_FETCHES`，按 `${kind}:${ref}` 去重）、4 并发
//   （`MAX_REF_CONCURRENCY`）、展开后总长 50 万字符（`MAX_REF_EXPAND_CHARS`）、
//   音频最多 3 条（由 `collectAudioRefs` 自带）。图片与音频**不取数**。
//   超预算 / 取不到的那一处**保留字面量**，绝不吃掉后面那些取得到的名额。
//
// 【5】单个引用失败只影响它自己（`resolve` 抛错 / 返回 undefined → 保留 token），
//   绝不整篇回退，也绝不因为一个坏 token 丢掉正文 —— 输出是逐段拼的，任何一段
//   没被接受就原样留在 `source` segment 里。
//
// 【6】剪贴板首期**一律链接卡片**，不内联源码。ReactiveMD 与 Markdown 的语义
//   兼容性还没验收，把（可能是 reactive 语法的）剪贴板正文拼进父文档等于拿作者
//   内容做二次解析。所以 hostData 里对剪贴板**不携带 `content`** —— 没有东西
//   可以误内联，渲染器只能画链接卡片。
//
// 数字 token 保留旧博客管线的宽松形态 `\[@\s*(\w+)\s*\]`（内部空白、下划线都认），
// 按 id **长度**分流；具名音频 token 继续用 `audio-refs.ts` 自己的白名单正则。
// 两套正则都不会把中文吃成数字 id，所以合并时不会重叠。
//
// 本模块零 DOM / 零 React / 零 prisma，可直接单测
// （tests/unit/reactive-ref-adapter.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

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
import type {
  ExternalClipData,
  ReferenceKind,
  ReferenceMode,
  ReferenceReader,
  ReferenceSlot,
  ResolvedReference,
  SiteEmbedData,
  SiteEmbedKind,
  SiteHostData,
} from './ref-types';
import type { AdaptedSourceSegment, SegmentOrigin } from './source-map';

/**
 * 适配器版本。进缓存键 / 快照标识（见 docs/plan/reactive-md-migration-plan.md
 * §5.3）。**每次改变输出形状或转义规则都必须递增** —— 否则旧缓存会继续发一份
 * 按旧规则生成的源码。
 */
export const ADAPTER_VERSION = 'reactive-ref-adapter/1';

/**
 * site-embed 的 ref 属性必须与宿主 schema 的 pattern 一致（`^[A-Za-z0-9]{1,32}$`，
 * 见计划 D1）。不匹配的 id（旧语法里的下划线）保留字面量：发了标签也只会得到
 * `local.host.attribute` 诊断，不如不换。
 */
const EMBED_REF_RE = /^[A-Za-z0-9]{1,32}$/;

/** 旧博客管线的数字引用形态：内部空白与 `\w`（含下划线）都认。 */
const NUMERIC_REF_PATTERN = /\[@\s*(\w+)\s*\]/g;

/** 作者伪造的宿主标签前缀（只匹配到标签名，尖括号随后被转义）。 */
const FORGED_EMBED_PATTERN = /<site-embed(?=[\s/>])/gi;

export interface ReactiveAdaptOptions {
  mode: ReferenceMode;
  /** `expand` 模式下的取数函数。`external` 模式**绝不调用**它。 */
  resolve?: ReferenceReader;
  /**
   * `external` 模式下服务端预先解析好的公开剪贴板（id → 结构化数据）。
   * 不在这里的剪贴板保留字面量 —— 不发标签，才不会出现 `local-host-unavailable`。
   */
  externalClips?: Record<string, ExternalClipData>;
}

export interface ReactiveAdaptResult {
  adaptedSource: string;
  /** 连续覆盖整篇的区间映射（见 source-map.ts）。 */
  segments: AdaptedSourceSegment[];
  /** 键 = `${kind}:${ref}`，与 `<site-embed>` 的 `kind` / `ref` 属性一一对应。 */
  hostData: SiteHostData;
  /** 稳定序列化的引用版本清单；同一输入与同一引用数据必须得到同一个值。 */
  referenceSnapshotId: string;
}

/** 一处输出改写：原文 `[start, end)` → `text`。 */
interface SourceEdit {
  start: number;
  end: number;
  text: string;
  origin: SegmentOrigin;
  kind?: ReferenceKind;
  ref?: string;
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

/** 按实例闸门（4 并发）取数；单条失败 / 抛错一律折算成 `undefined`，保留字面量。 */
async function resolveCandidates(
  candidates: ReadonlyMap<string, ReferenceSlot>,
  reader: ReferenceReader | undefined
): Promise<Map<string, ResolvedReference | undefined>> {
  const resolved = new Map<string, ResolvedReference | undefined>();
  const entries = [...candidates.entries()];
  if (!reader || entries.length === 0) {
    for (const [key] of entries) resolved.set(key, undefined);
    return resolved;
  }

  const schedule = createConcurrencyLimiter(MAX_REF_CONCURRENCY);
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

/**
 * 把**一处** token 变成输出文本（以及可能的 hostData）。返回 `null` = 保留字面量。
 * 这一处不判预算；各类别显示预算由调用方统一执行，顺序才与旧管线一致。
 */
function planReplacement(
  slot: ReferenceSlot,
  mode: ReferenceMode,
  resolvedByKey: ReadonlyMap<string, ResolvedReference | undefined>,
  externalClips: Record<string, ExternalClipData>
): PlannedReplacement | null {
  if (slot.kind === 'image') {
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

  const key = `${slot.kind}:${slot.ref}`;

  if (slot.kind === 'clipboard') {
    if (mode === 'external') {
      const clip = externalClips[slot.ref];
      if (!clip) return null; // 缺公开数据 → 保留字面量，不发标签
      const tag = embedTag('clipboard', slot.ref);
      if (!tag) return null;
      const data: SiteEmbedData = { kind: 'clipboard', ref: slot.ref, status: 'ready' };
      if (clip.title !== undefined) data.title = clip.title;
      data.format = clip.format;
      if (clip.version !== undefined) data.version = clip.version;
      // ★ 刻意不带 content ★ 首期一律链接卡片，见文件头【6】。
      return { text: tag, data };
    }
    const resolved = resolvedByKey.get(key);
    if (!resolved) return null;
    const tag = embedTag('clipboard', slot.ref);
    if (!tag) return null;
    return { text: tag, data: makeEmbedData('clipboard', slot.ref, resolved, false) };
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

/** 作者伪造的宿主标签：盖码后定位，只转义开头的 `<`。 */
function collectForgedEmbedEdits(source: string, masked: string): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const re = new RegExp(FORGED_EMBED_PATTERN.source, 'gi');
  for (const m of masked.matchAll(re)) {
    const at = m.index ?? 0;
    if (at < 0 || at >= source.length) continue;
    edits.push({ start: at, end: at + 1, text: '&lt;', origin: 'generated' });
  }
  return edits;
}

function assemble(
  source: string,
  edits: readonly SourceEdit[]
): { adaptedSource: string; segments: AdaptedSourceSegment[] } {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const segments: AdaptedSourceSegment[] = [];
  let adaptedSource = '';
  let cursor = 0;

  for (const edit of ordered) {
    // 防御：未知输入下万一出现重叠 / 越界，跳过它而不是破坏整篇。
    if (edit.start < cursor || edit.end > source.length || edit.start > edit.end) continue;

    if (edit.start > cursor) {
      const text = source.slice(cursor, edit.start);
      segments.push({
        origin: 'source',
        sourceStart: cursor,
        sourceEnd: edit.start,
        adaptedStart: adaptedSource.length,
        adaptedEnd: adaptedSource.length + text.length,
      });
      adaptedSource += text;
    }

    const segment: AdaptedSourceSegment = {
      origin: edit.origin,
      sourceStart: edit.start,
      sourceEnd: edit.end,
      adaptedStart: adaptedSource.length,
      adaptedEnd: adaptedSource.length + edit.text.length,
    };
    if (edit.kind) segment.kind = edit.kind;
    if (edit.ref) segment.ref = edit.ref;
    segments.push(segment);
    adaptedSource += edit.text;
    cursor = edit.end;
  }

  if (cursor < source.length) {
    const text = source.slice(cursor);
    segments.push({
      origin: 'source',
      sourceStart: cursor,
      sourceEnd: source.length,
      adaptedStart: adaptedSource.length,
      adaptedEnd: adaptedSource.length + text.length,
    });
    adaptedSource += text;
  }

  return { adaptedSource, segments };
}

function buildReferenceSnapshotId(
  mode: ReferenceMode,
  candidates: ReadonlyMap<string, ReferenceSlot>,
  resolvedByKey: ReadonlyMap<string, ResolvedReference | undefined>,
  hostData: SiteHostData,
  imageRefs: ReadonlySet<string>
): string {
  const parts = new Set<string>();
  parts.add(`adapter=${ADAPTER_VERSION}`);
  parts.add(`mode=${mode}`);
  for (const key of candidates.keys()) {
    const resolved = resolvedByKey.get(key);
    parts.add(`${key}=${resolved ? `${resolved.status}/${resolved.version ?? ''}` : 'missing'}`);
  }
  for (const [key, data] of Object.entries(hostData)) {
    parts.add(`${key}=${data.status}/${data.version ?? ''}`);
  }
  for (const ref of imageRefs) parts.add(`image:${ref}=static`);
  return [...parts].sort().join('|');
}

/**
 * 适配一篇正文：扫描 → 取数（仅 expand）→ 逐处替换 / 转义 → 产出区间映射与
 * hostData。永不抛「整篇失败」：任何一处引用出问题都只保留它的字面量。
 */
export async function adaptReactiveReferences(
  source: string,
  options: ReactiveAdaptOptions
): Promise<ReactiveAdaptResult> {
  const mode = options.mode;
  const masked = maskMarkdownCode(source);
  const slots = scanMasked(source, masked);

  const candidates = collectCandidates(slots, mode);
  const resolvedByKey = await resolveCandidates(candidates, options.resolve);
  const externalClips = options.externalClips ?? {};

  // 伪造标签的转义与预算无关 —— 那是安全改写，哪怕是超长正文也必须做。
  const edits: SourceEdit[] = collectForgedEmbedEdits(source, masked);

  const hostData: Record<string, SiteEmbedData> = {};
  const dataByKey = new Map<string, SiteEmbedData>();
  const imageRefs = new Set<string>();

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

    const planned = planReplacement(slot, mode, resolvedByKey, externalClips);
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
      origin: 'reference',
      kind: slot.kind,
      ref: slot.ref,
    });

    if (slot.kind === 'image') {
      imageRefs.add(slot.ref);
    }
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

  const { adaptedSource, segments } = assemble(source, edits);

  return {
    adaptedSource,
    segments,
    hostData,
    referenceSnapshotId: buildReferenceSnapshotId(mode, candidates, resolvedByKey, hostData, imageRefs),
  };
}
