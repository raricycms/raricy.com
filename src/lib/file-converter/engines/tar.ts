// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/tar.ts —— TAR（ustar / pax / GNU 长名）的读与写（零依赖）。
//
// 【为什么自写】TAR 是最简单的一种归档：512 字节定长头 + 数据 + 结尾两个空块，
// 没有压缩、没有中央目录。fflate 只做压缩流（deflate/gzip/zlib），不做 tar 成员
// 模型，所以成员头这一层由本文件负责。自写换来的好处：**零依赖、可 node 单测**、
// 长名策略完全可控。
//
// 【长名两种写法，读端都要认】
//   · pax 'x' 头（POSIX.1-2001）：一个 typeflag='x' 的成员，正文是若干
//     `"<len> <key>=<value>\n"` 记录；`path=` 覆盖**下一个**成员的名字。
//     **本文件的写端用它**（跨平台最兼容，GNU / bsdtar / Python tarfile 都认）。
//   · GNU 'L' 头（././@LongLink）：一个 typeflag='L' 的成员，正文是长名本身
//     （NUL 结尾），覆盖下一个成员的名字。老 GNU tar 产物里大量存在，
//     **读端必须认**，否则解出来的长名会被截断成前缀。
//   · ustar 的 prefix 字段（345..500，155 字节）能装下就用它，不用扩展头。
//
// 【字节纪律】名字一律按 **UTF-8 字节**量长度（中文文件名按字符数是 3 倍字节）。
// 一个中文字符 = 3 字节，100 字节的 name 字段只放得下三十来个汉字 —— 按字符数
// 判断会写出越界的头，读端直接当成损坏。
//
// 【损坏判据】头校验和（chksum）对不上 = 抛错（kind:'corrupt'）。这是区分
// 「一个真 tar」和「一段碰巧长得像的字节」的唯一廉价手段，也钉住了「损坏头拒绝」。
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK = 512;
const NAME_LEN = 100;
const PREFIX_LEN = 155;
/** 目录项 typeflag。 */
const TYPE_DIR = 0x35; // '5'
const TYPE_FILE = 0x30; // '0'
/** pax 扩展头 typeflag。 */
const TYPE_PAX = 0x78; // 'x'
/** GNU 长名头 typeflag。 */
const TYPE_GNU_LONG = 0x4c; // 'L'
/** GNU 长链接名头 typeflag（读端认它，本写端不产生）。 */
const TYPE_GNU_LONGLINK = 0x4b; // 'K'

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** 抛一个带 kind 的错误（runner 的 classifyError 直接认它 → 用户文案「损坏」）。 */
function corrupt(message: string): never {
  const e = new Error(message) as Error & { kind: string };
  e.kind = 'corrupt';
  throw e;
}

function utf8Len(s: string): number {
  return textEncoder.encode(s).length;
}

// ─── 写出 ─────────────────────────────────────────────────────────────────────

export interface TarWriteEntry {
  /** 成员路径（用 '/' 分隔；目录以 '/' 结尾也会被规范化）。 */
  name: string;
  data: Uint8Array;
  /** 文件权限位（八进制），默认 0o644（目录 0o755）。 */
  mode?: number;
  /** 修改时间（Unix 秒）。默认 0（不写「现在」，保证产物可复现、也不碰时钟）。 */
  mtimeSec?: number;
  isDir?: boolean;
}

/** 八进制数字段（长度为 len，末字节 NUL）。 */
function writeOctal(buf: Uint8Array, off: number, len: number, value: number): void {
  let s = Math.max(0, Math.floor(value)).toString(8);
  if (s.length > len - 1) s = s.slice(-(len - 1)); // 溢出截尾（不静默；TAR 上限）
  const padded = s.padStart(len - 1, '0');
  for (let i = 0; i < len - 1; i++) buf[off + i] = padded.charCodeAt(i);
  buf[off + len - 1] = 0;
}

function writeString(buf: Uint8Array, off: number, len: number, s: string): void {
  const bytes = textEncoder.encode(s);
  const n = Math.min(bytes.length, len);
  buf.set(bytes.subarray(0, n), off);
  // 其余保持 0
}

/** 校验和：chksum 字段按 8 个空格算，之后写 `%06o\0 `。 */
function writeChecksum(header: Uint8Array): void {
  for (let i = 148; i < 156; i++) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i];
  const octal = sum.toString(8).padStart(6, '0').slice(-6);
  for (let i = 0; i < 6; i++) header[148 + i] = octal.charCodeAt(i);
  header[154] = 0;
  header[155] = 0x20;
}

/** 组装一个 512 字节头。name / prefix 由调用方决定。 */
function makeHeader(opts: {
  name: string;
  prefix: string;
  size: number;
  mode: number;
  mtimeSec: number;
  typeflag: number;
}): Uint8Array {
  const h = new Uint8Array(BLOCK);
  writeString(h, 0, NAME_LEN, opts.name);
  writeOctal(h, 100, 8, opts.mode);
  writeOctal(h, 108, 8, 0); // uid
  writeOctal(h, 116, 8, 0); // gid
  writeOctal(h, 124, 12, opts.size);
  writeOctal(h, 136, 12, opts.mtimeSec);
  h[156] = opts.typeflag;
  writeString(h, 257, 6, 'ustar');
  h[263] = 0x30; // '0'
  h[264] = 0x30; // '0'
  writeString(h, 265, 32, 'converter');
  writeString(h, 297, 32, 'converter');
  writeString(h, 345, PREFIX_LEN, opts.prefix);
  writeChecksum(h);
  return h;
}

/** 把名字拆成 (prefix, base)，都放得下；放不下返回 null（走 pax）。 */
function splitForUstar(name: string): { prefix: string; base: string } | null {
  if (utf8Len(name) <= NAME_LEN) return { prefix: '', base: name };
  // 在 '/' 边界上找：base ≤ 100 且 prefix ≤ 155
  let idx = name.length;
  while ((idx = name.lastIndexOf('/', idx - 1)) > 0) {
    const prefix = name.slice(0, idx);
    const base = name.slice(idx + 1);
    if (utf8Len(base) <= NAME_LEN && utf8Len(prefix) <= PREFIX_LEN) return { prefix, base };
  }
  return null;
}

/** 一条 pax 记录：`"<len> <key>=<value>\n"`，len 是整条记录的字节数（自洽迭代）。 */
export function paxRecord(key: string, value: string): Uint8Array {
  const kv = textEncoder.encode(`${key}=${value}`);
  let len = kv.length + 3;
  // 收敛：len = digits(len) + 1(空格) + kv.length + 1(\n)
  while (len !== String(len).length + kv.length + 2) {
    len = String(len).length + kv.length + 2;
  }
  const head = textEncoder.encode(`${len} `);
  const out = new Uint8Array(head.length + kv.length + 1);
  out.set(head, 0);
  out.set(kv, head.length);
  out[out.length - 1] = 0x0a;
  return out;
}

function paddedBlock(data: Uint8Array): Uint8Array {
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  if (pad === 0) return data;
  const out = new Uint8Array(data.length + pad);
  out.set(data, 0);
  return out;
}

/**
 * 构造一个 TAR 归档。长名（>100 字节且 prefix 拆不出）自动加 pax 'x' 头。
 * 目录成员由调用方显式给（isDir:true）。
 */
export function buildTar(entries: TarWriteEntry[]): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    const isDir = entry.isDir ?? false;
    let name = entry.name.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (isDir && !name.endsWith('/')) name += '/';
    const mode = entry.mode ?? (isDir ? 0o755 : 0o644);
    const mtimeSec = entry.mtimeSec ?? 0;
    const data = isDir ? new Uint8Array(0) : entry.data;

    const split = splitForUstar(name);
    if (split) {
      chunks.push(makeHeader({ name: split.base, prefix: split.prefix, size: data.byteLength, mode, mtimeSec, typeflag: isDir ? TYPE_DIR : TYPE_FILE }));
    } else {
      // pax 扩展头：路径记在 path 记录里，真头里的名字随便放个不越界的占位。
      const paxData = paxRecord('path', name);
      const paxName = `PaxHeader/${name.slice(-80)}`.replace(/\/+/g, '/').slice(0, 100);
      chunks.push(makeHeader({ name: paxName, prefix: '', size: paxData.byteLength, mode: 0o644, mtimeSec, typeflag: TYPE_PAX }));
      chunks.push(paddedBlock(paxData));
      // 真头用 base 名（保证 ≤100）；读端会用 pax 的 path 覆盖它。
      const base = name.slice(name.lastIndexOf('/') + 1) || name.slice(0, 100);
      chunks.push(makeHeader({ name: base.slice(0, 100), prefix: '', size: data.byteLength, mode, mtimeSec, typeflag: isDir ? TYPE_DIR : TYPE_FILE }));
    }
    if (!isDir && data.byteLength > 0) chunks.push(paddedBlock(data));
  }

  // 结尾两个空块
  chunks.push(new Uint8Array(BLOCK * 2));

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ─── 读入 ─────────────────────────────────────────────────────────────────────

export interface TarReadMember {
  /** 已应用长名覆盖后的成员路径。 */
  path: string;
  data: Uint8Array<ArrayBuffer>;
  isDir: boolean;
  mode: number;
  mtimeSec: number;
}

export interface ParseTarOptions {
  /** 成员数上限（超过抛 oversize）。 */
  maxMembers?: number;
  /** 解压总量上限（字节）。 */
  maxTotalBytes?: number;
  /** 嵌套深度上限（按 '/' 层数）。 */
  maxDepth?: number;
}

function readOctal(h: Uint8Array, off: number, len: number): number {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = h[off + i];
    if (c === 0 || c === 0x20) {
      if (s.length > 0) break;
      continue;
    }
    if (c < 0x30 || c > 0x37) break; // 非八进制（可能是 GNU base-256，本实现不支持）
    s += String.fromCharCode(c);
  }
  return s ? parseInt(s, 8) : 0;
}

function isZeroBlock(b: Uint8Array, off: number): boolean {
  for (let i = 0; i < BLOCK; i++) if (b[off + i] !== 0) return false;
  return true;
}

function verifyChecksum(h: Uint8Array): void {
  const stored = readOctal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : h[i];
  }
  if (stored !== sum) corrupt('TAR 头校验和不匹配，文件可能损坏');
}

/** 解析一段 pax 正文里的 `path=` 值（认第一个 path 记录）。 */
export function parsePaxPath(paxData: Uint8Array): string | null {
  let off = 0;
  while (off < paxData.length) {
    // 跳过前导 NUL
    if (paxData[off] === 0) {
      off++;
      continue;
    }
    let lenStr = '';
    let p = off;
    while (p < paxData.length && paxData[p] >= 0x30 && paxData[p] <= 0x39) {
      lenStr += String.fromCharCode(paxData[p]);
      p++;
    }
    if (!lenStr) break;
    const len = parseInt(lenStr, 10);
    if (!Number.isFinite(len) || len <= 0 || off + len > paxData.length) break;
    // 记录正文 = 长度字段 + 空格 + "key=value" + 换行
    const bodyStart = p + 1; // 跳空格
    const bodyEnd = off + len - 1; // 去掉换行
    const body = textDecoder.decode(paxData.subarray(bodyStart, bodyEnd));
    const eq = body.indexOf('=');
    if (eq > 0) {
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      if (key === 'path') return value;
    }
    off += len;
  }
  return null;
}

/**
 * 解析 TAR。认 ustar prefix / pax 'x' / GNU 'L'（与 'K' 读掉但不使用）。
 * 校验和不过、尺寸越界、成员超限都抛错。
 */
export function parseTar(bytes: Uint8Array, opts: ParseTarOptions = {}): TarReadMember[] {
  const maxMembers = opts.maxMembers ?? 2000;
  const maxTotalBytes = opts.maxTotalBytes ?? 500 * 1024 * 1024;
  const maxDepth = opts.maxDepth ?? 10;

  const members: TarReadMember[] = [];
  let off = 0;
  let totalBytes = 0;
  /** 待应用的长名（来自 pax path 或 GNU L/K）。 */
  let pendingPath: string | null = null;
  let pendingLink: string | null = null;

  while (off + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, off)) break; // 结尾空块
    const h = bytes.subarray(off, off + BLOCK);
    verifyChecksum(h);

    const rawName = textDecoder.decode(h.subarray(0, NAME_LEN)).replace(/\0.*$/, '');
    const prefix = textDecoder.decode(h.subarray(345, 345 + PREFIX_LEN)).replace(/\0.*$/, '');
    const typeflag = h[156];
    const size = readOctal(h, 124, 12);
    const mode = readOctal(h, 100, 8);
    const mtimeSec = readOctal(h, 136, 12);
    off += BLOCK;
    if (size < 0 || off + size > bytes.length) corrupt('TAR 成员尺寸越界，文件可能损坏');
    const data = bytes.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;

    // pax 扩展头：正文解析出 path，供下一个成员用
    if (typeflag === TYPE_PAX) {
      const p = parsePaxPath(data);
      if (p) pendingPath = p;
      continue;
    }
    // GNU 长名头：正文是名字（NUL 结尾）
    if (typeflag === TYPE_GNU_LONG) {
      pendingPath = textDecoder.decode(data).replace(/\0.*$/, '');
      continue;
    }
    if (typeflag === TYPE_GNU_LONGLINK) {
      pendingLink = textDecoder.decode(data).replace(/\0.*$/, '');
      continue;
    }

    let name = prefix ? `${prefix}/${rawName}` : rawName;
    if (pendingPath) {
      name = pendingPath;
      pendingPath = null;
    }
    pendingLink = null;

    if (!name) continue; // 无名头（少数工具的占位），跳过

    const isDir = typeflag === TYPE_DIR || name.endsWith('/');

    if (members.length >= maxMembers) {
      const e = new Error(`成员数超过 ${maxMembers} 上限`) as Error & { kind: string };
      e.kind = 'oversize';
      throw e;
    }
    const depth = name.replace(/\/+$/, '').split('/').filter(Boolean).length;
    if (depth > maxDepth) {
      const e = new Error(`成员路径层级超过 ${maxDepth} 上限`) as Error & { kind: string };
      e.kind = 'oversize';
      throw e;
    }

    if (isDir) {
      members.push({ path: name.replace(/\/+$/, '') + '/', data: new Uint8Array(0), isDir: true, mode, mtimeSec });
      continue;
    }
    totalBytes += size;
    if (totalBytes > maxTotalBytes) {
      const e = new Error('解压总量超过上限') as Error & { kind: string };
      e.kind = 'oversize';
      throw e;
    }
    // 复制一份（subarray 是视图，脱离原 buffer 后仍有效，但复制避免持有整个 tar）
    members.push({ path: name, data: data.slice() as Uint8Array<ArrayBuffer>, isDir: false, mode, mtimeSec });
  }

  return members;
}
