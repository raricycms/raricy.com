import type { LocalDocument } from 'reactive-md';
import type { ContentFormat } from '../content-format';

export type ReferenceKind = 'image' | 'audio' | 'vote' | 'favorite' | 'clipboard' | 'media';
export type SiteEmbedKind = 'audio' | 'vote' | 'favorite' | 'clipboard' | 'image' | 'media';
export type ReferenceMode = 'expand' | 'external';

// ── 历史 HTML 音视频（`media` kind）──────────────────────────────────────────
//
// 旧 Markdown 白名单允许 `<video>` / `<audio>` / `<source>` / `<track>`。compat 把
// 这些区块改写成 `[[媒体:<10 hex>]]` 短 token + `mediaSources`（等长改写是硬约束，
// 见 needs 文档）；适配器再把 token 展开成 `site-embed kind="media"` 与 hostData。
//
// ★ 故意没有 `autoplay` ★ 产品决定禁止自动播放；渲染器即使收到也会忽略。
// `controls` 恒为 true，由渲染器写死，不放进 payload。

export type SiteMediaKind = 'video' | 'audio';
export type SiteMediaPreload = 'none' | 'metadata' | 'auto';

export interface SiteMediaSourceItem {
  /** 已过 `isAllowedReactiveUrl(src, 'link')`；渲染器会再复核一次。 */
  src: string;
  /** 安全 MIME 形态（`video/mp4` 等）；渲染器按白名单过滤。 */
  type?: string;
}

export interface SiteMediaTrackItem {
  /** 已过 `isAllowedReactiveUrl(src, 'link')`；渲染器会再复核一次。 */
  src: string;
  kind?: 'subtitles' | 'captions' | 'descriptions' | 'chapters' | 'metadata';
  srclang?: string;
  label?: string;
  default?: boolean;
}

export interface SiteMediaPayload {
  media: SiteMediaKind;
  /** 直接 src；可为空，此时必须有 `sources`。 */
  src?: string;
  /** `<source>` 子节点。无 `src` 有 `sources` 的媒体不能消失。 */
  sources?: SiteMediaSourceItem[];
  /** `<track>` 字幕 / 章节。 */
  tracks?: SiteMediaTrackItem[];
  /** 仅 video；走 `image` URL 策略（含受限历史 data 位图）。 */
  poster?: string;
  /** 缺省 / 非法 = `'none'`（产品口径）。 */
  preload?: SiteMediaPreload;
  loop?: boolean;
  muted?: boolean;
  playsInline?: boolean;
  /** 仅 video；正整数或纯数字串（渲染器都会收紧成正整数）。 */
  width?: number | string;
  height?: number | string;
  crossorigin?: 'anonymous' | 'use-credentials';
}

/** compat 返回的 `mediaSources`；键 = token 里的 10 位小写十六进制。 */
export type SiteMediaSources = Readonly<Record<string, SiteMediaPayload>>;

// ── 投票嵌入的 payload（`GET /api/votes/:id` 的 `data`）──────────────────────
//
// 住在 ref-types 而不是渲染器里：hostData 里 `vote:<id>.payload` 就是它，
// reactive 的静态渲染（site-embed-static）与交互渲染（SiteEmbedView）共用同一份形状。
// （legacy Markdown 管线退役前定义在 blog-markdown.ts，随该管线整体迁入。）

export interface VoteOptionData {
  id: number;
  label: string;
  count: number;
  percentage: number;
}

export interface VoteEmbedData {
  title: string;
  is_locked: boolean;
  total_votes: number;
  user_voted: number | null;
  options: VoteOptionData[];
}

export interface ReferenceSlot {
  kind: ReferenceKind;
  ref: string;
  token: string;
  start: number;
  end: number;
}

export interface ResolvedReference {
  status: 'ready' | 'error' | 'forbidden';
  title?: string;
  format?: ContentFormat;
  content?: string;
  version?: string;
  payload?: unknown;
}

export interface SiteEmbedData extends ResolvedReference {
  kind: SiteEmbedKind;
  ref: string;
  /**
   * 内联 Markdown 子剪贴板的**同版本静态产物**（compat + external 适配 + 同一组
   * 编译选项）。只在成员 expand 视图里生成；external 视图永远没有它。
   *
   * 与 `hostData` 成对出现：缺一个就退回链接卡片，绝不发「有标签没数据」的半套。
   * 子文档是独立编译的，内部绑定 / 表达式不会进入父文档作用域。
   */
  document?: LocalDocument;
  /** 子文档自己的 hostData（`${kind}:${ref}`），与父文档的键空间隔离。 */
  hostData?: SiteHostData;
}

export type SiteHostData = Readonly<Record<string, SiteEmbedData>>;
export type ReferenceReader = (slot: ReferenceSlot) => Promise<ResolvedReference | undefined>;

/** 兼容层提取的受限 data 位图（仅 hostData 使用）。 */
export interface DataImageSource {
  url: string;
  alt: string;
  width?: string;
  height?: string;
}
