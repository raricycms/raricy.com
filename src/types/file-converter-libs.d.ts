// 格式转换器用到的**无类型** npm 包的最小声明。
// 只声明我们实际调用的那几个函数 —— 不是完整的包 API（上游没发类型，写全了也没人校对）。
// utif / node-unrar-js / mammoth 均无自带 d.ts（2026-10 实测 package.json 无 types 字段）。

// ─── utif（TIFF 解码 / 编码）──────────────────────────────────────────────────
// 用法：UTIF.decode(arrayBuffer) → IFD[]；UTIF.decodeImage(buf, ifd) 填充 ifd.data；
// UTIF.toRGBA8(ifd) → RGBA 字节；UTIF.encodeImage(rgba, w, h) → TIFF 字节。
declare module 'utif' {
  export interface UTIFIFD {
    width: number;
    height: number;
    data?: Uint8Array;
    [key: string]: unknown;
  }
  export function decode(buffer: ArrayBuffer | Uint8Array): UTIFIFD[];
  export function decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: UTIFIFD): void;
  export function toRGBA8(ifd: UTIFIFD): Uint8Array;
  export function encodeImage(
    rgba: Uint8Array,
    width: number,
    height: number,
    metadata?: Record<string, unknown>
  ): ArrayBuffer;
  export function encode(ifds: UTIFIFD[]): ArrayBuffer;
}

// ─── node-unrar-js（RAR 解压，wasm）───────────────────────────────────────────
declare module 'node-unrar-js' {
  export interface UnrarFileHeader {
    name: string;
    unpackedSize: number;
    packSize: number;
    flags: { directory: boolean; encrypted: boolean };
  }
  export interface UnrarExtractedFile {
    fileHeader: UnrarFileHeader;
    extraction?: Uint8Array;
  }
  export interface UnrarExtractor {
    getFileList(): { arcHeader: unknown; fileHeaders: UnrarFileHeader[] };
    extract(options?: { files?: string[] }): { arcHeader: unknown; files: UnrarExtractedFile[] };
  }
  export function createExtractorFromData(options: {
    data: ArrayBuffer | Uint8Array;
    password?: string;
  }): UnrarExtractor;
}

// ─── mammoth（DOCX → HTML / 纯文本）──────────────────────────────────────────
// 浏览器里用 mammoth.browser.js（不带 node 依赖的那一份）。
declare module 'mammoth/mammoth.browser' {
  export interface MammothResult {
    value: string;
    messages: { type: string; message: string }[];
  }
  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: Record<string, unknown>
  ): Promise<MammothResult>;
  export function extractRawText(input: {
    arrayBuffer: ArrayBuffer;
  }): Promise<MammothResult>;
}

declare module 'mammoth' {
  export interface MammothResult {
    value: string;
    messages: { type: string; message: string }[];
  }
  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: Record<string, unknown>
  ): Promise<MammothResult>;
  export function extractRawText(input: {
    arrayBuffer: ArrayBuffer;
  }): Promise<MammothResult>;
}
