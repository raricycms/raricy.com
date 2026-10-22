// ─────────────────────────────────────────────────────────────────────────────
// image-sniff.ts — 「这串字节到底是什么图片」的**单一真相源**（零依赖、零 import）
//
// 【为什么单独成模块】image-upload.ts 拖着 node:fs / sharp / prisma，进不了浏览器包；
// 而「上传前先在浏览器里认一遍」是兼容 iPhone HEIC 的唯一低成本办法 —— 服务端的 sharp
// 预编译版只带 AVIF 那一路 libheif（没有 HEVC 解码器），HEIC 必须在浏览器里用 heic2any
// 就地转成 JPEG 再上传。两边用同一份判定，才不会出现「客户端放行、服务端拒绝」这类
// **不报错的分歧**。
//
// 【安全契约（别退回去）】落库的 mimeType **永远来自字节**，绝不来自声明：
//   · 声明（`<input accept>` / `Content-Type` / 扩展名）是浏览器、甚至是攻击者说了算的
//     **提示值**；服务端只把它当「用户以为这是什么」。
//   · 唯一收窄的是 SVG：只有「内容与声明都是 SVG」才收。理由是纵深防御 + 语义正确：
//     raw 路由对 SVG 强制 `Content-Disposition: attachment`，那条分支按**落库的** mimeType
//     判；SVG 字节若以位图类型落库，attachment 分支就不触发。当下还有 `nosniff` 兜底，
//     所以「浏览器照着 image/png 去渲染 SVG」这条路**现在**走不通 —— 但闸门不该只有一道，
//     哪天换了下发路径 / 加了不设 nosniff 的读口，这个洞就成了同源存储型 XSS。
//   · 位图之间的「声明不符」**不是安全事件**，只是名字错了：PNG 存成 .jpg、Windows 给
//     空 type、iOS 把 HEIC 报成 image/jpeg —— 按内容纠正即可，不用拒。
//
// 【HEIC / 实况照片】iPhone 的静帧是 HEIC（ISOBMFF/ftyp），实况照片另带一段 .MOV。
// 这里只做**识别**（heic / avif / video），转码是调用方的事：
//   · 浏览器：heic2any → JPEG（见 image-client.ts 的 prepareImageFile）；
//   · 服务端：没有解码器，按 reason 回一句能行动的提示（见 api/images/route.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 图床白名单里的五种。加格式要同时改三处：本表、`EXTENSION_FOR_MIME`、
 * `src/lib/image-sniff.ts` 的判定分支（以及客户端 accept —— 那是另一份口径，含 HEIC）。
 */
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';

export const UPLOAD_IMAGE_MIMES: readonly ImageMime[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

/** 位图那四种（不含 SVG）：讨论 / 评论 / 编辑器只收这一档（见 image-client.ts 的 `UPLOAD_IMAGE_TYPES`）。 */
export const BITMAP_IMAGE_MIMES: readonly ImageMime[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** MIME → 规范扩展名（**含点**）。落盘路径与回显文件名都读这一份，别各写一张表。 */
export const EXTENSION_FOR_MIME: Record<ImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

// 常见图片后缀。只用来判断「用户给的后缀是不是一个**认识的**图片后缀」，
// 不认识的后缀一律在末尾补，不做替换（别把 `Screenshot 2026.10.22` 那种名字截成 2026.10）。
//
// 用 Set 而不是 `Object.hasOwn`：这个函数在**每一张被接受的上传**上都会跑于浏览器里，
// 而 `Object.hasOwn` 是 ES2022 —— 老设备（iOS 13 时代的 Safari）会在这里抛 TypeError，
// 表现是「点上传毫无反应」。
const KNOWN_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.heic',
  '.heif',
  '.avif',
  '.bmp',
  '.tif',
  '.tiff',
]);

/**
 * 让**回显 / 落库的文件名**与内容类型一致。
 *
 * 只改后缀，不动主体：`.jpg` 却是 PNG 字节 → `.png`；没有后缀 → 补一个；后缀不认识
 * （`foo.bin`）→ 在末尾补（`foo.bin.png`）而不是把它当扩展名替换掉 —— 宁可名字长
 * 一点，也别把用户名字里的一段吃掉。`.jpeg` 与 `.jpg` 视为等价，不做无意义的互换。
 *
 * 服务端（落库 / 图床卡片 / 下载名）与浏览器侧（上传前重命名）共用这一份。
 */
export function filenameWithMimeExtension(
  name: string,
  mimeType: string | null | undefined,
): string {
  const base = name || 'image';
  const wanted = mimeType ? EXTENSION_FOR_MIME[mimeType as ImageMime] : undefined;
  if (!wanted) return base;

  const dot = base.lastIndexOf('.');
  const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  const ext = dot > slash ? base.slice(dot).toLowerCase() : '';
  if (ext === wanted) return base;
  if (wanted === '.jpg' && ext === '.jpeg') return base;

  const known = KNOWN_EXTENSIONS.has(ext);
  if (known) return base.slice(0, dot) + wanted;
  return base + wanted;
}


/**
 * 声明的 MIME 归一化：去参数（`; charset=`）、转小写、合并常见别名。
 *
 * 别名不是洁癖：`image/jpg`（非标准，但很多工具这么发）、`image/pjpeg`（老 IE / 部分
 * 图片编辑器的习惯）、`image/x-png` 都真实存在，严格比对会把它们全判成「不支持」。
 * 归一化**只用于解释声明**，落库与下发仍是内容判定的结果。
 */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/x-citrix-png': 'image/png',
  'image/x-citrix-jpeg': 'image/jpeg',
};

/** 归一化后的声明；空串 / 缺省 → null（浏览器给不出类型是常态，不是错误）。 */
export function normalizeClaimedMime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!base) return null;
  return MIME_ALIASES[base] ?? base;
}

/**
 * 「没有声明」的几种形态：浏览器偶尔真给不出类型（Windows 注册表缺项、Linux 没有
 * shared-mime-info、某些安卓文件管理器）。它们不该让一个好文件被拒 —— 内容说了算。
 *
 * 导出是因为**浏览器侧的上传前闸门**也要按同一份口径判（`isUploadableImage`）：
 * 那边只把空串当「没声明」的话，`binary/octet-stream` 的 PNG 会「服务端收、编辑器却
 * 在闸门就丢掉」—— 两边分歧不报错，只表现为一张图莫名传不上去。
 */
export function isUnknownClaimedMime(claimed: string | null): boolean {
  return (
    claimed === null ||
    claimed === 'application/octet-stream' ||
    claimed === 'binary/octet-stream' ||
    claimed === 'application/x-unknown'
  );
}

/**
 * 我们**主动宣传**过的声明值（`<input accept>` 里写着 heic/heif）。浏览器可能嘴上说
 * HEIC、实际为兼容而发了 JPEG —— 那没有理由拒：内容是完好的位图，按内容收即可。
 */
function isConvertibleClaim(claimed: string | null): boolean {
  return claimed === 'image/heic' || claimed === 'image/heif';
}

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

/** 定长 ASCII 读取（文件头里的容器标识都是 ASCII）。越界补 0。 */
function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[start + i] ?? 0);
  }
  return out;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIG = [0xff, 0xd8, 0xff];

/**
 * 判定字节是否为 SVG：跳过 BOM、空白、XML prolog(`<?...?>`)、注释(`<!--...-->`)、
 * DOCTYPE（含内部子集 `[...]`），随后必须紧跟 `<svg` 且后随空白/`>`/`/`
 * （避免 `<svgfoo>` 这类误判）。只看前 4KB，足够覆盖任何合法 SVG 的头部。
 *
 * TextDecoder 默认会吞掉 BOM，所以这里不需要再手动剥一次。
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  let text = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096));

  // 反复剥离头部噪声，直到遇到真正的元素
  for (;;) {
    const before = text;
    text = text.replace(/^\s+/, '');
    text = text.replace(/^<\?[\s\S]*?\?>/, ''); // <?xml ... ?> / <?xml-stylesheet ... ?>
    text = text.replace(/^<!--[\s\S]*?-->/, ''); // 注释
    text = text.replace(/^<!DOCTYPE[^[>]*(\[[\s\S]*?\])?[^>]*>/i, ''); // DOCTYPE（含内部子集）
    if (text === before) break;
  }

  return /^<svg[\s/>]/i.test(text);
}

/**
 * 由**文件内容**识别真实图片类型；无法识别（含被截断的头部）返回 null。
 * 只读文件头，无第三方依赖。**不认 HEIC/AVIF/MOV** —— 它们不是可入库的格式，
 * 由 detectHeifContainer 单独交代。
 */
export function detectImageMime(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, PNG_SIG)) return 'image/png';
  if (startsWith(bytes, JPEG_SIG)) return 'image/jpeg';

  const head6 = ascii(bytes, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';

  // WebP：RIFF<4字节长度>WEBP
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';

  if (looksLikeSvg(bytes)) return 'image/svg+xml';

  return null;
}

/** ISOBMFF 家族里与上传相关的几支。 */
export type HeifContainer = 'heic' | 'avif' | 'video' | null;

// HEIF 的通用品牌：`mif1` / `msf1` 是容器，里面通常是 HEVC 编码的静帧（iPhone 的 HEIC）。
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
// 视频：QuickTime（实况照片的 .MOV 就是它）、MP4 家族与 M4V。
const VIDEO_BRANDS = new Set(['qt  ', 'isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'mmp4']);

/** 大端 u32（ISOBMFF 的 box size / 兼容品牌表都按它读）。 */
function u32be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

/**
 * `ftyp` box 里的**兼容品牌**列表（[16, boxSize) 每 4 字节一个）。
 *
 * 为什么需要它：通用 HEIF 容器的主品牌是 `mif1`，但里面装 HEVC 静帧（iPhone 的 HEIC）
 * 还是 AV1 静帧（AVIF）要看兼容品牌 —— 只看主品牌会把一部分 AVIF 当成 HEIC，
 * 浏览器于是拿 heic2any 去解一个 AV1 的图（解不出来，回「HEIC 转换失败」）。
 */
function compatibleBrands(bytes: Uint8Array): string[] {
  const size = u32be(bytes, 0);
  const end = Math.min(size > 0 ? size : bytes.length, bytes.length);
  const brands: string[] = [];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(bytes, at, 4));
  return brands;
}

/**
 * 认 ISOBMFF 容器：`[4..8) == 'ftyp'`，品牌在 `[8..12)`。
 *
 * 主品牌（major brand）足够区分绝大多数情况：iPhone 的 HEIC 是 `heic`，Live Photo 的
 * 视频部分是 `qt  `，AVIF 是 `avif`。只有通用容器 `mif1` / `msf1` 需要再看兼容品牌
 * （见 compatibleBrands）。
 */
export function detectHeifContainer(bytes: Uint8Array): HeifContainer {
  if (bytes.length < 12) return null;
  if (ascii(bytes, 4, 4) !== 'ftyp') return null;
  const brand = ascii(bytes, 8, 4);
  if (AVIF_BRANDS.has(brand)) return 'avif';
  if (HEIC_BRANDS.has(brand)) {
    if ((brand === 'mif1' || brand === 'msf1') && compatibleBrands(bytes).some((b) => AVIF_BRANDS.has(b))) {
      return 'avif';
    }
    return 'heic';
  }
  if (VIDEO_BRANDS.has(brand)) return 'video';
  return null;
}

/** 上传被拒的原因码。文案由各自的门面决定（图床 / 讨论评论的措辞不同）。 */
export type UploadRejectReason = 'unsupported' | 'mismatch' | 'unknown' | 'avif' | 'video';

export type ImageUploadPlan =
  /** 收，且落库类型 = `mimeType`（来自字节，不是声明）。 */
  | { kind: 'accept'; mimeType: ImageMime; claimed: string | null }
  /** HEIC/HEIF：调用方决定怎么办。浏览器转 JPEG 后重新 plan；服务端只能拒。 */
  | { kind: 'convert-heic' }
  | { kind: 'reject'; reason: UploadRejectReason };

// 判别字段刻意叫 `kind` 而不是 `action`：`tests/unit/audit-action-guard.test.ts` 把
// 全仓 `action: '<ascii>'` 一律当审计动作码扫，`action: 'accept'` 会误伤成「漏登记的动作码」，
// 而把 accept / reject 塞进那张豁免台账更糟（它们太通用，会掩盖真正的漏登记）。

/**
 * 一次判定的全部结论。**所有上传入口都走它**（服务端路由、浏览器上传前校验），
 * 这样「什么算合格」只有一处。
 *
 * 判定顺序（每一步的理由都在上面）：
 *  1. 内容能认出白名单位图 / SVG → 以内容为准；只有 SVG 要求声明也是 SVG。
 *     声明是「不认识的随便什么」（空、octet-stream）不拦 —— 那是浏览器的锅，不是用户的。
 *     声明是明确的不支持格式（`image/bmp`、`text/html`）仍拦，保留白名单那道门。
 *  2. 认不出 → 看是不是 HEIC/AVIF/MOV，给专属原因（它们各有各的「怎么办」）。
 *  3. 都认不出 → 声明是白名单位图 → mismatch；否则 unsupported。
 */
export function planImageUpload(
  bytes: Uint8Array,
  claimedMime: string | null | undefined,
): ImageUploadPlan {
  const claimed = normalizeClaimedMime(claimedMime);
  const detected = detectImageMime(bytes);

  if (detected === 'image/svg+xml') {
    return claimed === 'image/svg+xml'
      ? { kind: 'accept', mimeType: detected, claimed }
      : { kind: 'reject', reason: 'mismatch' };
  }

  if (detected) {
    // SVG 声明配位图字节：内容是真的位图，照内容收是安全的，但「你要的是矢量图、
    // 拿到的却是位图」这件事该让用户知道 —— 拒比默默换格式诚实。
    if (claimed === 'image/svg+xml') return { kind: 'reject', reason: 'mismatch' };
    if (
      claimed &&
      !isUnknownClaimedMime(claimed) &&
      !isConvertibleClaim(claimed) &&
      !UPLOAD_IMAGE_MIMES.includes(claimed as ImageMime)
    ) {
      return { kind: 'reject', reason: 'unsupported' };
    }
    return { kind: 'accept', mimeType: detected, claimed };
  }

  const container = detectHeifContainer(bytes);
  if (container === 'heic') return { kind: 'convert-heic' };
  if (container === 'avif') return { kind: 'reject', reason: 'avif' };
  if (container === 'video') return { kind: 'reject', reason: 'video' };

  if (claimed === null) return { kind: 'reject', reason: 'unknown' };
  if (claimed === 'image/svg+xml') return { kind: 'reject', reason: 'mismatch' };
  if (UPLOAD_IMAGE_MIMES.includes(claimed as ImageMime)) return { kind: 'reject', reason: 'mismatch' };
  return { kind: 'reject', reason: 'unsupported' };
}
