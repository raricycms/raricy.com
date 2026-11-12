import type { LocalDocument } from 'reactive-md';
import type { ContentFormat } from '../content-format';

export type ReferenceKind = 'image' | 'audio' | 'vote' | 'favorite' | 'clipboard';
export type SiteEmbedKind = Exclude<ReferenceKind, 'image'>;
export type ReferenceMode = 'expand' | 'external';

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
   * 内联 Markdown 子剪贴板的**同版本静态产物**（external 引用 + 同一组
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
