import type { LocalDocument } from 'reactive-md';
import type { ContentFormat } from '../content-format';

export type ReferenceKind = 'image' | 'audio' | 'vote' | 'favorite' | 'clipboard';
export type SiteEmbedKind = 'audio' | 'vote' | 'favorite' | 'clipboard' | 'image';
export type ReferenceMode = 'expand' | 'external';

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
   * 编译选项）。只在成员 expand 视图里生成；external 快照永远没有它。
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
export interface ExternalClipData {
  content: string;
  format: ContentFormat;
  version?: string;
  title?: string;
}

/** 兼容层提取的受限 data 位图（仅 hostData 使用）。 */
export interface DataImageSource {
  url: string;
  alt: string;
  width?: string;
  height?: string;
}
