// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/image-codecs.ts —— 纯字节图片编解码辅助（**零 DOM**）
//
// 【它是什么】
//   · BMP / ICO 的手写编码器：浏览器原生只能编 PNG / JPG /（按能力）WebP / AVIF，
//     BMP 与 ICO 结构简单、无压缩，自己写字节比拖一个 WASM 编码器便宜得多。
//   · TIFF 的 utif 封装（动态 import）：utif 只吃 / 只出字节，无 DOM，因此连同
//     「解码成 RGBA」一起放在这里，node 单测可直接驱动。
//   · SVG 尺寸解析与输出体积粗估：纯文本 / 纯算术，供 svg-rasterize 与
//     estimateOutput 共用。
//
// 【纪律】本文件不得出现任何 DOM import：node 环境的 vitest 直接驱动它
// （tests/unit/file-converter-image-codecs.test.ts 用 inspect.ts 的嗅探回读验证）。
// HEIC 解码（heic2any 要吃 Blob）与普通格式的 createImageBitmap 解码都在
// image-canvas.ts，不在本文件。
//
// 【已知边界】utif 写出的 TIFF 是**大端 + SHORT 型宽高标签**；契约层 inspect.ts 的
// tiffHeader 按 4 字节无符号读值域，对这种布局会把宽度读成 w<<16。也就是说
// 「utif 产出的 TIFF 再喂回来」时 inspect 拿不到正确尺寸 —— 转换管线靠解码后
// 复核兜住（不依赖 inspect 的尺寸），该读数缺陷已上报契约层。
// ─────────────────────────────────────────────────────────────────────────────

/** 编码器的输入像素：RGBA 顺序、每像素 4 字节、从上到下行优先。 */
export interface RgbaImage {
  width: number;
  height: number;
  /** 长度必须 === width * height * 4。 */
  rgba: Uint8Array | Uint8ClampedArray;
}

function checkImage(img: RgbaImage): void {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width < 1 || img.height < 1) {
    throw new Error(`非法图片尺寸 ${img.width}×${img.height}`);
  }
  if (img.rgba.length !== img.width * img.height * 4) {
    throw new Error(`像素数据长度 ${img.rgba.length} 与尺寸 ${img.width}×${img.height} 不符`);
  }
}

/** 逐字节扫 alpha 通道：任何一个像素半透明 / 全透明即返回 true（提前退出）。 */
export function rgbaHasAlpha(rgba: Uint8Array | Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) return true;
  }
  return false;
}

// ─── BMP ─────────────────────────────────────────────────────────────────────
//
// 写最朴素的 BI_RGB 无压缩位图：
//   · 24 位：无透明需求时。每行 BGR 三字节 / 像素，行末补零到 4 字节对齐。
//   · 32 位：源含透明时。每像素 BGRA 四字节（行天然对齐）。⚠️ 32 位 BI_RGB 的
//     alpha 字节在规范里其实「未定义」，多数现代查看器（Windows 照片、浏览器、
//     GIMP）会读它，但仍有查看器忽略 —— 调用方必须在 notices 里写明这一点。
// 像素存储**从下往上**（biHeight 为正 = bottom-up），这是 BMP 的默认方向。

const BMP_HEADER = 14 + 40; // BITMAPFILEHEADER + BITMAPINFOHEADER

export function encodeBmp(img: RgbaImage, opts?: { withAlpha?: boolean }): Uint8Array {
  checkImage(img);
  const { width: w, height: h, rgba } = img;
  const alpha = opts?.withAlpha === true;
  const bytesPerPixel = alpha ? 4 : 3;
  const rowSize = alpha ? w * 4 : (w * 3 + 3) & ~3;
  const pixelBytes = rowSize * h;
  const total = BMP_HEADER + pixelBytes;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);

  // BITMAPFILEHEADER
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  v.setUint32(2, total, true); // bfSize
  v.setUint32(10, BMP_HEADER, true); // bfOffBits

  // BITMAPINFOHEADER
  v.setUint32(14, 40, true); // biSize
  v.setInt32(18, w, true); // biWidth
  v.setInt32(22, h, true); // biHeight（正 = bottom-up）
  v.setUint16(26, 1, true); // biPlanes
  v.setUint16(28, alpha ? 32 : 24, true); // biBitCount
  v.setUint32(30, 0, true); // biCompression = BI_RGB
  v.setUint32(34, pixelBytes, true); // biSizeImage
  v.setInt32(38, 2835, true); // biXPelsPerMeter ≈ 72 DPI
  v.setInt32(42, 2835, true);

  // 像素：源是顶向下 RGBA，写出是底向上 BGR(A)
  let dst = BMP_HEADER;
  for (let y = h - 1; y >= 0; y--) {
    let src = y * w * 4;
    for (let x = 0; x < w; x++) {
      out[dst] = rgba[src + 2]; // B
      out[dst + 1] = rgba[src + 1]; // G
      out[dst + 2] = rgba[src]; // R
      if (alpha) out[dst + 3] = rgba[src + 3];
      dst += bytesPerPixel;
      src += 4;
    }
    dst = BMP_HEADER + (h - y) * rowSize; // 跳过行末 padding（缓冲已清零）
  }
  return out;
}

// ─── ICO ─────────────────────────────────────────────────────────────────────
//
// PNG-in-ICO：Vista 起 Windows 与全部现代浏览器都接受「ICO 容器里装一张 PNG」，
// 免去手写 XOR/AND 双位图 DIB。调用方负责先把图等比缩到 ≤256 并拿到 PNG 字节
// （canvas.toBlob('image/png')），这里只包 6 字节 ICONDIR + 16 字节目录项。

export const ICO_MAX_SIDE = 256;
const ICO_HEADER = 6 + 16; // ICONDIR + 1 个 ICONDIRENTRY

export function encodeIcoPng(pngBytes: Uint8Array, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > ICO_MAX_SIDE || height > ICO_MAX_SIDE) {
    throw new Error(`ICO 尺寸必须在 1–${ICO_MAX_SIDE} 之间，收到 ${width}×${height}`);
  }
  const out = new Uint8Array(ICO_HEADER + pngBytes.length);
  const v = new DataView(out.buffer);
  // ICONDIR
  v.setUint16(0, 0, true); // idReserved
  v.setUint16(2, 1, true); // idType = 1（图标；2 是光标）
  v.setUint16(4, 1, true); // idCount = 1 张
  // ICONDIRENTRY
  out[6] = width === ICO_MAX_SIDE ? 0 : width; // 0 表示 256
  out[7] = height === ICO_MAX_SIDE ? 0 : height;
  out[8] = 0; // bColorCount（≥8bpp 为 0）
  out[9] = 0; // bReserved
  v.setUint16(10, 1, true); // wPlanes
  v.setUint16(12, 32, true); // wBitCount（信息性，PNG 自带位深）
  v.setUint32(14, pngBytes.length, true); // dwBytesInRes
  v.setUint32(18, ICO_HEADER, true); // dwImageOffset
  out.set(pngBytes, ICO_HEADER);
  return out;
}

// ─── TIFF（utif 封装，动态 import —— 静态引入会把库卷进每个页面的主包）──────────
//
// 只处理「单页、8 位 RGBA、无压缩」这一个档：utif.encodeImage 写出的正是这个形状
// （大端、无压缩、strip 存储），解码头几张页也按第一页处理。多页 TIFF 的页数由
// decodeTiffRgba 如实带回（pages），**是否只转第一页的决定与说明义务在调用方**。

export interface TiffDecodeResult extends RgbaImage {
  /** 文件里的图像页总数（≥1）。 */
  pages: number;
}

/** RGBA → TIFF 字节（无压缩）。 */
export async function encodeTiffRgba(img: RgbaImage): Promise<Uint8Array> {
  checkImage(img);
  const UTIF = await import('utif');
  const rgba = img.rgba instanceof Uint8Array ? img.rgba : new Uint8Array(img.rgba);
  return new Uint8Array(UTIF.encodeImage(rgba, img.width, img.height));
}

/** TIFF 字节 → 第一页的 RGBA。结构损坏 / 没有图像页时抛 Error（调用方归类为 corrupt）。 */
export async function decodeTiffRgba(bytes: Uint8Array): Promise<TiffDecodeResult> {
  const UTIF = await import('utif');
  const ifds = UTIF.decode(bytes);
  if (!ifds.length) throw new Error('TIFF 中没有图像页');
  const ifd = ifds[0];
  UTIF.decodeImage(bytes, ifd);
  const rgba = UTIF.toRGBA8(ifd);
  // width / height 由 decodeImage 从 t256 / t257 填到 IFD 上（见 utif 源码）
  if (!ifd.width || !ifd.height || rgba.length !== ifd.width * ifd.height * 4) {
    throw new Error('TIFF 解码结果尺寸不可信');
  }
  return { width: ifd.width, height: ifd.height, rgba, pages: ifds.length };
}

// ─── SVG 尺寸解析（纯文本；光栅化的默认输出尺寸用）──────────────────────────────
//
// 只认两种信息：根标签的 width / height 属性（纯数值或 px），否则 viewBox 的后两个数。
// 相对单位（% / em / rem…）无法换算成像素，按「未知」返回 null —— 调用方回退默认值。

export function parseSvgSize(text: string): { width: number | null; height: number | null } {
  const m = /<svg\b[^>]*>/i.exec(text);
  if (!m) return { width: null, height: null };
  const tag = m[0];

  const attrNum = (name: string): number | null => {
    const a =
      new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag) ??
      new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
    if (!a) return null;
    if (!/^\s*[\d.]+\s*(px)?\s*$/i.test(a[1])) return null;
    const v = parseFloat(a[1]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  let width = attrNum('width');
  let height = attrNum('height');
  if (width === null || height === null) {
    const vb = /viewBox\s*=\s*"([^"]*)"/i.exec(tag) ?? /viewBox\s*=\s*'([^']*)'/i.exec(tag);
    if (vb) {
      const parts = vb[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
        if (width === null) width = parts[2];
        if (height === null) height = parts[3];
      }
    }
  }
  return { width, height };
}

// ─── 输出体积粗估（estimateOutput 用；估不出返回 null）──────────────────────────
//
// 量级估计，不是承诺：jpeg / webp / avif 按 0.25 B/px（质量 90 档照片的典型量级），
// png 按 1.5 B/px；bmp / tiff 无压缩按 RGBA 上界；ico 先按 ≤256 收敛再按 PNG 估。

export type RasterEstimateFormat = 'jpeg' | 'webp' | 'avif' | 'png' | 'bmp' | 'tiff' | 'ico';

export function estimateRasterBytes(format: RasterEstimateFormat, width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const px = width * height;
  switch (format) {
    case 'jpeg':
    case 'webp':
    case 'avif':
      return Math.ceil(px * 0.25);
    case 'png':
      return Math.ceil(px * 1.5);
    case 'bmp':
      return BMP_HEADER + px * 4; // 32 位上界
    case 'tiff':
      return px * 4 + 4096; // 无压缩 RGBA + IFD/头部余量
    case 'ico': {
      const w = Math.min(width, ICO_MAX_SIDE);
      const h = Math.min(height, ICO_MAX_SIDE);
      return ICO_HEADER + Math.ceil(w * h * 1.5);
    }
  }
}
