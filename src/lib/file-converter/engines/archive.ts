// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/archive.ts —— 压缩包引擎：ZIP / GZIP（fflate）、RAR
// （node-unrar-js）、7Z（7z-wasm），以及**包处理自己的安全闸**（纯函数，可 node 单测）。
//
// 【安全闸是这一区的核心】roadmap §11.2：光看外层压缩包很小不足以控成本 ——
// ZIP 炸弹把 42KB 解成 4GB 是经典的「一行解压打爆内存」。所以**解压之前**先读
// 中央目录（不解压一个字节）拿到「成员数 / 每成员原始体积 / 压缩后体积 / 路径」，
// 跑 validateMembers 把所有硬上限一次判完，过了才解压。
//
// 【三条纪律】
//   · 纯函数（validateMembers / sanitizeMemberPath / 加密探测）住本文件前半，
//     零依赖，node 单测直接喂构造字节驱动；引擎调用（fflate / unrar / 7z）在后半，
//     一律 `await import(...)` 动态引入。
//   · 用户文件字节绝不出站：RAR / 7Z 的 wasm 从**同源** `/static/converter/` 取
//     （见 copy-converter-assets 的资产清单），包内容只进内存 FS。
//   · 加密成员**不做**「跳过它当作成功」——解出来少文件的包是坏包。识别到加密就
//     整体报 {kind:'unsupported'}。
// ─────────────────────────────────────────────────────────────────────────────

import { LIMITS } from '../formats';
import { parseCdEntries, parseEocd } from '../inspect';
import type { ConvertError } from '../types';

// ─── 纯逻辑：成员元信息与校验 ────────────────────────────────────────────────

/** 一个包成员的元信息（解压**前**可得的全部信息）。 */
export interface MemberMeta {
  path: string;
  /** 原始（解压后）字节数。 */
  size: number;
  /** 压缩后字节数（ZIP 中央目录能拿到；TAR 没有这个概念）。 */
  compressedSize?: number;
  isDir?: boolean;
}

export interface ValidatedMember extends MemberMeta {
  /** 净化 + 去重后的安全路径。 */
  safePath: string;
  /** '/' 层数（目录不计入）。 */
  depth: number;
}

export interface ValidateResult {
  ok: boolean;
  members: ValidatedMember[];
  error?: ConvertError;
}

function fail(kind: ConvertError['kind'], message: string): ValidateResult {
  return { ok: false, members: [], error: { kind, message } };
}

/**
 * 把包内路径净化成一个**安全的相对路径**。返回 null = 该成员不可信，拒绝。
 *
 * 拒掉的五类（roadmap §11.2「绝对路径、上级目录、链接、重名…有固定处理规则」）：
 *   · 绝对路径（以 '/' 开头）—— 解包时会写到根目录；
 *   · 盘符前缀（`C:` / `c:\`）—— Windows 平台解包越界；
 *   · `..` 段 —— zip-slip：`../../etc/passwd` 写到任务目录之外；
 *   · 反斜杠 —— 分隔符混用（`a\..\b` 在只认 '/' 的净化里会漏掉那个 `..`）；
 *   · NUL —— 截断攻击（`safe.txt\0.png` 在不同层看到不同名字）。
 *
 * 名称里允许 `.`（隐藏文件），但首尾空白与纯 `.`/`..` 段被清掉。
 */
export function sanitizeMemberPath(raw: string): string | null {
  if (raw.includes('\0')) return null;
  if (raw.includes('\\')) return null; // 反斜杠混用：一律拒绝，不猜作者意图
  if (raw.startsWith('/')) return null; // 绝对路径
  if (/^[a-zA-Z]:/.test(raw)) return null; // 盘符

  const segments: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null; // 上级目录
    // 段内不再允许控制字符
    if (/[\u0000-\u001f\u007f]/.test(seg)) return null;
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  return segments.join('/');
}

/** 重复名加序号（`a.txt` → `a-2.txt`）。 */
function dedupePath(path: string, taken: Set<string>): string {
  if (!taken.has(path)) {
    taken.add(path);
    return path;
  }
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 2;
  let candidate = `${dir}${stem}-${n}${ext}`;
  while (taken.has(candidate)) {
    n++;
    candidate = `${dir}${stem}-${n}${ext}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * 包成员的硬上限校验（roadmap §11.2 + LIMITS.archive）。
 * 判据顺序：路径安全 → 深度 → 成员数 → 单成员压缩比 → 总量 → 总压缩比。
 * 任何一条不过 → ok:false + 结构化错误；**不抛异常**（便于单测与上层分类处理）。
 */
export function validateMembers(
  members: MemberMeta[],
  limits: { maxMembers: number; maxTotalUncompressed: number; maxDepth: number; maxRatio: number } = LIMITS.archive
): ValidateResult {
  const taken = new Set<string>();
  const out: ValidatedMember[] = [];
  let totalUncompressed = 0;
  let totalCompressed = 0;
  let sawCompressed = false;

  for (const m of members) {
    const safe = sanitizeMemberPath(m.path);
    if (safe === null) {
      return fail('unsupported', `包内路径不安全（绝对路径 / 上级目录 / 盘符 / 反斜杠 / NUL）：「${m.path}」`);
    }
    const depth = safe.split('/').filter(Boolean).length;
    if (depth > limits.maxDepth) {
      return fail('oversize', `包内目录层级（${depth}）超过 ${limits.maxDepth} 层上限`);
    }
    if (out.length + 1 > limits.maxMembers) {
      return fail('oversize', `包内成员数超过 ${limits.maxMembers} 个上限`);
    }
    const isDir = m.isDir ?? false;
    const size = Math.max(0, m.size);
    const compressedSize = m.compressedSize;

    if (!isDir && compressedSize !== undefined) {
      sawCompressed = true;
      if (size > 0) {
        const ratio = compressedSize > 0 ? size / compressedSize : Number.POSITIVE_INFINITY;
        if (ratio > limits.maxRatio) {
          return fail('oversize', `成员「${safe}」压缩比 ${Math.round(ratio)} 超过 ${limits.maxRatio} 上限，疑似压缩炸弹`);
        }
      }
      totalCompressed += compressedSize;
    }
    if (!isDir) totalUncompressed += size;
    if (totalUncompressed > limits.maxTotalUncompressed) {
      return fail('oversize', `解压总量超过 ${Math.round(limits.maxTotalUncompressed / 1024 / 1024)} MiB 上限`);
    }

    out.push({ ...m, safePath: dedupePath(safe, taken), depth, isDir });
  }

  if (sawCompressed && totalCompressed > 0 && totalUncompressed / totalCompressed > limits.maxRatio) {
    return fail('oversize', `整体压缩比 ${Math.round(totalUncompressed / totalCompressed)} 超过 ${limits.maxRatio} 上限，疑似压缩炸弹`);
  }
  return { ok: true, members: out };
}

/** 成员列表里非目录的原始字节合计（estimateOutput 用）。 */
export function totalMemberBytes(members: { size: number; isDir?: boolean }[]): number {
  return members.reduce((s, m) => s + (m.isDir ? 0 : Math.max(0, m.size)), 0);
}

/**
 * 探测 ZIP 是否含加密成员（中央目录 GP 标志位 0）。读全文（EOCD 在尾部）。
 * 解析不了就返回 false —— 由后续解压自己报错，不在探测阶段编造结论。
 */
export function zipHasEncryptedEntry(bytes: Uint8Array): boolean {
  const tail = bytes;
  const eocd = parseEocd(tail);
  if (!eocd || eocd.cdOffset + eocd.cdSize > bytes.length) return false;
  const cd = bytes.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize);
  const members = parseCdEntries(cd, eocd.count);
  if (!members) return false;
  // parseCdEntries 不给标志位，这里自己扫一遍原始 CD 区的 GP 标志（每项偏移 +8）
  let off = 0;
  for (let i = 0; i < eocd.count; i++) {
    if (off + 46 > cd.length || (cd[off] | (cd[off + 1] << 8) | (cd[off + 2] << 16) | (cd[off + 3] << 24)) >>> 0 !== 0x02014b50) {
      return false;
    }
    const flags = cd[off + 8] | (cd[off + 9] << 8);
    if (flags & 0x0001) return true;
    const nameLen = cd[off + 28] | (cd[off + 29] << 8);
    const extraLen = cd[off + 30] | (cd[off + 31] << 8);
    const commentLen = cd[off + 32] | (cd[off + 33] << 8);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return false;
}

/** 从 ZIP 中央目录读成员元信息（不解压）。解析不了返回 null。 */
export function zipMemberMetas(bytes: Uint8Array): MemberMeta[] | null {
  const eocd = parseEocd(bytes);
  if (!eocd || eocd.cdOffset + eocd.cdSize > bytes.length) return null;
  const members = parseCdEntries(bytes.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize), eocd.count);
  if (!members) return null;
  return members.map((m) => ({ path: m.path, size: m.size, compressedSize: m.compressedSize, isDir: m.isDir }));
}

// ─── 引擎调用：fflate（ZIP / GZIP）────────────────────────────────────────────

/** fflate 的 zip 级别 0–9（0=仅存储，9=最紧）。 */
export function clampZipLevel(v: unknown, fallback: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  const c = Math.min(9, Math.max(0, Math.round(n)));
  return c as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface NamedBytes {
  path: string;
  data: Uint8Array<ArrayBuffer>;
}

/** 一组成员 → ZIP（fflate zipSync）。 */
export async function zipMembers(entries: NamedBytes[], level: number): Promise<Uint8Array<ArrayBuffer>> {
  const { zipSync } = await import('fflate');
  const zippable: Record<string, [Uint8Array, { level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }]> = {};
  for (const e of entries) zippable[e.path] = [e.data, { level: clampZipLevel(level, 6) }];
  const out = zipSync(zippable);
  return out as Uint8Array<ArrayBuffer>;
}

/** ZIP → 成员（fflate unzipSync）。加密成员会抛错 —— 调用方先用 zipHasEncryptedEntry 挡。 */
export async function unzipAll(bytes: Uint8Array): Promise<NamedBytes[]> {
  const { unzipSync } = await import('fflate');
  const unzipped = unzipSync(bytes);
  const out: NamedBytes[] = [];
  for (const [path, data] of Object.entries(unzipped)) {
    if (data.byteLength === 0 && path.endsWith('/')) continue; // 目录占位
    out.push({ path, data: data as Uint8Array<ArrayBuffer> });
  }
  return out;
}

/** 单条字节流 → GZIP。 */
export async function gzipBytes(data: Uint8Array, level: number): Promise<Uint8Array<ArrayBuffer>> {
  const { gzipSync } = await import('fflate');
  const out = gzipSync(data, { level: clampZipLevel(level, 6) });
  return out as Uint8Array<ArrayBuffer>;
}

/** GZIP → 原始字节。 */
export async function gunzipBytes(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const { gunzipSync } = await import('fflate');
  const out = gunzipSync(data);
  return out as Uint8Array<ArrayBuffer>;
}

/** GZIP 尾部 ISIZE 声明的原始字节数（mod 2^32）。读不到返回 null。 */
export function gzipIsize(bytes: Uint8Array): number | null {
  if (bytes.length < 18) return null;
  const o = bytes.length - 4;
  return (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
}

// ─── 引擎调用：RAR（node-unrar-js）/ 7Z（7z-wasm）──────────────────────────────
//
// 两者都从**同源** /static/converter/ 取 wasm（用户文件字节不出站）。资产由
// copy-converter-assets.mjs 拷出 —— 见本文件末尾的资产路径常量与报告里的
// contractRequests（该脚本当前**未**登记这两个 wasm）。

export interface RawMember {
  path: string;
  data: Uint8Array<ArrayBuffer>;
  isDir: boolean;
}

const UNRAR_WASM_URL = '/static/converter/unrar/unrar.wasm';
const SEVENZ_WASM_URL = '/static/converter/7z/7zz.wasm';

/** 引擎资产的内存缓存（同一份 wasm 只取一次；RAR 的「列清单 + 解压」是两次调用）。 */
const assetCache = new Map<string, Promise<ArrayBuffer>>();

/** 从同源取一个引擎 wasm。失败 → engine-load 错误（不让用户看到「损坏包」的误导）。 */
async function fetchAsset(url: string, label: string): Promise<ArrayBuffer> {
  const cached = assetCache.get(url);
  if (cached) return cached;
  const p = (async () => {
    let res: Response;
    try {
      res = await fetch(url, { credentials: 'same-origin' });
    } catch (e) {
      assetCache.delete(url); // 失败不缓存，下次可重试
      throw { kind: 'engine-load', message: `${label}加载失败（请检查网络后重试）`, detail: String(e) } satisfies ConvertError;
    }
    if (!res.ok) {
      assetCache.delete(url);
      throw { kind: 'engine-load', message: `${label}加载失败（请求 ${url} 返回 ${res.status}）` } satisfies ConvertError;
    }
    return res.arrayBuffer();
  })();
  assetCache.set(url, p);
  return p;
}

function encryptedError(): ConvertError {
  return { kind: 'unsupported', message: '加密压缩包暂不支持（请先在本机解密后再转换）' };
}

/** node-unrar-js 的最小运行时形状投影（避开它自身 d.ts 的解析歧义）。 */
interface UnrarFileHeaderLite {
  name: string;
  flags: { encrypted: boolean; directory: boolean };
  packSize: number;
  unpSize: number;
}
interface UnrarListLite {
  arcHeader: { flags: { headerEncrypted: boolean } };
  fileHeaders: Iterable<UnrarFileHeaderLite>;
}
interface UnrarFilesLite {
  files: Iterable<{ fileHeader: UnrarFileHeaderLite; extraction?: Uint8Array<ArrayBuffer> }>;
}
interface UnrarExtractorLite {
  getFileList(): UnrarListLite;
  extract(): UnrarFilesLite;
}
interface UnrarModuleLite {
  createExtractorFromData(opts: { data: ArrayBuffer; wasmBinary?: ArrayBuffer }): Promise<UnrarExtractorLite>;
}

async function loadUnrar(): Promise<UnrarModuleLite> {
  try {
    return (await import('node-unrar-js')) as unknown as UnrarModuleLite;
  } catch (e) {
    throw { kind: 'engine-load', message: 'RAR 解包组件加载失败', detail: String(e) } satisfies ConvertError;
  }
}

/** 列 RAR 成员（不解压），用于解压前的安全闸。加密包直接抛。 */
export async function listRar(bytes: Uint8Array): Promise<MemberMeta[]> {
  const wasmBinary = await fetchAsset(UNRAR_WASM_URL, 'RAR 解包组件');
  const mod = await loadUnrar();
  const extractor = await mod.createExtractorFromData({ wasmBinary, data: toArrayBuffer(bytes) });
  let list: UnrarListLite;
  try {
    list = extractor.getFileList();
  } catch (e) {
    throw { kind: 'corrupt', message: '无法读取 RAR 成员清单，文件可能损坏', detail: String(e) } satisfies ConvertError;
  }
  if (list.arcHeader.flags.headerEncrypted) throw encryptedError();
  const members: MemberMeta[] = [];
  for (const h of list.fileHeaders) {
    if (h.flags.encrypted) throw encryptedError();
    members.push({ path: h.name, size: h.unpSize, compressedSize: h.packSize, isDir: h.flags.directory });
  }
  return members;
}

/** 解出 RAR 成员（安全闸已由调用方跑过）。 */
export async function extractRar(bytes: Uint8Array): Promise<RawMember[]> {
  const wasmBinary = await fetchAsset(UNRAR_WASM_URL, 'RAR 解包组件');
  const mod = await loadUnrar();
  const extractor = await mod.createExtractorFromData({ wasmBinary, data: toArrayBuffer(bytes) });
  const out: RawMember[] = [];
  try {
    const { files } = extractor.extract();
    for (const file of files) {
      const h = file.fileHeader;
      const isDir = h.flags.directory;
      out.push({ path: h.name, data: isDir ? new Uint8Array(0) : (file.extraction ?? new Uint8Array()), isDir });
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/password|encrypt|ERAR_MISSING_PASSWORD|ERAR_BAD_PASSWORD/i.test(msg)) throw encryptedError();
    throw { kind: 'corrupt', message: 'RAR 解包失败，文件可能损坏或需要密码', detail: msg.slice(0, 1500) } satisfies ConvertError;
  }
  return out;
}

/** 列 7Z 成员（解压到内存 FS 后读，7z 的 `l` 输出不适合解析）。 */
export async function extract7z(bytes: Uint8Array): Promise<RawMember[]> {
  const wasmBinary = await fetchAsset(SEVENZ_WASM_URL, '7Z 解包组件');
  const mod = await import('7z-wasm').catch((e) => {
    throw { kind: 'engine-load', message: '7Z 解包组件加载失败', detail: String(e) } satisfies ConvertError;
  });
  let sz;
  const stderrLines: string[] = [];
  try {
    sz = await mod.default({ wasmBinary, printErr: (s: string) => stderrLines.push(s) });
  } catch (e) {
    throw { kind: 'engine-load', message: '7Z 解包组件初始化失败', detail: String(e) } satisfies ConvertError;
  }
  const FS = sz.FS;
  const inName = 'input.7z';
  const outDir = '/out';
  try {
    FS.writeFile(inName, bytes);
    try {
      FS.mkdir(outDir);
    } catch {
      /* 已存在 */
    }
  } catch (e) {
    throw { kind: 'corrupt', message: '无法写入 7Z 解包临时区', detail: String(e) } satisfies ConvertError;
  }
  try {
    sz.callMain(['x', inName, `-o${outDir}`, '-y', '-bso0', '-bsp0', '-bse1']);
  } catch (e) {
    // 加密包 7z 会报「Wrong password」/「Can not open encrypted archive」
    const msg = (e as Error)?.message ?? String(e);
    const detail = msg + '\n' + stderrLines.join('');
    if (/password|encrypt|crypto/i.test(detail)) throw encryptedError();
    throw { kind: 'corrupt', message: '7Z 解包失败，文件可能损坏或需要密码', detail: detail.slice(0, 1500) } satisfies ConvertError;
  }

  const out: RawMember[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const full = `${dir}/${name}`;
      const relPath = rel ? `${rel}/${name}` : name;
      const st = FS.stat(full);
      if (FS.isDir(st.mode)) {
        out.push({ path: relPath + '/', data: new Uint8Array(0), isDir: true });
        walk(full, relPath);
      } else {
        const data = FS.readFile(full);
        out.push({ path: relPath, data: data.slice() as Uint8Array<ArrayBuffer>, isDir: false });
      }
    }
  };
  walk(outDir, '');
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // 视图可能只是大 buffer 的一段：切一份精确的 ArrayBuffer（node-unrar-js 要 ArrayBuffer）。
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
