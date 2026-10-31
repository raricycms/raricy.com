// ─────────────────────────────────────────────────────────────────────────────
// data-image.ts — 历史内嵌位图的**受限**判定（零依赖，服务端 / 浏览器共用）
//
// 存量 Markdown 里确实有 `<img src="data:image/jpeg;base64,…">` 这种历史写法。
// 旧渲染器的 DOMPurify 默认放行 `img` 的 data URI，所以它们当年能显示；新的
// ReactiveMD 原生 HTML 解析会以 `local.html.fallback.attribute` 拒绝，整段退成
// 源码 —— 十几万字符的 base64 直接淹没正文。
//
// 这里**不是**放开 data 协议，而是只认四类位图 + base64 + 长度上限 + magic bytes：
//   · MIME 只允许 jpeg / png / gif / webp —— SVG 是文档 + 脚本载体，明确拒绝；
//   · 编码必须是 base64，且解码后的**头几个字节**必须与声明的 MIME 一致；
//   · 编码长度有硬上限（约 384 KB 解码后），超了就不显示（也不输出源码）。
//
// 通过判定的地址最终会交给 `isAllowedReactiveUrl(url, 'image')`，只用于
// `<img>` / Markdown 图片；链接、音频用途仍然一律拒绝 data:。
// ─────────────────────────────────────────────────────────────────────────────

/** 一段通过受限判定的 data 位图。 */
export interface LegacyDataImage {
  /** 规范化的 `data:image/<type>;base64,<payload>`（原样保留 payload 大小写）。 */
  url: string;
  /** 规范化的小写 MIME 子类型（不含 `image/`）。 */
  subtype: 'jpeg' | 'png' | 'gif' | 'webp';
}

/** 编码长度上限（base64 字符数）。384 KB 解码后 ≈ 512,000 字符编码。 */
export const MAX_DATA_IMAGE_CHARS = 512_000;

const DATA_IMAGE = /^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

/** 各 MIME 的首字节魔数（只取判定需要的前缀）。 */
const MAGIC: Record<LegacyDataImage['subtype'], readonly number[]> = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  gif: [0x47, 0x49, 0x46, 0x38], // GIF8
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF（后续 WEBP 由容器声明，但头四字节足够）
};

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * 从 base64 字符串解出前 `limit` 个字节。
 *
 * 不依赖 Buffer / atob：这两个环境都可能有、但也可能被裁剪；纯算术版本在两个
 * 运行时行为一致，且不会因为传入 50 万字符而分配整段解码结果。
 */
export function decodeBase64Prefix(payload: string, limit = 16): number[] {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let index = 0; index < payload.length && bytes.length < limit; index += 1) {
    const char = payload[index];
    if (char === '=') break;
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) return [];
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return bytes;
}

function matchesMagic(bytes: readonly number[], magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) return false;
  }
  return true;
}

/**
 * 判定一个字符串是否是**受支持的**历史内嵌位图。
 * 返回 `null` = 不是 / 超限 / 字节对不上，调用方按不可显示处理。
 */
export function parseLegacyDataImage(value: string): LegacyDataImage | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DATA_IMAGE_CHARS) {
    return null;
  }
  const match = DATA_IMAGE.exec(value);
  if (!match) return null;
  const subtype = match[1].toLowerCase() as LegacyDataImage['subtype'];
  const payload = match[2];
  // base64 长度必须是 4 的倍数（允许省略 padding 的历史写法？不允许 —— 那会让
  // 「看起来像 base64」的任意文本混进来）。
  if (payload.length % 4 !== 0) return null;
  const prefix = decodeBase64Prefix(payload, Math.max(MAGIC[subtype].length, 4));
  if (!matchesMagic(prefix, MAGIC[subtype])) return null;
  return {
    url: `data:image/${subtype};base64,${payload}`,
    subtype,
  };
}
