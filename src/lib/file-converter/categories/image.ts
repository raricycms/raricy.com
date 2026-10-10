// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/image.ts —— 图片能力区（roadmap §4）。
//
// 【范围】
//   · 静态互转（Canvas 管线，engines/image-canvas.ts）：JPG / PNG / WebP / AVIF /
//     BMP / ICO / TIFF 输出；输入覆盖 jpeg / png / webp / avif / gif(静态) / bmp /
//     tiff / ico / heic（HEIC 经 heic2any、TIFF 经 utif，均在引擎层动态 import）。
//   · SVG 光栅化（受控：Blob URL + <img>，脚本不执行、外部资源不加载）。
//   · 动图族（FFmpeg 引擎）：gif ↔ webp 互转（含 APNG 输入）、拆帧打包 ZIP、
//     截取第 N 帧、图片序列合成 GIF / 动画 WebP。
//
// 【纪律】
//   · 动画闸（plan §3.1）：静态边 match 要求 animated !== true，动图边要求 === true；
//     runner 内再断一次（execute 不复查 match）。**例外：多尺寸 ICO** —— inspect 把
//     「多张图」标成 animated，而 ICO 多尺寸是分辨率集合不是动画（见移交报告的
//     contractRequests），静态边对 ico 放行。
//   · LIMITS.image 是硬上限：字节直接判；像素 / 边长先按 inspect 判、解码后复核
//     （inspect 可能拿不到尺寸）。
//   · Canvas 编码 webp / avif 前再查一次能力报告（报告可能陈旧）；encodeCanvas
//     内部还会核对返回 MIME，拦截 Canvas 的静默回退。
//   · notices 如实列出有损 / 压平 / 代际损失 / 元数据不保留（roadmap §15）。
//   · 动图族的 ffmpeg argv 在**本文件内**拼装：engines/ffmpeg-args.ts 归音视频
//     owner 所有，且现有构造器把 fps/scale 滤镜写死（视频向），而「动图互转 /
//     拆帧」必须保留原始帧时序。形状与 ffmpeg-args.ts 同构（纯函数、结构化入参、
//     不含用户输入），后续可平移过去（已提 contractRequests）。
// ─────────────────────────────────────────────────────────────────────────────

import { FORMATS, IMAGE_QUALITY, LIMITS, formatBytes } from '../formats';
import { sniffBytes } from '../inspect';
import type {
  CategoryDef,
  ConvertError,
  ConvertResultData,
  FileKind,
  InspectInfo,
  ParamSpec,
  RunContext,
} from '../types';
import { convertedName } from '../utils';
import {
  ICO_MAX_SIDE,
  encodeBmp,
  encodeIcoPng,
  encodeTiffRgba,
  estimateRasterBytes,
  parseSvgSize,
  rgbaHasAlpha,
  type RasterEstimateFormat,
} from '../engines/image-codecs';
import {
  composeCentered,
  decodeStaticImage,
  downscaleToFit,
  downscaleToMaxWidth,
  encodeCanvas,
  flattenOntoBackground,
  canvasToRgba,
  rasterizeSvg,
} from '../engines/image-canvas';
import {
  assertEncoderAvailable,
  inputExtOf,
  loadEngine,
  numParam,
  strParam,
  takeOutput,
  throwIfAborted,
} from './audio';
// IoNames 是 ffmpeg-args 的词汇；audio.ts 只把它用于内部签名、并未再导出，
// 所以这里从定义处直接取（仅类型，不引入运行时依赖）。
import type { IoNames } from '../engines/ffmpeg-args';

// ─── 常量与小组件 ─────────────────────────────────────────────────────────────

/** 静态边的输入 kinds（svg 走独立边；xml 形态的 svg 由 svg-rasterize 接管）。 */
const STATIC_FROM: FileKind[] = ['jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'ico', 'heic'];

/** 动图边的输入 kinds（png 即 APNG —— 靠 animated 标记与静态 PNG 区分）。 */
const ANIM_FROM: FileKind[] = ['gif', 'webp', 'png'];

/** 已是有损编码的输入 kind（代际损失提示用）。 */
const LOSSY_INPUTS: ReadonlySet<string> = new Set(['jpeg', 'webp', 'avif', 'heic', 'gif']);

/** 拆帧单次导出上限（帧数）。防 MEMFS 与输出预算被超长动画撑爆。 */
const MAX_EXPORT_FRAMES = 200;

const MULTI_FILE_HINT = '多文件仅「图片序列 → 动图」支持';

const QUALITY_PARAM: ParamSpec = {
  key: 'quality',
  label: '质量',
  type: 'range',
  min: IMAGE_QUALITY.min,
  max: IMAGE_QUALITY.max,
  step: 1,
  defaultValue: IMAGE_QUALITY.defaultValue,
  help: '越高越清晰、体积越大',
};

const BACKGROUND_PARAM: ParamSpec = {
  key: 'background',
  label: '背景色',
  type: 'color',
  defaultValue: '#ffffff',
  help: '透明区域压平到该颜色',
};

const MAX_WIDTH_PARAM: ParamSpec = {
  key: 'maxWidth',
  label: '最大宽度',
  type: 'number',
  min: 0,
  max: LIMITS.image.maxSide,
  step: 10,
  defaultValue: 0,
  unit: 'px',
  advanced: true,
  help: '等比缩小到该宽度以内；0 或留空 = 不缩放',
};

function oversize(message: string): ConvertError {
  return { kind: 'oversize', message };
}

function unsupported(message: string): ConvertError {
  return { kind: 'unsupported', message };
}

function capabilityErr(message: string): ConvertError {
  return { kind: 'capability', message };
}

/** 单文件边的多文件守卫（maxFilesPerTask=200 是为图片序列开的，见 video.ts 同款）。 */
function assertSingleFile(ctx: RunContext): void {
  if (ctx.files.length !== 1) {
    throw unsupported(`该目标一次只处理一个图片文件（当前选了 ${ctx.files.length} 个）；${MULTI_FILE_HINT}`);
  }
}

/** 动画闸（静态侧）。多尺寸 ICO 豁免：它的「多张图」是分辨率集合，不是动画。 */
function isStaticImage(info: InspectInfo): boolean {
  return info.animated !== true || info.sniff.kind === 'ico';
}

/** #rrggbb 颜色参数解析；非法值回退默认（params 是 UI 冻结快照，仍防御性解析）。 */
function colorParam(params: Record<string, unknown>, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

/** LIMITS.image 硬上限。字节直接判；像素 / 边长给了才判（inspect 可能没拿到）。 */
function checkImageLimits(ctx: RunContext, width?: number, height?: number): void {
  if (ctx.file.size > LIMITS.image.maxBytes) {
    throw oversize(`文件 ${formatBytes(ctx.file.size)} 超过 ${formatBytes(LIMITS.image.maxBytes)} 上限`);
  }
  if (width && height) {
    if (width > LIMITS.image.maxSide || height > LIMITS.image.maxSide) {
      throw oversize(`图片尺寸 ${width}×${height} 超过边长 ${LIMITS.image.maxSide}px 上限`);
    }
    if (width * height > LIMITS.image.maxPixels) {
      throw oversize(`图片像素约 ${Math.round((width * height) / 1e6)} 百万，超过 ${LIMITS.image.maxPixels / 1e6} 百万像素上限`);
    }
  }
}

// ─── 静态管线公共件 ───────────────────────────────────────────────────────────

interface PreparedStatic {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  kind: FileKind;
  /** TIFF 输入的总页数。 */
  pages?: number;
}

/** 校验（单文件 / 动画闸 / 限额 / 能力）→ 解码 → 解码后复核限额。 */
async function prepareStatic(ctx: RunContext): Promise<PreparedStatic> {
  assertSingleFile(ctx);
  const kind = ctx.inspect?.sniff.kind;
  if (!kind || kind === 'unknown') throw unsupported('未能识别文件内容');
  if (ctx.inspect && !isStaticImage(ctx.inspect)) {
    throw unsupported('检测到这是动画图片，静态转换会丢弃动画；请改用「动图」分组的目标（互转 / 拆帧 / 截帧）');
  }
  checkImageLimits(ctx, ctx.inspect?.width, ctx.inspect?.height);
  if (kind === 'avif' && !ctx.capabilities.avifDecode) {
    throw capabilityErr('当前浏览器不能解码 AVIF，无法转换该文件');
  }
  // heic2any 是 WASM 引擎（首次下载组件），其余格式走浏览器原生解码
  ctx.onPhase(kind === 'heic' ? 'loading-engine' : 'converting');
  ctx.onProgress(0.1, '解码图片');
  const d = await decodeStaticImage(ctx.file, kind, ctx.signal);
  throwIfAborted(ctx.signal);
  checkImageLimits(ctx, d.width, d.height);
  ctx.onPhase('converting');
  return { ...d, kind };
}

/** 与输入相关的通用说明（EXIF 方向 / HEIC 主图 / TIFF 多页 / 元数据隐私）。 */
function inputNotices(prep: PreparedStatic): string[] {
  const notices: string[] = [];
  if (prep.kind === 'jpeg') notices.push('EXIF 方向已应用到像素');
  if (prep.kind === 'heic') notices.push('仅转换 HEIC 主图；HDR 与辅助图信息不保留');
  if (prep.pages && prep.pages > 1) notices.push(`多页 TIFF 仅转换第一页（共 ${prep.pages} 页）`);
  notices.push('元数据（EXIF 拍摄参数、位置信息等）不保留 —— 这同时也是隐私保护');
  return notices;
}

function imageResult(ctx: RunContext, blob: Blob, formatKey: 'jpg' | 'png' | 'webp' | 'avif' | 'bmp' | 'ico' | 'tiff', notices: string[]): ConvertResultData {
  const fmt = FORMATS[formatKey];
  const name = convertedName(ctx.file.name, fmt.ext, new Set());
  return {
    outputs: [{ blob, name }],
    mime: fmt.mime,
    ext: fmt.ext,
    inputSize: ctx.file.size,
    outputSize: blob.size,
    notices,
    previewKind: 'image',
  };
}

/** estimateOutput 公共件：有尺寸才估；maxWidth 先生效再估。 */
function estimateStatic(fmt: RasterEstimateFormat) {
  return (info: InspectInfo, params: Record<string, unknown>): number | null => {
    const w0 = info.width;
    const h0 = info.height;
    if (!w0 || !h0) return null;
    let w = w0;
    let h = h0;
    const mw = numParam(params, 'maxWidth', 0, 0, LIMITS.image.maxSide);
    if (mw > 0 && w > mw) {
      h = Math.max(1, Math.round((h * mw) / w));
      w = mw;
    }
    return estimateRasterBytes(fmt, w, h);
  };
}

// ─── 静态边 runner ────────────────────────────────────────────────────────────

async function runRasterTarget(ctx: RunContext, target: 'jpg' | 'png' | 'webp' | 'avif'): Promise<ConvertResultData> {
  const prep = await prepareStatic(ctx);
  const quality = numParam(ctx.params, 'quality', IMAGE_QUALITY.defaultValue, IMAGE_QUALITY.min, IMAGE_QUALITY.max);
  const bg = colorParam(ctx.params, 'background', '#ffffff');
  const mw = numParam(ctx.params, 'maxWidth', 0, 0, LIMITS.image.maxSide);

  // 能力复核（能力报告可能陈旧；encodeCanvas 里还有 MIME 核对兜底）
  if (target === 'webp' && !ctx.capabilities.webpEncode) throw capabilityErr('当前浏览器不支持编码 WebP');
  if (target === 'avif' && !ctx.capabilities.avifEncode) throw capabilityErr('当前浏览器不支持编码 AVIF');

  let work = prep.canvas;
  const scaled = mw > 0 && work.width > mw;
  work = downscaleToMaxWidth(work, mw);
  throwIfAborted(ctx.signal);

  // 透明探测（同时决定 JPG 是否压平与 notices 怎么写）
  ctx.onProgress(0.45, '处理像素');
  const hadAlpha = rgbaHasAlpha(canvasToRgba(work).rgba);
  if (target === 'jpg' && hadAlpha) {
    work = flattenOntoBackground(work, bg);
    throwIfAborted(ctx.signal);
  }

  ctx.onProgress(0.7, '编码输出');
  const blob = await encodeCanvas(work, FORMATS[target].mime, target === 'png' ? undefined : quality / 100, ctx.signal);
  throwIfAborted(ctx.signal);

  const notices: string[] = [];
  if (target === 'jpg') {
    notices.push(`有损重编码为 JPG（质量 ${quality}）`);
    if (LOSSY_INPUTS.has(prep.kind)) notices.push('源文件已是有损编码，再次压缩会进一步损失细节（代际损失）');
    if (hadAlpha) notices.push(`透明区域已压平为 ${bg} 背景色`);
  } else if (target === 'png') {
    notices.push('无损重编码为 PNG（不提升原图细节）');
    notices.push('PNG 体积通常比有损格式更大');
  } else if (target === 'webp') {
    notices.push(`重编码为 WebP（质量 ${quality}，有损）`);
    if (LOSSY_INPUTS.has(prep.kind)) notices.push('源文件已是有损编码，再次压缩会进一步损失细节（代际损失）');
  } else {
    notices.push(`重编码为 AVIF（质量 ${quality}，有损）`);
    notices.push('AVIF 是较新的格式，旧设备 / 旧软件可能无法打开');
    if (LOSSY_INPUTS.has(prep.kind)) notices.push('源文件已是有损编码，再次压缩会进一步损失细节（代际损失）');
  }
  if (scaled) notices.push(`已等比缩放到宽度 ≤ ${mw}px`);
  notices.push(...inputNotices(prep));
  return imageResult(ctx, blob, target, notices);
}

async function runToBmp(ctx: RunContext): Promise<ConvertResultData> {
  const prep = await prepareStatic(ctx);
  ctx.onProgress(0.6, '编码输出');
  const rgba = canvasToRgba(prep.canvas);
  const withAlpha = rgbaHasAlpha(rgba.rgba);
  const bytes = encodeBmp(rgba, { withAlpha });
  throwIfAborted(ctx.signal);
  const notices = ['无压缩 BMP，体积通常明显增大'];
  if (withAlpha) notices.push('已写入 32 位带透明通道的 BMP；少数旧查看器会忽略透明通道（显示为不透明）');
  notices.push(...inputNotices(prep));
  return imageResult(ctx, new Blob([bytes as BlobPart], { type: FORMATS.bmp.mime }), 'bmp', notices);
}

async function runToIco(ctx: RunContext): Promise<ConvertResultData> {
  const prep = await prepareStatic(ctx);
  let work = prep.canvas;
  const resized = work.width > ICO_MAX_SIDE || work.height > ICO_MAX_SIDE;
  work = downscaleToFit(work, ICO_MAX_SIDE);
  ctx.onProgress(0.6, '编码输出');
  const pngBlob = await encodeCanvas(work, FORMATS.png.mime, undefined, ctx.signal);
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const bytes = encodeIcoPng(pngBytes, work.width, work.height);
  throwIfAborted(ctx.signal);
  const notices = ['打包为 PNG-in-ICO（Windows Vista 起与现代浏览器均支持），透明保留'];
  if (resized) notices.push(`已等比缩放到 ${work.width}×${work.height}（图标边长上限 ${ICO_MAX_SIDE}px）`);
  notices.push(...inputNotices(prep));
  return imageResult(ctx, new Blob([bytes as BlobPart], { type: FORMATS.ico.mime }), 'ico', notices);
}

async function runToTiff(ctx: RunContext): Promise<ConvertResultData> {
  const prep = await prepareStatic(ctx);
  ctx.onProgress(0.6, '编码输出');
  const bytes = await encodeTiffRgba(canvasToRgba(prep.canvas));
  throwIfAborted(ctx.signal);
  const notices = ['无压缩 TIFF（8 位 RGBA），体积通常明显增大'];
  notices.push(...inputNotices(prep));
  return imageResult(ctx, new Blob([bytes as BlobPart], { type: FORMATS.tiff.mime }), 'tiff', notices);
}

async function runSvgRasterize(ctx: RunContext): Promise<ConvertResultData> {
  assertSingleFile(ctx);
  if (ctx.file.size > LIMITS.image.maxBytes) {
    throw oversize(`文件 ${formatBytes(ctx.file.size)} 超过 ${formatBytes(LIMITS.image.maxBytes)} 上限`);
  }
  ctx.onPhase('converting');
  ctx.onProgress(0.1, '解析 SVG');
  const bytes = new Uint8Array(await ctx.file.arrayBuffer());
  throwIfAborted(ctx.signal);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // 核正文（probe 的 extra.svg 只是菜单判据；execute 不复查 match，这里自己断）
  if (!/<svg[\s>]/i.test(text)) throw unsupported('文件内容中没有 <svg> 根元素，不是可光栅化的 SVG');
  const intrinsic = parseSvgSize(text);

  const reqW = numParam(ctx.params, 'width', 0, 0, LIMITS.image.maxSide);
  const reqH = numParam(ctx.params, 'height', 0, 0, LIMITS.image.maxSide);
  // 尺寸决策：显式参数 > SVG 自身尺寸（保持纵横比补齐缺的一侧）> 1024
  const ratio = intrinsic.width && intrinsic.height ? intrinsic.width / intrinsic.height : null;
  let w: number | null = reqW > 0 ? reqW : intrinsic.width ? Math.round(intrinsic.width) : null;
  let h: number | null = reqH > 0 ? reqH : intrinsic.height ? Math.round(intrinsic.height) : null;
  if (w !== null && h === null) h = ratio ? Math.max(1, Math.round(w / ratio)) : w;
  if (h !== null && w === null) w = ratio ? Math.max(1, Math.round(h * ratio)) : h;
  w ??= 1024;
  h ??= 1024;
  // 收敛到限额（SVG 自身尺寸不受控：它是矢量，声明多大都有可能）
  let clamped = false;
  if (w > LIMITS.image.maxSide) {
    h = Math.max(1, Math.round((h * LIMITS.image.maxSide) / w));
    w = LIMITS.image.maxSide;
    clamped = true;
  }
  if (h > LIMITS.image.maxSide) {
    w = Math.max(1, Math.round((w * LIMITS.image.maxSide) / h));
    h = LIMITS.image.maxSide;
    clamped = true;
  }
  if (w * h > LIMITS.image.maxPixels) {
    const s = Math.sqrt(LIMITS.image.maxPixels / (w * h));
    w = Math.max(1, Math.floor(w * s));
    h = Math.max(1, Math.floor(h * s));
    clamped = true;
  }

  const flatten = ctx.params.flatten === true;
  const bg = colorParam(ctx.params, 'background', '#ffffff');
  ctx.onProgress(0.35, '光栅化');
  const canvas = await rasterizeSvg(bytes, { width: w, height: h, background: flatten ? bg : null }, ctx.signal);
  ctx.onProgress(0.7, '编码输出');
  const blob = await encodeCanvas(canvas, FORMATS.png.mime, undefined, ctx.signal);
  throwIfAborted(ctx.signal);

  const notices = [
    'SVG 已光栅化为 PNG 位图：矢量结构不再保留（放大不再无损）',
    '在纯图片上下文渲染：SVG 内的脚本不会执行、外部引用不会加载',
    '字体与滤镜效果以浏览器渲染为准，可能与设计软件略有差异',
    flatten ? `已铺 ${bg} 背景色` : '透明区域原样保留',
  ];
  if (clamped) notices.push(`输出尺寸已按限额收敛到 ${w}×${h}`);
  return imageResult(ctx, blob, 'png', notices);
}

// ─── 动图 ffmpeg argv（本地拼装，理由见文件头纪律）─────────────────────────────

const FF_HEAD = ['-hide_banner', '-nostdin'] as const;

/** 动图 → 动画 WebP：**不加 fps / scale 滤镜**，保留原始帧时序（互转不是重采样）。 */
function buildAnimToWebpArgs(io: IoNames): string[] {
  return [...FF_HEAD, '-i', io.inputName, '-map_metadata', '-1', '-c:v', 'libwebp', '-q:v', '80', '-loop', '0', '-y', io.outputName];
}

/** 动图 → GIF 双遍（先专用调色板再渲染；单遍是通用 256 色，渐变必花）。 */
function buildAnimGifPaletteArgs(inputName: string, paletteName: string): string[] {
  return [...FF_HEAD, '-i', inputName, '-vf', 'palettegen', '-y', paletteName];
}

function buildAnimGifRenderArgs(inputName: string, paletteName: string, outputName: string): string[] {
  return [...FF_HEAD, '-i', inputName, '-i', paletteName, '-filter_complex', '[0:v][1:v]paletteuse', '-map_metadata', '-1', '-loop', '0', '-y', outputName];
}

/** 拆帧：每帧一张 PNG（ffmpeg 的 gif / webp / apng 解码器输出的都是合成后的完整帧）。 */
function buildAnimToFramesArgs(inputName: string, outputPattern: string, maxFrames: number): string[] {
  return [...FF_HEAD, '-i', inputName, '-map_metadata', '-1', '-vsync', '0', '-frames:v', String(maxFrames), '-y', outputPattern];
}

/** 截取第 N 帧（frameIndex0 从 0 起）。 */
function buildFramePickArgs(inputName: string, outputName: string, frameIndex0: number): string[] {
  return [...FF_HEAD, '-i', inputName, '-vf', `select=eq(n\\,${frameIndex0})`, '-vsync', '0', '-frames:v', '1', '-y', outputName];
}

/** 图片序列 → 动图（输入已统一改名为 img-%04d.png 且对齐到同一画布）。 */
function buildFramesToWebpArgs(inputPattern: string, outputName: string, fps: number): string[] {
  return [...FF_HEAD, '-framerate', String(fps), '-start_number', '0', '-i', inputPattern, '-map_metadata', '-1', '-c:v', 'libwebp', '-q:v', '80', '-loop', '0', '-y', outputName];
}

function buildFramesGifPaletteArgs(inputPattern: string, paletteName: string, fps: number): string[] {
  return [...FF_HEAD, '-framerate', String(fps), '-start_number', '0', '-i', inputPattern, '-vf', 'palettegen', '-y', paletteName];
}

function buildFramesGifRenderArgs(inputPattern: string, paletteName: string, outputName: string, fps: number): string[] {
  return [
    ...FF_HEAD, '-framerate', String(fps), '-start_number', '0', '-i', inputPattern, '-i', paletteName,
    '-filter_complex', '[0:v][1:v]paletteuse', '-map_metadata', '-1', '-loop', '0', '-y', outputName,
  ];
}

// ─── 动图边 runner ────────────────────────────────────────────────────────────

/** 动图边公共前置：单文件 / 动画闸 / 限额 → 加载引擎 → 读字节。 */
async function prepareAnim(ctx: RunContext): Promise<{ eng: Awaited<ReturnType<typeof loadEngine>>; bytes: Uint8Array; inputName: string }> {
  assertSingleFile(ctx);
  const kind = ctx.inspect?.sniff.kind;
  if (!kind || kind === 'unknown') throw unsupported('未能识别文件内容');
  if (ctx.inspect && ctx.inspect.animated !== true) {
    throw unsupported('未检测到动画标记；静态图片请使用静态转换目标');
  }
  checkImageLimits(ctx, ctx.inspect?.width, ctx.inspect?.height);
  const eng = await loadEngine(ctx);
  const bytes = new Uint8Array(await ctx.file.arrayBuffer());
  throwIfAborted(ctx.signal);
  return { eng, bytes, inputName: `input.${inputExtOf(ctx)}` };
}

async function runAnimConvert(ctx: RunContext): Promise<ConvertResultData> {
  const { eng, bytes, inputName } = await prepareAnim(ctx);
  const format = strParam(ctx.params, 'format', ['webp', 'gif'], 'webp');
  if (format === 'webp') assertEncoderAvailable(ctx.capabilities, 'libwebp');
  const outputName = `output.${format}`;
  ctx.onPhase('converting');

  let out: Uint8Array;
  if (format === 'gif') {
    // 双遍：专用调色板
    const paletteName = 'palette.png';
    const r1 = await eng.exec(buildAnimGifPaletteArgs(inputName, paletteName), [{ name: inputName, data: bytes }], [paletteName], {
      timeoutMs: LIMITS.timeouts.transcodeVideoMs,
      onProgress: (p) => ctx.onProgress(p === null ? null : p * 0.4),
      signal: ctx.signal,
    });
    throwIfAborted(ctx.signal);
    const palette = takeOutput(r1.files, paletteName, r1.log);
    const r2 = await eng.exec(
      buildAnimGifRenderArgs(inputName, paletteName, outputName),
      [
        { name: inputName, data: bytes },
        { name: paletteName, data: palette },
      ],
      [outputName],
      {
        timeoutMs: LIMITS.timeouts.transcodeVideoMs,
        onProgress: (p) => ctx.onProgress(p === null ? null : 0.4 + p * 0.6),
        signal: ctx.signal,
      }
    );
    out = takeOutput(r2.files, outputName, r2.log);
  } else {
    const r = await eng.exec(buildAnimToWebpArgs({ inputName, outputName }), [{ name: inputName, data: bytes }], [outputName], {
      timeoutMs: LIMITS.timeouts.transcodeVideoMs,
      onProgress: (p) => ctx.onProgress(p),
      signal: ctx.signal,
    });
    throwIfAborted(ctx.signal);
    out = takeOutput(r.files, outputName, r.log);
  }
  throwIfAborted(ctx.signal);

  const notices =
    format === 'gif'
      ? [
          '动图重编码为 GIF（256 色调色板，颜色可能有失真）',
          '帧时序保留；循环统一为无限循环（原始循环次数不保留）',
          '元数据不保留',
        ]
      : [
          '动图重编码为动画 WebP（质量 80，有损）',
          '帧时序保留；循环统一为无限循环（原始循环次数不保留）',
          '元数据不保留',
        ];
  const fmt = FORMATS[format as 'gif' | 'webp'];
  const name = convertedName(ctx.file.name, fmt.ext, new Set());
  return {
    outputs: [{ blob: new Blob([out as BlobPart], { type: fmt.mime }), name }],
    mime: fmt.mime,
    ext: fmt.ext,
    inputSize: ctx.file.size,
    outputSize: out.byteLength,
    notices,
    previewKind: 'image',
  };
}

async function runAnimToFrames(ctx: RunContext): Promise<ConvertResultData> {
  const { eng, bytes, inputName } = await prepareAnim(ctx);
  const pattern = 'frame-%04d.png';
  // 多要一帧作为「超限」的精确判据：拿到第 201 帧 = 帧数 > 200，明确报错而非静默截断
  const wanted = Array.from({ length: MAX_EXPORT_FRAMES + 1 }, (_, i) => `frame-${String(i + 1).padStart(4, '0')}.png`);
  ctx.onPhase('converting');
  const { files, log } = await eng.exec(buildAnimToFramesArgs(inputName, pattern, MAX_EXPORT_FRAMES + 1), [{ name: inputName, data: bytes }], wanted, {
    timeoutMs: LIMITS.timeouts.transcodeVideoMs,
    onProgress: (p) => ctx.onProgress(p === null ? null : p * 0.8),
    signal: ctx.signal,
  });
  throwIfAborted(ctx.signal);
  const frames = wanted.map((n) => files.get(n)).filter((b): b is Uint8Array => !!b && b.byteLength > 0);
  if (frames.length === 0) {
    throw { kind: 'corrupt', message: '未能从该动画中抽取出任何帧', detail: log.slice(-1500) } satisfies ConvertError;
  }
  if (frames.length > MAX_EXPORT_FRAMES) {
    throw oversize(`动画超过 ${MAX_EXPORT_FRAMES} 帧，超出单次导出上限`);
  }

  ctx.onProgress(0.85, '打包 ZIP');
  const { zipSync } = await import('fflate');
  const record: Record<string, Uint8Array> = {};
  frames.forEach((b, i) => {
    record[`frame-${String(i + 1).padStart(4, '0')}.png`] = b;
  });
  // level 0：PNG 本身已压缩，再压只费时间
  const zip = zipSync(record, { level: 0 });
  throwIfAborted(ctx.signal);

  const name = convertedName(ctx.file.name, 'zip', new Set());
  return {
    outputs: [{ blob: new Blob([zip as BlobPart], { type: FORMATS.zip.mime }), name }],
    mime: FORMATS.zip.mime,
    ext: 'zip',
    inputSize: ctx.file.size,
    outputSize: zip.byteLength,
    notices: [`逐帧导出为 ${frames.length} 张 PNG（每个显示时刻的完整画面，局部帧已合成），已打包为 ZIP`, '元数据不保留'],
    previewKind: 'none',
  };
}

async function runAnimFramePick(ctx: RunContext): Promise<ConvertResultData> {
  const { eng, bytes, inputName } = await prepareAnim(ctx);
  const frame = numParam(ctx.params, 'frame', 1, 1, 100000);
  const outputName = 'frame.png';
  ctx.onPhase('converting');
  const { files, log } = await eng.exec(buildFramePickArgs(inputName, outputName, frame - 1), [{ name: inputName, data: bytes }], [outputName], {
    timeoutMs: LIMITS.timeouts.transcodeVideoMs,
    onProgress: (p) => ctx.onProgress(p),
    signal: ctx.signal,
  });
  throwIfAborted(ctx.signal);
  const out = files.get(outputName);
  if (!out || out.byteLength === 0) {
    throw unsupported(`第 ${frame} 帧不存在（该动画的帧数更少）`);
  }
  const name = convertedName(ctx.file.name, 'png', new Set());
  return {
    outputs: [{ blob: new Blob([out as BlobPart], { type: FORMATS.png.mime }), name }],
    mime: FORMATS.png.mime,
    ext: 'png',
    inputSize: ctx.file.size,
    outputSize: out.byteLength,
    notices: [`仅导出第 ${frame} 帧的静态 PNG，动画不保留`, '元数据不保留'],
    previewKind: 'image',
  };
}

async function runFramesToAnim(ctx: RunContext): Promise<ConvertResultData> {
  const files = ctx.files;
  if (files.length < 2) {
    throw unsupported(`图片序列合成动图至少需要 2 张图片（当前 ${files.length} 张）`);
  }
  const format = strParam(ctx.params, 'format', ['gif', 'webp'], 'gif');
  const fps = numParam(ctx.params, 'fps', 10, 1, 30);
  if (format === 'webp') assertEncoderAvailable(ctx.capabilities, 'libwebp');
  for (const f of files) {
    if (f.size > LIMITS.image.maxBytes) {
      throw oversize(`文件 ${f.name} 为 ${formatBytes(f.size)}，超过 ${formatBytes(LIMITS.image.maxBytes)} 上限`);
    }
  }

  const eng = await loadEngine(ctx);
  ctx.onPhase('converting');

  // 第一遍：只读头部字节 —— 逐张复核「真的是静态 PNG / JPG」并取尺寸，定统一画布
  ctx.onProgress(0.02, '校验图片序列');
  let canvasW = 0;
  let canvasH = 0;
  for (const f of files) {
    throwIfAborted(ctx.signal);
    const head = new Uint8Array(await f.slice(0, 64 * 1024).arrayBuffer());
    const sniff = sniffBytes(head);
    if (sniff.kind !== 'png' && sniff.kind !== 'jpeg') {
      throw unsupported(`「${f.name}」不是 PNG / JPG 图片（识别为 ${sniff.kind}）`);
    }
  }

  // 第二遍：逐张解码 → 居中画到统一画布 → PNG 字节（对齐画布，roadmap I13）。
  // 流式处理：同一时刻只持有一张解码结果，不为 200 张图同时占内存。
  const pngInputs: { name: string; data: Uint8Array }[] = [];
  const decodedDims: { w: number; h: number }[] = [];
  for (let i = 0; i < files.length; i++) {
    throwIfAborted(ctx.signal);
    const d = await decodeStaticImage(files[i], sniffBytes(new Uint8Array(await files[i].slice(0, 64 * 1024).arrayBuffer())).kind, ctx.signal);
    if (ctx.signal.aborted) throwIfAborted(ctx.signal);
    if (d.width > LIMITS.image.maxSide || d.height > LIMITS.image.maxSide) {
      throw oversize(`「${files[i].name}」尺寸 ${d.width}×${d.height} 超过边长 ${LIMITS.image.maxSide}px 上限`);
    }
    decodedDims.push({ w: d.width, h: d.height });
    canvasW = Math.max(canvasW, d.width);
    canvasH = Math.max(canvasH, d.height);
    if (canvasW * canvasH > LIMITS.image.maxPixels) {
      throw oversize(`统一画布超过 ${LIMITS.image.maxPixels / 1e6} 百万像素上限（序列尺寸不一致时按最大宽 × 最大高对齐）`);
    }
    const composed = composeCentered(d.canvas, canvasW, canvasH);
    const pngBlob = await encodeCanvas(composed, FORMATS.png.mime, undefined, ctx.signal);
    pngInputs.push({ name: `img-${String(i).padStart(4, '0')}.png`, data: new Uint8Array(await pngBlob.arrayBuffer()) });
    ctx.onProgress(0.05 + (0.45 * (i + 1)) / files.length, `处理第 ${i + 1} / ${files.length} 张`);
  }
  void decodedDims;

  const pattern = 'img-%04d.png';
  const outputName = `output.${format}`;
  let out: Uint8Array;
  if (format === 'gif') {
    const paletteName = 'palette.png';
    const r1 = await eng.exec(buildFramesGifPaletteArgs(pattern, paletteName, fps), pngInputs, [paletteName], {
      timeoutMs: LIMITS.timeouts.transcodeVideoMs,
      onProgress: (p) => ctx.onProgress(p === null ? null : 0.5 + p * 0.2),
      signal: ctx.signal,
    });
    throwIfAborted(ctx.signal);
    const palette = takeOutput(r1.files, paletteName, r1.log);
    const r2 = await eng.exec(buildFramesGifRenderArgs(pattern, paletteName, outputName, fps), [...pngInputs, { name: paletteName, data: palette }], [outputName], {
      timeoutMs: LIMITS.timeouts.transcodeVideoMs,
      onProgress: (p) => ctx.onProgress(p === null ? null : 0.7 + p * 0.3),
      signal: ctx.signal,
    });
    out = takeOutput(r2.files, outputName, r2.log);
  } else {
    const r = await eng.exec(buildFramesToWebpArgs(pattern, outputName, fps), pngInputs, [outputName], {
      timeoutMs: LIMITS.timeouts.transcodeVideoMs,
      onProgress: (p) => ctx.onProgress(p === null ? null : 0.5 + p * 0.5),
      signal: ctx.signal,
    });
    throwIfAborted(ctx.signal);
    out = takeOutput(r.files, outputName, r.log);
  }
  throwIfAborted(ctx.signal);

  const fmt = FORMATS[format as 'gif' | 'webp'];
  const notices =
    format === 'gif'
      ? [
          `合成 GIF 动图（${files.length} 帧，${fps} fps）`,
          'GIF 为 256 色调色板，颜色可能有失真',
          '画布已对齐为序列最大尺寸，较小图片居中、空余部分透明',
          '循环为无限循环；元数据不保留',
        ]
      : [
          `合成动画 WebP（${files.length} 帧，${fps} fps，质量 80 有损）`,
          '画布已对齐为序列最大尺寸，较小图片居中、空余部分透明',
          '循环为无限循环；元数据不保留',
        ];
  const name = convertedName(files[0].name, fmt.ext, new Set());
  return {
    outputs: [{ blob: new Blob([out as BlobPart], { type: fmt.mime }), name }],
    mime: fmt.mime,
    ext: fmt.ext,
    inputSize: files.reduce((s, f) => s + f.size, 0),
    outputSize: out.byteLength,
    notices,
    previewKind: 'image',
  };
}

// ─── 类别定义 ─────────────────────────────────────────────────────────────────

export const CATEGORY: CategoryDef = {
  key: 'image',
  label: '图片',
  hint: 'JPG / PNG / WebP / AVIF / GIF / BMP / TIFF / ICO / HEIC 互转，SVG 光栅化，动图互转与拆帧；图片序列可合成动图。单张 ≤ 20 MiB、≤ 1600 万像素。文件只在本机处理。',
  accept: '.jpg,.jpeg,.png,.webp,.avif,.gif,.bmp,.tif,.tiff,.ico,.heic,.heif,.svg',
  maxFilesPerTask: 200,
  edges: [
    {
      id: 'image:to-jpg',
      label: 'JPG（便于分享）',
      from: STATIC_FROM,
      to: 'jpg',
      method: 'reencode',
      notices: ['有损重编码', '透明区域压平到所选背景色', '元数据（EXIF / 位置信息）不保留 —— 同时也是隐私保护'],
      params: [QUALITY_PARAM, BACKGROUND_PARAM, MAX_WIDTH_PARAM],
      match: isStaticImage,
      estimateOutput: estimateStatic('jpeg'),
      run: (ctx) => runRasterTarget(ctx, 'jpg'),
      status: 'live',
      group: '静态互转',
    },
    {
      id: 'image:to-png',
      label: 'PNG（无损，保留透明）',
      from: STATIC_FROM,
      to: 'png',
      method: 'reencode',
      notices: ['无损重编码（不提升原图细节）', '体积通常比有损格式更大', '元数据不保留'],
      params: [],
      match: isStaticImage,
      estimateOutput: estimateStatic('png'),
      run: (ctx) => runRasterTarget(ctx, 'png'),
      status: 'live',
      group: '静态互转',
    },
    {
      id: 'image:to-webp',
      label: 'WebP（网页小体积）',
      from: STATIC_FROM,
      to: 'webp',
      method: 'reencode',
      notices: ['有损重编码', '元数据不保留'],
      params: [QUALITY_PARAM, MAX_WIDTH_PARAM],
      match: isStaticImage,
      requires: ['webp-encode'],
      estimateOutput: estimateStatic('webp'),
      run: (ctx) => runRasterTarget(ctx, 'webp'),
      status: 'live',
      group: '静态互转',
    },
    {
      id: 'image:to-avif',
      label: 'AVIF（压缩率更高，格式较新）',
      from: STATIC_FROM,
      to: 'avif',
      method: 'reencode',
      notices: ['有损重编码', 'AVIF 是较新的格式，旧设备 / 旧软件可能无法打开', '元数据不保留'],
      params: [QUALITY_PARAM, MAX_WIDTH_PARAM],
      match: isStaticImage,
      requires: ['avif-encode'],
      estimateOutput: estimateStatic('avif'),
      run: (ctx) => runRasterTarget(ctx, 'avif'),
      status: 'live',
      group: '静态互转',
    },
    {
      id: 'image:to-bmp',
      label: 'BMP（无压缩位图）',
      from: STATIC_FROM,
      to: 'bmp',
      method: 'reencode',
      notices: ['无压缩 BMP，体积通常明显增大', '含透明时写入 32 位 BMP，少数旧查看器会忽略透明通道', '元数据不保留'],
      params: [],
      match: isStaticImage,
      estimateOutput: estimateStatic('bmp'),
      run: runToBmp,
      status: 'live',
      group: '图标与特殊格式',
    },
    {
      id: 'image:to-ico',
      label: 'ICO（网站 / 应用图标）',
      from: STATIC_FROM,
      to: 'ico',
      method: 'reencode',
      notices: [`等比缩放到边长 ≤ ${ICO_MAX_SIDE}px`, '打包为 PNG-in-ICO（Vista 起 Windows 与现代浏览器均支持）', '元数据不保留'],
      params: [],
      match: isStaticImage,
      estimateOutput: estimateStatic('ico'),
      run: runToIco,
      status: 'live',
      group: '图标与特殊格式',
    },
    {
      id: 'image:to-tiff',
      label: 'TIFF（印刷 / 存档）',
      from: STATIC_FROM,
      to: 'tiff',
      method: 'reencode',
      notices: ['无压缩 TIFF（8 位 RGBA），体积通常明显增大', '多页 TIFF 源仅转换第一页', '元数据不保留'],
      params: [],
      match: isStaticImage,
      estimateOutput: estimateStatic('tiff'),
      run: runToTiff,
      status: 'live',
      group: '图标与特殊格式',
    },
    {
      id: 'image:svg-rasterize',
      label: 'PNG（SVG 矢量图光栅化）',
      // sniff 把 SVG 文本识别为 xml（契约层现状）；probe 会把含 <svg> 根元素的标出来
      from: ['svg', 'xml'],
      to: 'png',
      method: 'reencode',
      notices: ['光栅化为位图：矢量结构不再保留（放大不再无损）', '纯图片上下文渲染：SVG 内脚本不会执行、外部引用不会加载'],
      params: [
        {
          key: 'width',
          label: '输出宽度',
          type: 'number',
          min: 0,
          max: LIMITS.image.maxSide,
          step: 1,
          defaultValue: 0,
          unit: 'px',
          help: '0 = 用 SVG 自身尺寸（缺省 1024）；只填一边时按比例补齐',
        },
        {
          key: 'height',
          label: '输出高度',
          type: 'number',
          min: 0,
          max: LIMITS.image.maxSide,
          step: 1,
          defaultValue: 0,
          unit: 'px',
          help: '0 = 用 SVG 自身尺寸（缺省 1024）',
        },
        {
          key: 'flatten',
          label: '铺背景色',
          type: 'checkbox',
          defaultValue: false,
          help: '默认保留透明背景',
        },
        { ...BACKGROUND_PARAM, visibleIf: (params) => params.flatten === true },
      ],
      match: (info) => info.sniff.kind === 'svg' || (info.sniff.kind === 'xml' && info.extra?.svg === '1'),
      estimateOutput: () => null,
      run: runSvgRasterize,
      status: 'live',
      group: '矢量图',
    },
    {
      id: 'image:anim-convert',
      label: 'GIF / 动画 WebP（动图互转）',
      from: ANIM_FROM,
      to: 'webp',
      method: 'reencode',
      notices: ['保留帧时序；循环统一为无限循环', 'GIF 只有 256 色，转 GIF 颜色可能有失真', '元数据不保留'],
      params: [
        {
          key: 'format',
          label: '目标格式',
          type: 'select',
          options: [
            { value: 'webp', label: '动画 WebP（体积小）' },
            { value: 'gif', label: 'GIF（兼容性最好）' },
          ],
          defaultValue: 'webp',
        },
      ],
      match: (info) => info.animated === true,
      requires: ['worker', 'ffmpeg'],
      estimateOutput: (info) => info.size,
      run: runAnimConvert,
      status: 'live',
      group: '动图',
    },
    {
      id: 'image:anim-to-frames',
      label: '逐帧 PNG 打包 ZIP（动图拆帧）',
      from: ANIM_FROM,
      to: 'zip',
      method: 'extract',
      notices: [`每个显示时刻的完整画面各导出一张 PNG（单次最多 ${MAX_EXPORT_FRAMES} 帧）`, '元数据不保留'],
      params: [],
      match: (info) => info.animated === true,
      requires: ['worker', 'ffmpeg'],
      estimateOutput: () => null,
      run: runAnimToFrames,
      status: 'live',
      group: '动图',
    },
    {
      id: 'image:anim-frame-pick',
      label: 'PNG（截取动图第 N 帧）',
      from: ANIM_FROM,
      to: 'png',
      method: 'extract',
      notices: ['仅导出所选帧的静态 PNG，动画不保留', '元数据不保留'],
      params: [
        { key: 'frame', label: '帧序号', type: 'number', min: 1, max: 100000, step: 1, defaultValue: 1, help: '从 1 开始数' },
      ],
      match: (info) => info.animated === true,
      requires: ['worker', 'ffmpeg'],
      estimateOutput: estimateStatic('png'),
      run: runAnimFramePick,
      status: 'live',
      group: '动图',
    },
    {
      id: 'image:frames-to-anim',
      label: 'GIF / WebP 动图（图片序列合成）',
      from: ['png', 'jpeg'],
      to: 'gif',
      method: 'reencode',
      notices: ['画布对齐为序列最大尺寸，较小图片居中、空余部分透明', '循环为无限循环', '元数据不保留'],
      params: [
        { key: 'fps', label: '帧率', type: 'number', min: 1, max: 30, step: 1, defaultValue: 10, unit: 'fps' },
        {
          key: 'format',
          label: '目标格式',
          type: 'select',
          options: [
            { value: 'gif', label: 'GIF（兼容性最好）' },
            { value: 'webp', label: '动画 WebP（体积小）' },
          ],
          defaultValue: 'gif',
        },
      ],
      match: isStaticImage,
      requires: ['worker', 'ffmpeg'],
      estimateOutput: () => null,
      run: runFramesToAnim,
      status: 'live',
      group: '动图',
    },
  ],
  // probe：SVG 在 sniff 层是 'xml'（契约层现状）—— 读头确认 <svg> 根元素，
  // 给 svg-rasterize 的 match 提供判据。失败降级 {}（只是菜单不显示该目标，runner
  // 仍会自己核正文）。
  probe: async (file, info) => {
    try {
      if (info.sniff.kind !== 'xml' && info.sniff.kind !== 'svg') return {};
      const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
      const text = new TextDecoder('utf-8', { fatal: false }).decode(head);
      return /<svg[\s>]/i.test(text) ? { extra: { ...(info.extra ?? {}), svg: '1' } } : {};
    } catch {
      return {};
    }
  },
};
