// ─────────────────────────────────────────────────────────────────────────────
// qr.ts — 二维码生成的纯逻辑（零 React / 零 DOM，node 可直接 import）
//
// 【唯一关键点：必须覆盖 qrcode-generator 的 stringToBytes】
// 这个库的 Byte 模式默认把字符串按 **Latin-1** 取字节（`charCodeAt(i) & 0xff`）：
//   · '中'（U+4E2D）会被截成 0x2D，扫出来是「-」；
//   · 中文 / emoji 因此变成乱码，而且**不报任何错** —— 图看着完全正常，扫出来是错的。
// 覆盖成 TextEncoder 的 UTF-8 字节后，二维码内容才是真正的 UTF-8（手机相机 / 微信等
// 解码器一律按 UTF-8 读），中文、链接、emoji 都能正确还原。
//
// 这个赋值是**模块级副作用**：它改的是 qrcode-generator 的单例。全站另一处用到该库的
// 是 `src/lib/poster.ts`（画报 / 收款码，内容都是纯 ASCII 的 URL），所以覆盖它不会改变
// 那边任何一个字节。
//
// 【铁律：静区 ≥ 4 模块、cellSize 取整】
// 这两条来自 poster.ts 的实测（曾用 jsQR 解不出来）：模块尺寸非整数 → 边缘发虚，
// 解码器阈值化时丢模块；静区不够 → 短内容模块更大，固定像素内边距反而不够 4 模块。
// 所以这里**不允许把边距调到 4 模块以下**（UI 上的范围是 4–8），cellSize 由
// `floor(目标尺寸 / (模块数 + 2×边距))` 算出并取整。
//
// 【为什么不用 canvas 生成 PNG】
// 纯逻辑模块不许碰 DOM，而且 `createDataURL()` 产出的其实是 **GIF** data URL。
// 页面上的「下载 PNG」因此走 canvas 再编码（组件里做，见 QrTool.tsx）—— 不能把
// `.gif` 字节存成 `.png`，那是静默的假文件。
// ─────────────────────────────────────────────────────────────────────────────

import qrcode from 'qrcode-generator';

export type QrErrorLevel = 'L' | 'M' | 'Q' | 'H';

/** 纠错级别从低到高。级别越高容量越小、越抗遮挡。 */
export const QR_ERROR_LEVELS: readonly QrErrorLevel[] = ['L', 'M', 'Q', 'H'];

/** 纠错级别的中文说明（页面展示用，别在页面里另抄一份）。 */
export const QR_ERROR_LEVEL_LABELS: Record<QrErrorLevel, string> = {
  L: 'L（约 7% 容错，容量最大）',
  M: 'M（约 15% 容错）',
  Q: 'Q（约 25% 容错）',
  H: 'H（约 30% 容错，最抗遮挡）',
};

/** 目标边长（px）范围。 */
export const QR_MIN_SIZE = 128;
export const QR_MAX_SIZE = 512;

/** 静区（quiet zone）范围，单位：模块。规范要求 ≥ 4，这里刻意不允许更低。 */
export const QR_MIN_MARGIN_MODULES = 4;
export const QR_MAX_MARGIN_MODULES = 8;

/** 内容长度上限：再长会超出二维码容量（版本 40 在 L 级约 2953 字节）。 */
export const QR_MAX_TEXT_LENGTH = 2000;

// ⚠️ 见文件头：把 Byte 模式的取字节函数换成 UTF-8。
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));

/** 给单测用：验证取字节函数确实是 UTF-8（而不是 Latin-1）。 */
export function qrTextBytes(text: string): number[] {
  return qrcode.stringToBytes(text);
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface QrLayout {
  /** 每个模块的像素边长（整数）。 */
  cellSize: number;
  /** 静区在输出图里的像素宽度（= 边距模块数 × cellSize）。 */
  marginPx: number;
  /** 输出图的边长（px）。 */
  pixelSize: number;
  /** 实际使用的边距（模块）。 */
  marginModules: number;
}

/**
 * 由模块数 / 目标尺寸 / 边距算出光栅布局。
 *
 * 目标尺寸是**上限**：模块数太多、目标尺寸太小时 cellSize 会退到 1，
 * 输出因此可能略大于目标尺寸 —— 这比把模块压成 0 像素（直接扫不出来）正确。
 */
export function resolveQrLayout(
  moduleCount: number,
  size: number,
  marginModules: number = QR_MIN_MARGIN_MODULES
): QrLayout {
  if (!Number.isInteger(moduleCount) || moduleCount <= 0) {
    throw new Error('二维码模块数非法');
  }
  const clampedSize = clampInt(size, QR_MIN_SIZE, QR_MAX_SIZE, 256);
  const clampedMargin = clampInt(
    marginModules,
    QR_MIN_MARGIN_MODULES,
    QR_MAX_MARGIN_MODULES,
    QR_MIN_MARGIN_MODULES
  );
  const totalModules = moduleCount + clampedMargin * 2;
  const cellSize = Math.max(1, Math.floor(clampedSize / totalModules));
  const marginPx = clampedMargin * cellSize;
  return {
    cellSize,
    marginPx,
    pixelSize: moduleCount * cellSize + marginPx * 2,
    marginModules: clampedMargin,
  };
}

export interface QrRenderOptions {
  /** 纠错级别，默认 M。 */
  level?: QrErrorLevel;
  /** 目标边长（px，128–512），默认 256。 */
  size?: number;
  /** 静区模块数（4–8），默认 4。 */
  marginModules?: number;
}

export interface QrRender {
  /** 预览用的 data URL（qrcode-generator 产出的是 GIF；下载 PNG 需页面转码）。 */
  dataUrl: string;
  /** 矢量 SVG 源码（下载用）。 */
  svg: string;
  moduleCount: number;
  cellSize: number;
  marginPx: number;
  pixelSize: number;
  marginModules: number;
  level: QrErrorLevel;
}

/**
 * 生成二维码。内容为空、过长或超出容量时抛**中文**错误（页面直接展示 message）。
 *
 * 调用方不要自己去 import qrcode-generator —— 见文件头，取字节函数已经被本模块改成
 * UTF-8；绕过本模块直接 new 出来的二维码对中文仍是乱码。
 */
export function renderQr(text: string, options: QrRenderOptions = {}): QrRender {
  const content = text ?? '';
  if (!content.trim()) throw new Error('请输入要生成二维码的内容');
  if (content.length > QR_MAX_TEXT_LENGTH) {
    throw new Error(`内容过长：最多 ${QR_MAX_TEXT_LENGTH} 个字符`);
  }

  const level: QrErrorLevel = options.level ?? 'M';
  const qr = qrcode(0, level);
  qr.addData(content);
  try {
    qr.make();
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (/overflow|too long|length/i.test(message)) {
      throw new Error('内容超出二维码容量：请缩短内容，或把纠错级别调低');
    }
    throw new Error('二维码生成失败：' + (message || '未知错误'));
  }

  const moduleCount = qr.getModuleCount();
  const layout = resolveQrLayout(moduleCount, options.size ?? 256, options.marginModules);
  const dataUrl = qr.createDataURL(layout.cellSize, layout.marginPx);
  const svg = qr.createSvgTag({
    cellSize: layout.cellSize,
    margin: layout.marginPx,
    scalable: true,
  });

  return { dataUrl, svg, moduleCount, level, ...layout };
}
