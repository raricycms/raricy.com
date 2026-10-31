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
