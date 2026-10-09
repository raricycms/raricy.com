// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/pdf-layout.ts —— PDF 版面几何的**零依赖纯函数**。
//
// 【它是什么】把「页面尺寸 / 边距 / 方向 / 图片比例」这类算术从 pdf-lib 调用里
//   摘出来，让它们能被 node 单测直接驱动（tests/unit/file-converter-pdf-layout.test.ts）。
//   engines/pdf.ts 只负责「拿几何去画」，不自己算坐标。
//
// 【量纲】全部是 **PDF 点（pt）**，1 pt = 1/72 英寸。像素 → 点是 dpiScale(dpi)=dpi/72。
//   `original` 页面尺寸按「1 像素 = 1 点」处理（即 72 dpi 的版面，不缩放）。
//
// 【纪律】零 import、零 DOM、零引擎 —— 只做算术与字符串。
// ─────────────────────────────────────────────────────────────────────────────

export interface PageBox {
  width: number;
  height: number;
}

/** 标准纸张的纵向尺寸（pt）。A4 与 US Letter 的公认值。 */
export const PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

export type PageSizeKey = 'a4' | 'letter' | 'original';
export type MarginKey = 'none' | 'narrow' | 'normal';
export type OrientationKey = 'auto' | 'portrait' | 'landscape';

/** 边距预设（pt）：无 / 窄（0.25 英寸）/ 常规（0.5 英寸）。 */
export const MARGIN_POINTS: Record<MarginKey, number> = {
  none: 0,
  narrow: 18,
  normal: 36,
};

/** 超过这个页数，逐页图片就打包成 ZIP 单输出（否则结果页被几十条下载项淹没）。 */
export const ZIP_PAGE_THRESHOLD = 20;

/** dpi → PDF 点坐标下的缩放系数（72 pt = 1 英寸）。 */
export function dpiScale(dpi: number): number {
  return dpi / 72;
}

/** 边距预设 → 点数；未知键回退「常规」。 */
export function marginPoints(key: string): number {
  return key in MARGIN_POINTS ? MARGIN_POINTS[key as MarginKey] : MARGIN_POINTS.normal;
}

function swap(box: PageBox): PageBox {
  return { width: box.height, height: box.width };
}

/** 按方向约束把盒子摆成纵向 / 横向；'auto' 原样返回。 */
function applyOrientation(box: PageBox, orientation: string): PageBox {
  const isLandscape = box.width > box.height;
  if (orientation === 'portrait') return isLandscape ? swap(box) : box;
  if (orientation === 'landscape') return isLandscape ? box : swap(box);
  return box;
}

export interface PageBoxInput {
  pageSize: string;
  orientation: string;
  imageWidth: number;
  imageHeight: number;
}

/**
 * 为一张图片决定页面盒子（pt）。
 *   · a4 / letter：标准纸张；'auto' 方向按图片比例选（宽图片用横向纸）。
 *   · original：页面 = 图片像素数（1px = 1pt），方向约束照旧可翻转。
 */
export function resolvePageBox(input: PageBoxInput): PageBox {
  const w = input.imageWidth > 0 ? input.imageWidth : 1;
  const h = input.imageHeight > 0 ? input.imageHeight : 1;
  if (input.pageSize === 'original') {
    return applyOrientation({ width: w, height: h }, input.orientation);
  }
  const base: PageBox = input.pageSize === 'letter' ? { ...PAGE_SIZES.letter } : { ...PAGE_SIZES.a4 };
  // 'auto'：纸的方向跟着图片（宽图配横向纸），这一步把「auto」落成一个具体方向再走统一逻辑。
  const orientation =
    input.orientation === 'auto' ? (w > h ? 'landscape' : 'portrait') : input.orientation;
  return applyOrientation(base, orientation);
}

export interface ImagePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 等比缩放使图片**完整装进**盒子并居中（contain）。居中在 PDF 坐标系里
 * 上下的 y 是同一套（pdf-lib 原点在左下，但居中对称，无需翻转）。
 * 小图会被放大填满 —— 这是「照片摆满一页」的期望行为（原字节仍原样嵌入，不重编码）。
 */
export function fitContain(imgW: number, imgH: number, boxW: number, boxH: number): ImagePlacement {
  const iw = imgW > 0 ? imgW : 1;
  const ih = imgH > 0 ? imgH : 1;
  const scale = Math.min(boxW / iw, boxH / ih);
  const width = iw * scale;
  const height = ih * scale;
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height };
}

/** 逐页图片是否需要打包 ZIP。 */
export function shouldZipPages(pageCount: number): boolean {
  return pageCount > ZIP_PAGE_THRESHOLD;
}

export interface RasterEstimateInput {
  pageCount: number;
  dpi: number;
  /** 单页尺寸（pt），默认 A4 纵向。 */
  pageWidthPt?: number;
  pageHeightPt?: number;
  /** 每像素的粗略字节系数（png ≈ 1.5、jpeg ≈ 0.3、webp ≈ 0.25）。 */
  bytesPerPixel: number;
}

/** 图片型输出的粗估字节数（只用于输出预算的提前拒绝，宁可早拒）。 */
export function estimateRasterBytes(input: RasterEstimateInput): number {
  const wPt = input.pageWidthPt ?? PAGE_SIZES.a4.width;
  const hPt = input.pageHeightPt ?? PAGE_SIZES.a4.height;
  const s = dpiScale(input.dpi);
  const px = wPt * s * hPt * s * Math.max(1, input.pageCount);
  return Math.round(px * input.bytesPerPixel);
}

// ─── 页码编排（重新排序 / 旋转边用）───────────────────────────────────────────

export interface PageOrderResult {
  /** 输出顺序里的页码（1 起，允许重复）。 */
  sequence: number[];
  /** 输入里存在、但没被列出的页（1 起的升序）。 */
  omitted: number[];
  /** 列出了但超出 1..pageCount 的页码（按出现顺序去重）。 */
  outOfRange: number[];
  /** 是否出现重复页（重复 = 输出里就有重复）。 */
  hasDuplicate: boolean;
}

/**
 * 解析「重排顺序」文本（如 `3,1,2` / `1 1 2`）。
 *   · 分隔符：逗号或空白。
 *   · 非数字 token → 返回 null（调用方按「语法错误」提示，不静默忽略）。
 *   · 越界页码 → 记入 outOfRange 并跳过；未列出的页 → omitted。
 *   · 空 / 全空白 → 返回 null（调用方回退「原顺序」）。
 */
export function parsePageOrder(text: string, pageCount: number): PageOrderResult | null {
  const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const sequence: number[] = [];
  const outOfRange: number[] = [];
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) return null;
    const n = parseInt(t, 10);
    if (n < 1 || n > pageCount) {
      if (!outOfRange.includes(n)) outOfRange.push(n);
      continue;
    }
    sequence.push(n);
  }
  const present = new Set(sequence);
  const omitted: number[] = [];
  for (let i = 1; i <= pageCount; i++) if (!present.has(i)) omitted.push(i);
  return { sequence, omitted, outOfRange, hasDuplicate: present.size !== sequence.length };
}

/** 把 parsePageOrder 的结果翻成人话，逐条进结果页的 notices。 */
export function orderNotices(result: PageOrderResult): string[] {
  const out: string[] = [];
  if (result.omitted.length > 0) out.push(`未列出的 ${result.omitted.length} 页已丢弃`);
  if (result.outOfRange.length > 0) out.push(`${result.outOfRange.length} 个超出范围的页码已忽略`);
  if (result.hasDuplicate) out.push('重复列出的页会重复输出');
  return out;
}

// ─── 拆分范围（pdf-split 用）──────────────────────────────────────────────────

/**
 * 「每行一段」的拆分输入 → 去空行去空白的段落列表。
 * 每段仍要过 parsePageRange（utils.ts）解析具体页码 —— 那个解析器已有一份权威实现，
 * 本模块不复制它。
 */
export function splitRangeLines(text: string): string[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
