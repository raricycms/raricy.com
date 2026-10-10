// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/image-canvas.ts —— 浏览器原生图片管线封装（**DOM 专用**）
//
// 【它是什么】静态图片转换的执行层：解码（createImageBitmap 优先，<img> 兜底；
//   HEIC 先 heic2any、TIFF 先 utif）、缩放、透明压平、Canvas 编码。
//
// 【纪律】
//   · 本文件只在浏览器里跑，node 单测**不要** import 它（纯字节部分在
//     image-codecs.ts）。
//   · 重依赖（heic2any）一律函数体内动态 import。
//   · Canvas 请求不支持的编码类型时会**静默回退 PNG**（plan §3.1 点名的坑）——
//     encodeCanvas 必须核对返回 Blob 的 type，回退即抛 capability，不交付错格式。
//   · SVG 走 Blob URL + <img> 光栅化：**图片上下文里的 SVG 不执行脚本、不加载
//     外部资源**（HTML 规范对 <img> 的安全约束），这是本站受控光栅化的安全前提。
//   · 用户文件字节绝不出站：这里没有任何网络请求（Blob URL 是同源内存引用）。
// ─────────────────────────────────────────────────────────────────────────────

import type { ConvertError, FileKind } from '../types';
import { decodeTiffRgba, type RgbaImage } from './image-codecs';

function corrupt(message: string, detail?: string): ConvertError {
  return { kind: 'corrupt', message, detail };
}

function capability(message: string, detail?: string): ConvertError {
  return { kind: 'capability', message, detail };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

export interface StaticDecode {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** TIFF 输入时的总页数（其它格式为 undefined）。 */
  pages?: number;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = canvas.getContext('2d');
  if (!c) throw capability('无法创建 Canvas 2D 上下文');
  return c;
}

/** createImageBitmap 主路：默认 imageOrientation='from-image'，EXIF 方向随解码归一。 */
async function decodeViaBitmap(blob: Blob, signal: AbortSignal): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  throwIfAborted(signal);
  try {
    const canvas = makeCanvas(bitmap.width, bitmap.height);
    ctx2d(canvas).drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/**
 * <img> 兜底路（老浏览器 / 冷门容器）。drawImage 一个 <img> 时浏览器按
 * image-orientation: from-image 的规范默认应用 EXIF 方向，语义与主路一致。
 */
async function decodeViaImg(blob: Blob, signal: AbortSignal): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('img 元素解码失败'));
    });
    img.src = url;
    await loaded;
    throwIfAborted(signal);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('图片尺寸为零');
    const canvas = makeCanvas(w, h);
    ctx2d(canvas).drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** HEIC：heic2any（libheif WASM）先转成 PNG Blob，再走普通位图解码。 */
async function decodeHeic(file: File, signal: AbortSignal): Promise<HTMLCanvasElement> {
  let converted: Blob | Blob[];
  try {
    const { default: heic2any } = await import('heic2any');
    throwIfAborted(signal);
    converted = await heic2any({ blob: file, toType: 'image/png' });
  } catch (e) {
    throw corrupt('HEIC 解码失败，文件可能损坏或是不受支持的变体', e instanceof Error ? e.message : String(e));
  }
  throwIfAborted(signal);
  // multiple:false（默认）返回单个 Blob（主图）；数组形态只是防御
  const pngBlob = Array.isArray(converted) ? converted[0] : converted;
  if (!pngBlob) throw corrupt('HEIC 解码没有产出图像');
  return decodeViaBitmap(pngBlob, signal).catch(() => decodeViaImg(pngBlob, signal));
}

/** TIFF：utif 解出第一页 RGBA，直接 putImageData。 */
async function decodeTiff(file: File, signal: AbortSignal): Promise<StaticDecode> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  let decoded;
  try {
    decoded = await decodeTiffRgba(bytes);
  } catch (e) {
    throw corrupt('TIFF 解码失败，文件可能损坏或使用了暂不支持的压缩', e instanceof Error ? e.message : String(e));
  }
  const canvas = makeCanvas(decoded.width, decoded.height);
  const data = new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height);
  ctx2d(canvas).putImageData(data, 0, 0);
  return { canvas, width: decoded.width, height: decoded.height, pages: decoded.pages };
}

/**
 * 静态图片统一解码入口（不含 SVG —— SVG 走 rasterizeSvg）。
 * 失败一律抛 ConvertError（corrupt / capability / cancelled）。
 */
export async function decodeStaticImage(file: File, kind: FileKind, signal: AbortSignal): Promise<StaticDecode> {
  throwIfAborted(signal);
  if (kind === 'heic') {
    const canvas = await decodeHeic(file, signal);
    return { canvas, width: canvas.width, height: canvas.height };
  }
  if (kind === 'tiff') return decodeTiff(file, signal);
  let canvas: HTMLCanvasElement;
  try {
    canvas = await decodeViaBitmap(file, signal);
  } catch (e) {
    if ((e as Partial<ConvertError>)?.kind) throw e;
    try {
      canvas = await decodeViaImg(file, signal);
    } catch (e2) {
      throw corrupt('图片解码失败，文件可能损坏或编码不受支持', e2 instanceof Error ? e2.message : String(e2));
    }
  }
  return { canvas, width: canvas.width, height: canvas.height };
}

/**
 * SVG 光栅化：Blob URL + <img>。**安全事实**：<img> 加载的 SVG 处于纯图片上下文，
// 其中的 <script> 不执行、事件属性不触发、外部引用（图片 / CSS / 字体）不加载 ——
// 这是浏览器规范层面的隔离，不依赖我们对 SVG 正文的任何清洗。
 */
export async function rasterizeSvg(
  bytes: Uint8Array,
  opts: { width: number; height: number; background: string | null },
  signal: AbortSignal
): Promise<HTMLCanvasElement> {
  throwIfAborted(signal);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG 渲染失败'));
    });
    img.src = url;
    await loaded;
    throwIfAborted(signal);
    const canvas = makeCanvas(opts.width, opts.height);
    const c = ctx2d(canvas);
    if (opts.background) {
      c.fillStyle = opts.background;
      c.fillRect(0, 0, opts.width, opts.height);
    }
    c.drawImage(img, 0, 0, opts.width, opts.height);
    return canvas;
  } catch (e) {
    if ((e as Partial<ConvertError>)?.kind) throw e;
    throw corrupt('SVG 光栅化失败，文件可能不是合法的 SVG', e instanceof Error ? e.message : String(e));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 等比缩到宽度 ≤ maxWidth；不需要缩放时**原样返回**（调用方按引用比较判断）。 */
export function downscaleToMaxWidth(src: HTMLCanvasElement, maxWidth: number): HTMLCanvasElement {
  if (maxWidth <= 0 || src.width <= maxWidth) return src;
  const h = Math.max(1, Math.round((src.height * maxWidth) / src.width));
  const canvas = makeCanvas(maxWidth, h);
  ctx2d(canvas).drawImage(src, 0, 0, maxWidth, h);
  return canvas;
}

/** 等比缩到宽高都 ≤ maxSide（ICO 用）；不需要时原样返回。 */
export function downscaleToFit(src: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  if (src.width <= maxSide && src.height <= maxSide) return src;
  const scale = Math.min(maxSide / src.width, maxSide / src.height);
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const canvas = makeCanvas(w, h);
  ctx2d(canvas).drawImage(src, 0, 0, w, h);
  return canvas;
}

/** 把透明区域压平到指定背景色；无透明需求时调用方不应调用（会白做一次读取）。 */
export function flattenOntoBackground(src: HTMLCanvasElement, cssColor: string): HTMLCanvasElement {
  const canvas = makeCanvas(src.width, src.height);
  const c = ctx2d(canvas);
  c.fillStyle = cssColor;
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.drawImage(src, 0, 0);
  return canvas;
}

/** 画到一张 width×height 的**透明**画布中央（图片序列「对齐画布」用）；已是该尺寸时原样返回。 */
export function composeCentered(src: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  if (src.width === width && src.height === height) return src;
  const canvas = makeCanvas(width, height);
  ctx2d(canvas).drawImage(src, Math.round((width - src.width) / 2), Math.round((height - src.height) / 2));
  return canvas;
}

/** 读出 RGBA 像素（BMP / TIFF 编码器与透明探测用）。 */
export function canvasToRgba(src: HTMLCanvasElement): RgbaImage {
  const data = ctx2d(src).getImageData(0, 0, src.width, src.height);
  return { width: src.width, height: src.height, rgba: data.data };
}

/**
 * Canvas 编码为指定 MIME。**显式拦截静默回退**：返回 Blob 的 type 与请求不符
// （浏览器对不支持的类型回退成 PNG）即抛 capability，绝不交付名不副实的字节。
 */
export async function encodeCanvas(
  src: HTMLCanvasElement,
  mime: string,
  quality01: number | undefined,
  signal: AbortSignal
): Promise<Blob> {
  throwIfAborted(signal);
  const blob = await new Promise<Blob | null>((resolve) => {
    // toBlob 是回调式且不可中断 —— 编码前后各查一次 signal
    src.toBlob((b) => resolve(b), mime, quality01);
  });
  throwIfAborted(signal);
  if (!blob || blob.size === 0) {
    throw capability('浏览器未能编码为该格式（Canvas 编码返回空）');
  }
  if (blob.type !== mime) {
    throw capability('当前浏览器不支持编码为该格式（Canvas 静默回退了其它格式，已拦截）', `请求 ${mime}，实际 ${blob.type || '未知'}`);
  }
  return blob;
}
