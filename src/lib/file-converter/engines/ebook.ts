// STUB —— 实施 agent D 将整体替换本文件。
// 契约：EPUB 的构建与解析的共享内核；office 类别的 DOCX→EPUB 也复用 epubFromHtml。

export interface EpubMeta {
  title: string;
  author?: string;
  language?: string;
}

/** 由 HTML 正文构建一个最小合法的 EPUB 3（单章或多章由实现切分）。 */
export async function epubFromHtml(_html: string, _meta: EpubMeta): Promise<Uint8Array> {
  throw { kind: 'unknown', message: 'EPUB 引擎尚未实现' };
}
