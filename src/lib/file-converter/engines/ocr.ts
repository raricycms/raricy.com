// STUB —— 实施 agent H 将整体替换本文件。
// 契约：tesseract.js 从同源 /static/converter/tesseract/ 加载
// （worker.min.js / tesseract-core-simd-lstm.js|wasm / langs/*.traineddata.gz，
// 见 scripts/copy-converter-assets.mjs）。

export type OcrLang = 'eng' | 'chi_sim' | 'chi_sim+eng';

/** 对一组图片逐张 OCR，返回每张的纯文本（顺序与输入一致）。 */
export async function ocrImages(
  _images: Blob[],
  _lang: OcrLang,
  _opts: { signal?: AbortSignal; onProgress?: (p: number | null, message?: string) => void }
): Promise<string[]> {
  throw { kind: 'unknown', message: 'OCR 引擎尚未实现' };
}
