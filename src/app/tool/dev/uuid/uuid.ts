// ─────────────────────────────────────────────────────────────────────────────
// uuid.ts —— 开发者工具「UUID 生成器」的纯逻辑（零 React）
//
// 【为什么单独一个文件】UUID 生成不是 React 的事：v7 的位拼接要能被单测直接验
// （版本位 / 变体位 / 时间戳位错一位就是另一种 UUID，而且**不报错**），所以把它
// 从客户端组件里拆出来。随机字节由调用方注入 —— 单测传固定字节，页面传
// `crypto.getRandomValues`。
//
// 【v7 的位布局（RFC 9562）】
//   0–5   48 位毫秒时间戳（大端）
//   6     高 4 位固定 0111（version = 7），低 4 位随机
//   7     8 位随机
//   8     高 2 位固定 10（variant = RFC 4122/9562），低 6 位随机
//   9–15  56 位随机
// 于是「同一毫秒内生成的 v7」由 `rand_a` 随机位决定先后 —— **不保证字典序递增**；
// 只有跨毫秒（48 位时间戳大端）才随生成时间单调。这也是按毫秒取时间戳的原因
// （按秒会让同秒内绝大多数 v7 时间位相同、只剩随机序）。
// ─────────────────────────────────────────────────────────────────────────────

export interface UuidFormatOptions {
  /** 输出大写（默认小写）。 */
  uppercase: boolean;
  /** 去掉连字符（32 位裸十六进制）。 */
  noHyphens: boolean;
}

/** 随机字节来源：返回长度为 n 的字节数组。 */
export type RandomBytes = (n: number) => Uint8Array;

const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0x0f] + HEX[byte & 0x0f];
  }
  return out;
}

/** 32 位裸十六进制 → 标准 8-4-4-4-12（或去连字符 / 大写）。 */
export function formatUuid(hex32: string, options: UuidFormatOptions): string {
  const text = options.uppercase ? hex32.toUpperCase() : hex32.toLowerCase();
  if (options.noHyphens) return text;
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
}

/** UUID v4：16 字节全随机（只把版本位 / 变体位改写掉）。 */
export function uuidV4(random: RandomBytes, options: UuidFormatOptions): string {
  const bytes = random(16);
  if (bytes.length < 16) throw new Error('随机源返回的字节数不足 16');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytesToHex(bytes.subarray(0, 16)), options);
}

/**
 * UUID v7：48 位毫秒时间戳 + 随机位。
 *
 * `epochMs` 由调用方传入（页面里先用 `const now = Date.now()` 存成一个变量，
 * 再给一批 UUID 用同一个值 —— 同一个批次共用一个时间戳是刻意的，这样同批 UUID
 * 的字典序只由随机位决定，不会出现「后生成的时间戳更小」）。
 */
export function uuidV7(epochMs: number, random: RandomBytes, options: UuidFormatOptions): string {
  const randomBytes = random(10);
  if (randomBytes.length < 10) throw new Error('随机源返回的字节数不足 10');

  const bytes = new Uint8Array(16);
  let ts = Math.max(0, Math.trunc(epochMs));
  // 48 位时间戳按大端写入：逐字节取余，避免 32 位位运算的符号问题。
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = 0x70 | (randomBytes[0] & 0x0f);
  bytes[7] = randomBytes[1] & 0xff;
  bytes[8] = 0x80 | (randomBytes[2] & 0x3f);
  for (let i = 0; i < 7; i++) bytes[9 + i] = randomBytes[3 + i] & 0xff;

  return formatUuid(bytesToHex(bytes), options);
}

/** 从 UUID 字符串里读回版本号（1–8）；不是合法 UUID 形状时返回 null。 */
export function uuidVersion(uuid: string): number | null {
  const compact = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return Number.parseInt(compact[12], 16);
}
