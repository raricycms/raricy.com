// ─────────────────────────────────────────────────────────────────────────────
// file-converter/categories/archive.ts —— 压缩包能力区（roadmap §11）。
//
// 【范围】多文件 ↔ ZIP / TAR / TAR.GZ；ZIP ↔ TAR.GZ 换容器；单文件 ↔ GZIP；
//   RAR / 7Z → ZIP（只解不压：RAR 无编码器、7Z 走 7z-wasm 只做解包）；
//   ZIP 重压缩（level 9）。
//
// 【引擎】fflate（ZIP / GZIP，构建进包、`await import`）做通用容器；TAR 由
//   engines/tar.ts 自写；RAR / 7Z 的 wasm 从**同源** /static/converter/ 取。
//   除了同源取引擎资产，runner 里**没有任何网络请求** —— 包内容只在本机内存里。
//
// 【安全闸（roadmap §11.2）】解压前先读成员元信息跑 validateMembers（成员数 /
//   总量 / 深度 / 压缩比 / zip-slip 路径），再判加密；过了才真正解压。这批判据
//   住在 engines/archive.ts 的纯函数里，单测直接驱动。
//
// 【多输出的 ext】解包出来的成员**扩展名不统一**（一个包里 html + png + txt 都有），
//   所以这类边的 result.ext 用哨兵 'bin'（不在 verifyOutputBytes 的核验表里 →
//   复核退化为「非空」，逐成员不硬套一种格式；单成员的类型正确性由包本身保证）。
// ─────────────────────────────────────────────────────────────────────────────

import { FORMATS, LIMITS, formatBytes } from '../formats';
import type { CategoryDef, ConvertError, ConvertResultData, FileKind, InspectInfo, OutputFile, RunContext } from '../types';
import { convertedName, uniqueOutputName } from '../utils';
import { buildTar, parseTar } from '../engines/tar';
import {
  extract7z,
  extractRar,
  gzipBytes,
  gzipIsize,
  gunzipBytes,
  listRar,
  sanitizeMemberPath,
  totalMemberBytes,
  unzipAll,
  validateMembers,
  zipHasEncryptedEntry,
  zipMemberMetas,
  zipMembers,
  type NamedBytes,
} from '../engines/archive';

// ─── 通用小件 ────────────────────────────────────────────────────────────────

/** 解包出来的成员：结果 list 里每份单独下载，扩展名不统一 → 复核走哨兵。 */
const MIXED_EXT = 'bin';

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw { kind: 'cancelled', message: '已取消' } satisfies ConvertError;
}

function oversize(message: string): ConvertError {
  return { kind: 'oversize', message };
}

/** 我们的**输入**文件名 → 包内成员名（去掉路径分隔、非法字符；重名去重）。 */
function safeInputName(name: string, taken: Set<string>): string {
  const cleaned = sanitizeMemberPath(name.replace(/[\\]/g, '/')) ?? 'file';
  let candidate = cleaned;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${cleaned}-${n}`;
    n++;
  }
  taken.add(candidate);
  return candidate;
}

/** 成员路径 → 扩展名（给下载名用）。 */
function memberExt(path: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(path);
  return m ? m[1].toLowerCase() : 'bin';
}

async function readBytes(ctx: RunContext, file: File): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}

/** 所有能被「打包/压缩流」边接收的 kind。**含 unknown** —— 打包任意字节是合法的，
 *  不该因为嗅探不出内容就被拒（那是「按内容识别」用于转换方向的原则，不适用于打包）。 */
const ALL_KINDS: FileKind[] = [
  'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'ico', 'svg', 'heic', 'avif',
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'aiff',
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv',
  'pdf', 'zip', 'gzip', 'xz', 'tar', '7z', 'rar',
  'epub', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'doc', 'xls', 'ppt',
  'json', 'ndjson', 'xml', 'yaml', 'csv', 'tsv', 'srt', 'vtt', 'ass',
  'html', 'markdown', 'text', 'unknown',
];

/** 按字节魔数判 RAR / 7Z（不信任扩展名）。 */
function archiveKindOf(bytes: Uint8Array): 'rar' | '7z' | 'other' {
  if (bytes.length >= 7 && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) return 'rar';
  if (bytes.length >= 6 && bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf) return '7z';
  return 'other';
}

/**
 * 成员（已净化的 path + data）→ OutputFile[]（重名去重、去掉目录结构除基名）。
 * **跳过零字节成员** —— 执行器把「0 字节输出」判为失败（不交付半成品），一个空
 * 文件不该让整包解压失败；跳过的数量由调用方在 notice 里如实交代。
 */
function membersToOutputs(members: { path: string; data: Uint8Array }[], taken: Set<string>): OutputFile[] {
  return members
    .filter((m) => m.data.byteLength > 0)
    .map((m) => {
      const ext = memberExt(m.path);
      const name = uniqueOutputName(m.path, ext, taken);
      return { blob: new Blob([m.data as Uint8Array<ArrayBuffer>]), name, note: m.path };
    });
}

function countEmpty(members: { data: Uint8Array }[]): number {
  return members.filter((m) => m.data.byteLength === 0).length;
}

// ─── ZIP / TAR / TAR.GZ：打包 ─────────────────────────────────────────────────

type PackKind = 'zip' | 'tar' | 'targz';

async function runPack(ctx: RunContext, kind: PackKind, level: number): Promise<ConvertResultData> {
  const files = ctx.files;
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > LIMITS.archive.maxBytes) {
    throw oversize(`合计 ${formatBytes(total)} 超过 ${formatBytes(LIMITS.archive.maxBytes)} 打包上限`);
  }
  const takenNames = new Set<string>();
  const entries: NamedBytes[] = [];
  ctx.onPhase('converting');
  for (let i = 0; i < files.length; i++) {
    aborted(ctx.signal);
    const f = files[i];
    const name = safeInputName(f.name, takenNames);
    const data = await readBytes(ctx, f);
    entries.push({ path: name, data });
    ctx.onProgress((i + 1) / files.length, `已读取 ${i + 1}/${files.length}`);
  }
  aborted(ctx.signal);

  let out: Uint8Array<ArrayBuffer>;
  let fmt: (typeof FORMATS)[keyof typeof FORMATS];
  if (kind === 'zip') {
    out = await zipMembers(entries, level);
    fmt = FORMATS.zip;
  } else if (kind === 'tar') {
    out = buildTar(entries.map((e) => ({ name: e.path, data: e.data })));
    fmt = FORMATS.tar;
  } else {
    const tar = buildTar(entries.map((e) => ({ name: e.path, data: e.data })));
    out = await gzipBytes(tar, level);
    fmt = FORMATS['tar.gz'];
  }
  const name = convertedName(ctx.file.name, fmt.ext, new Set());
  return {
    outputs: [{ blob: new Blob([out]), name }],
    mime: fmt.mime,
    ext: fmt.ext,
    inputSize: total,
    outputSize: out.byteLength,
    notices:
      kind === 'targz'
        ? [`把 ${files.length} 个文件打成 TAR 后 gzip 压缩`, '时间戳与权限不保留（全部按 0 时间写入）']
        : [`把 ${files.length} 个文件打包为 ${fmt.label}`, '时间戳与权限不保留（全部按 0 时间写入）'],
    previewKind: 'none',
  };
}

// ─── ZIP：解包 ────────────────────────────────────────────────────────────────

/** 解一个 ZIP 的字节 → 已净化的成员（含安全闸）。返回 data 与 safePath 对齐。 */
async function openZip(ctx: RunContext, bytes: Uint8Array): Promise<{ path: string; data: Uint8Array<ArrayBuffer> }[]> {
  if (bytes.byteLength > LIMITS.archive.maxBytes) {
    throw oversize(`压缩包 ${formatBytes(bytes.byteLength)} 超过 ${formatBytes(LIMITS.archive.maxBytes)} 上限`);
  }
  ctx.onPhase('probing');
  const metas = zipMemberMetas(bytes);
  if (!metas) throw { kind: 'corrupt', message: '无法读取 ZIP 目录，文件可能损坏' } satisfies ConvertError;
  if (zipHasEncryptedEntry(bytes)) {
    throw { kind: 'unsupported', message: '加密压缩包暂不支持（请先在本机解密后再转换）' } satisfies ConvertError;
  }
  const v = validateMembers(metas);
  if (!v.ok) throw v.error ?? { kind: 'unsupported', message: '压缩包内容不合法' };
  const uncompressed = totalMemberBytes(metas);
  if (uncompressed > LIMITS.queue.maxOutputEach) {
    throw { kind: 'budget', message: `解压后约 ${formatBytes(uncompressed)}，超过单次输出上限 ${formatBytes(LIMITS.queue.maxOutputEach)}` } satisfies ConvertError;
  }
  ctx.onPhase('converting');
  aborted(ctx.signal);
  const raw = await unzipAll(bytes);
  // 与 net 化后的 safePath 对齐：原始 patch 已通过 validateMembers，这里再净化一次并去重。
  const taken = new Set<string>();
  const out: { path: string; data: Uint8Array<ArrayBuffer> }[] = [];
  for (const m of raw) {
    const safe = sanitizeMemberPath(m.path);
    if (safe === null) continue; // 理论上到不了这里（validateMembers 已挡）
    let path = safe;
    let n = 2;
    while (taken.has(path)) {
      path = `${safe}-${n}`;
      n++;
    }
    taken.add(path);
    out.push({ path, data: m.data });
  }
  return out;
}

async function runUnzip(ctx: RunContext): Promise<ConvertResultData> {
  const taken = new Set<string>();
  const outputs: OutputFile[] = [];
  let inputSize = 0;
  let totalMembers = 0;
  let droppedDir = 0;
  let emptyDropped = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    aborted(ctx.signal);
    const bytes = await readBytes(ctx, ctx.files[i]);
    inputSize += bytes.byteLength;
    const members = await openZip(ctx, bytes);
    droppedDir += members.length === 0 ? 1 : 0;
    totalMembers += members.length;
    emptyDropped += countEmpty(members);
    outputs.push(...membersToOutputs(members, taken));
    ctx.onProgress((i + 1) / ctx.files.length);
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: 'application/octet-stream',
    ext: MIXED_EXT,
    inputSize,
    outputSize,
    notices: [
      `解出 ${totalMembers} 个成员，各成员单独下载`,
      '原始目录结构保留在下载名里（路径分隔符已去掉）',
      '时间戳与权限不保留',
      ...(emptyDropped ? [`${emptyDropped} 个空文件未输出`] : []),
      ...(droppedDir ? [`其中 ${droppedDir} 个压缩包没有可解出的成员`] : []),
    ],
    previewKind: 'none',
  };
}

// ─── TAR：解包 ────────────────────────────────────────────────────────────────

async function runUntar(ctx: RunContext): Promise<ConvertResultData> {
  const taken = new Set<string>();
  const outputs: OutputFile[] = [];
  let inputSize = 0;
  let totalMembers = 0;
  let emptyDropped = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    aborted(ctx.signal);
    const bytes = await readBytes(ctx, ctx.files[i]);
    inputSize += bytes.byteLength;
    if (bytes.byteLength > LIMITS.archive.maxBytes) {
      throw oversize(`TAR ${formatBytes(bytes.byteLength)} 超过 ${formatBytes(LIMITS.archive.maxBytes)} 上限`);
    }
    ctx.onPhase('probing');
    const members = parseTar(bytes, LIMITS.archive);
    const v = validateMembers(members.map((m) => ({ path: m.path, size: m.data.byteLength, isDir: m.isDir })));
    if (!v.ok) throw v.error ?? { kind: 'unsupported', message: 'TAR 内容不合法' };
    ctx.onPhase('converting');
    // 直接按成员顺序用净化后的 safePath（validateMembers 保序，索引一一对应）
    const aligned = members
      .map((m, idx) => ({ member: m, safe: v.members[idx]?.safePath }))
      .filter((x) => !x.member.isDir && x.safe)
      .map((x) => ({ path: x.safe as string, data: x.member.data as Uint8Array<ArrayBuffer> }));
    totalMembers += aligned.length;
    emptyDropped += countEmpty(aligned);
    outputs.push(...membersToOutputs(aligned, taken));
    ctx.onProgress((i + 1) / ctx.files.length);
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: 'application/octet-stream',
    ext: MIXED_EXT,
    inputSize,
    outputSize,
    notices: [
      `解出 ${totalMembers} 个成员，各成员单独下载`,
      '时间戳与权限不保留',
      ...(emptyDropped ? [`${emptyDropped} 个空文件未输出`] : []),
    ],
    previewKind: 'none',
  };
}

// ─── GZIP：压缩 / 解压（单文件流）────────────────────────────────────────────

async function runToGzip(ctx: RunContext, level: number): Promise<ConvertResultData> {
  const taken = new Set<string>();
  const outputs: OutputFile[] = [];
  let inputSize = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    aborted(ctx.signal);
    const f = ctx.files[i];
    const data = await readBytes(ctx, f);
    inputSize += data.byteLength;
    ctx.onPhase('converting');
    const out = await gzipBytes(data, level);
    const name = uniqueOutputName(`${f.name}.gz`, 'gz', taken);
    outputs.push({ blob: new Blob([out]), name });
    ctx.onProgress((i + 1) / ctx.files.length);
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: FORMATS.gzip.mime,
    ext: FORMATS.gzip.ext,
    inputSize,
    outputSize,
    notices: ['gzip 只压缩单个文件，不含文件名与目录结构', '时间戳不保留'],
    previewKind: 'none',
  };
}

async function runGunzip(ctx: RunContext): Promise<ConvertResultData> {
  const taken = new Set<string>();
  const outputs: OutputFile[] = [];
  let inputSize = 0;
  let emptyDropped = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    aborted(ctx.signal);
    const f = ctx.files[i];
    const bytes = await readBytes(ctx, f);
    inputSize += bytes.byteLength;
    if (bytes.byteLength > LIMITS.archive.maxBytes) {
      throw oversize(`GZIP ${formatBytes(bytes.byteLength)} 超过 ${formatBytes(LIMITS.archive.maxBytes)} 上限`);
    }
    const isize = gzipIsize(bytes);
    if (isize !== null && isize > LIMITS.queue.maxOutputEach) {
      throw { kind: 'budget', message: `解压后约 ${formatBytes(isize)}，超过单次输出上限` } satisfies ConvertError;
    }
    ctx.onPhase('converting');
    let out: Uint8Array<ArrayBuffer>;
    try {
      out = await gunzipBytes(bytes);
    } catch (e) {
      throw { kind: 'corrupt', message: 'GZIP 解压失败，文件可能损坏', detail: String(e) } satisfies ConvertError;
    }
    if (out.byteLength === 0) {
      emptyDropped++;
      continue; // 空输出会被执行器判为失败；跳过并在 notice 交代
    }
    // 名字：去掉 .gz / .tgz（.tgz → .tar），没有可辨扩展就退 .bin
    const base = f.name.replace(/\.(gz|gzip)$/i, '').replace(/\.tgz$/i, '.tar');
    const extMatch = /\.([A-Za-z0-9]{1,8})$/.exec(base);
    const ext = base === f.name ? 'bin' : extMatch ? extMatch[1].toLowerCase() : 'bin';
    const name = uniqueOutputName(base, ext, taken);
    outputs.push({ blob: new Blob([out]), name });
    ctx.onProgress((i + 1) / ctx.files.length);
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: 'application/octet-stream',
    ext: MIXED_EXT,
    inputSize,
    outputSize,
    notices: [
      '解压得到原始字节流（若原本是 .tar.gz，得到的是 .tar）',
      '时间戳不保留',
      ...(emptyDropped ? [`${emptyDropped} 个解压结果为空，未输出`] : []),
    ],
    previewKind: 'none',
  };
}

// ─── 换容器：ZIP ↔ TAR.GZ ─────────────────────────────────────────────────────

async function runZipToTargz(ctx: RunContext, level: number): Promise<ConvertResultData> {
  const taken = new Set<string>();
  const outputs: OutputFile[] = [];
  let inputSize = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    aborted(ctx.signal);
    const f = ctx.files[i];
    const bytes = await readBytes(ctx, f);
    inputSize += bytes.byteLength;
    const members = await openZip(ctx, bytes);
    const tar = buildTar(members.map((m) => ({ name: m.path, data: m.data })));
    const out = await gzipBytes(tar, level);
    const name = convertedName(f.name, FORMATS['tar.gz'].ext, taken);
    outputs.push({ blob: new Blob([out]), name });
    ctx.onProgress((i + 1) / ctx.files.length);
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: FORMATS['tar.gz'].mime,
    ext: FORMATS['tar.gz'].ext,
    inputSize,
    outputSize,
    notices: ['ZIP → TAR.GZ：成员内容保持，容器与压缩算法改变', '时间戳、权限与 ZIP 特有属性不保留'],
    previewKind: 'none',
  };
}

async function runTargzToZip(ctx: RunContext, level: number): Promise<ConvertResultData> {
  const taken = new Set<string>();
  const outputs: OutputFile[] = [];
  let inputSize = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    aborted(ctx.signal);
    const f = ctx.files[i];
    const bytes = await readBytes(ctx, f);
    inputSize += bytes.byteLength;
    if (bytes.byteLength > LIMITS.archive.maxBytes) {
      throw oversize(`压缩包 ${formatBytes(bytes.byteLength)} 超过上限`);
    }
    ctx.onPhase('probing');
    let tarBytes: Uint8Array<ArrayBuffer>;
    try {
      tarBytes = await gunzipBytes(bytes);
    } catch (e) {
      throw { kind: 'corrupt', message: 'GZIP 解压失败，可能不是 .tar.gz', detail: String(e) } satisfies ConvertError;
    }
    const members = parseTar(tarBytes, LIMITS.archive);
    const v = validateMembers(members.map((m) => ({ path: m.path, size: m.data.byteLength, isDir: m.isDir })));
    if (!v.ok) throw v.error ?? { kind: 'unsupported', message: 'TAR 内容不合法' };
    ctx.onPhase('converting');
    const entries: NamedBytes[] = members
      .map((m, idx) => ({ member: m, safe: v.members[idx]?.safePath }))
      .filter((x) => !x.member.isDir && x.safe)
      .map((x) => ({ path: x.safe as string, data: x.member.data }));
    const out = await zipMembers(entries, level);
    const name = convertedName(f.name, FORMATS.zip.ext, taken);
    outputs.push({ blob: new Blob([out]), name });
    ctx.onProgress((i + 1) / ctx.files.length);
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: FORMATS.zip.mime,
    ext: FORMATS.zip.ext,
    inputSize,
    outputSize,
    notices: ['TAR.GZ → ZIP：成员内容保持，容器与压缩算法改变', '时间戳、权限不保留'],
    previewKind: 'none',
  };
}

// ─── RAR / 7Z → ZIP ──────────────────────────────────────────────────────────

async function runToZip(ctx: RunContext, level: number): Promise<ConvertResultData> {
  const taken = new Set<string>();
  const outputs: OutputFile[] = [];
  let inputSize = 0;
  let totalMembers = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    aborted(ctx.signal);
    const f = ctx.files[i];
    const bytes = await readBytes(ctx, f);
    inputSize += bytes.byteLength;
    if (bytes.byteLength > LIMITS.archive.maxBytes) {
      throw oversize(`压缩包 ${formatBytes(bytes.byteLength)} 超过上限`);
    }
    const kind = archiveKindOf(bytes);
    ctx.onPhase('probing');
    let raw: { path: string; data: Uint8Array<ArrayBuffer>; isDir: boolean }[];
    if (kind === 'rar') {
      // 先列清单跑安全闸（RAR 引擎能不解压就列），再解压。
      const metas = await listRar(bytes);
      const v = validateMembers(metas);
      if (!v.ok) throw v.error ?? { kind: 'unsupported', message: 'RAR 内容不合法' };
      raw = await extractRar(bytes);
    } else if (kind === '7z') {
      raw = await extract7z(bytes);
      const v = validateMembers(raw.map((m) => ({ path: m.path, size: m.data.byteLength, isDir: m.isDir })));
      if (!v.ok) throw v.error ?? { kind: 'unsupported', message: '7Z 内容不合法' };
    } else {
      throw { kind: 'unsupported', message: '只支持 RAR / 7Z 输入' } satisfies ConvertError;
    }
    ctx.onPhase('converting');
    const takenInner = new Set<string>();
    const entries: NamedBytes[] = [];
    for (const m of raw) {
      if (m.isDir) continue;
      const safe = sanitizeMemberPath(m.path);
      if (safe === null) continue;
      let path = safe;
      let n = 2;
      while (takenInner.has(path)) {
        path = `${safe}-${n}`;
        n++;
      }
      takenInner.add(path);
      entries.push({ path, data: m.data });
    }
    totalMembers += entries.length;
    const out = await zipMembers(entries, level);
    const name = convertedName(f.name, FORMATS.zip.ext, taken);
    outputs.push({ blob: new Blob([out]), name });
    ctx.onProgress((i + 1) / ctx.files.length);
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: FORMATS.zip.mime,
    ext: FORMATS.zip.ext,
    inputSize,
    outputSize,
    notices: [
      `解出 ${totalMembers} 个成员并用 ZIP 重新打包`,
      'RAR / 7Z 只支持解包（本站没有 RAR 编码器，7Z 走只解不压的 wasm）',
      '时间戳与文件属性不保留',
    ],
    previewKind: 'none',
  };
}

// ─── ZIP → 更高压缩 ZIP ───────────────────────────────────────────────────────

async function runConvertMembers(ctx: RunContext, level: number): Promise<ConvertResultData> {
  const taken = new Set<string>();
  const outputs: OutputFile[] = [];
  let inputSize = 0;
  for (let i = 0; i < ctx.files.length; i++) {
    aborted(ctx.signal);
    const f = ctx.files[i];
    const bytes = await readBytes(ctx, f);
    inputSize += bytes.byteLength;
    const members = await openZip(ctx, bytes);
    ctx.onPhase('converting');
    const entries: NamedBytes[] = members.map((m) => ({ path: m.path, data: m.data }));
    const out = await zipMembers(entries, level);
    const name = convertedName(f.name, FORMATS.zip.ext, taken);
    outputs.push({ blob: new Blob([out]), name });
    ctx.onProgress((i + 1) / ctx.files.length);
  }
  const outputSize = outputs.reduce((s, o) => s + o.blob.size, 0);
  return {
    outputs,
    mime: FORMATS.zip.mime,
    ext: FORMATS.zip.ext,
    inputSize,
    outputSize,
    notices: [
      '解包后用更高级别重新压缩；对已压缩内容（jpg / mp4 / 已压缩包）几乎无收益，甚至可能更大',
      '时间戳、权限与 ZIP 特有属性不保留',
    ],
    previewKind: 'none',
  };
}

// ─── 参数 ────────────────────────────────────────────────────────────────────

const ZIP_LEVEL_OPTIONS = [
  { value: '1', label: '1（最快）' },
  { value: '6', label: '6（默认）' },
  { value: '9', label: '9（最紧）' },
];

function levelParam(defaultValue: string, help: string) {
  return {
    key: 'level',
    label: '压缩级别',
    type: 'select' as const,
    options: ZIP_LEVEL_OPTIONS,
    defaultValue,
    advanced: true,
    help,
  };
}

function levelOf(ctx: RunContext, fallback: number): number {
  const v = ctx.params.level;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(9, Math.max(0, Math.round(n)));
}

/** 解包边的输出体积下限估计（ZIP 的中央目录给了原始体积）。 */
function unzipEstimate(info: InspectInfo): number | null {
  if (!info.members || info.members.length === 0) return null;
  return totalMemberBytes(info.members);
}

// ─── 类别定义 ─────────────────────────────────────────────────────────────────

export const CATEGORY: CategoryDef = {
  key: 'archive',
  label: '压缩包',
  hint:
    '打包成 ZIP / TAR / TAR.GZ，解包 ZIP / TAR / GZIP，ZIP ↔ TAR.GZ 换容器，RAR / 7Z 转 ZIP。' +
    '解压前先校验成员数、解压总量、目录层级与压缩比；加密包暂不支持。文件只在本机处理，不递归展开包中包。',
  accept: '.zip,.tar,.gz,.tgz,.tar.gz,.7z,.rar',
  maxFilesPerTask: 200,
  edges: [
    {
      id: 'archive:zip',
      label: 'ZIP（通用压缩包）',
      from: [...ALL_KINDS],
      to: 'zip',
      method: 'repack',
      notices: ['按所选文件顺序打包为 ZIP', '时间戳与权限不保留'],
      params: [levelParam('6', '越高压得越小、越慢；对已压缩内容无意义')],
      run: (ctx) => runPack(ctx, 'zip', levelOf(ctx, 6)),
      status: 'live',
      group: '打包',
    },
    {
      id: 'archive:tar',
      label: 'TAR（Unix 归档）',
      from: [...ALL_KINDS],
      to: 'tar',
      method: 'repack',
      notices: ['打包为 TAR（不压缩，体积接近原文件之和）', '时间戳与权限不保留'],
      params: [],
      run: (ctx) => runPack(ctx, 'tar', 0),
      status: 'live',
      group: '打包',
    },
    {
      id: 'archive:to-targz',
      label: 'TAR.GZ（打包并压缩）',
      from: [...ALL_KINDS],
      to: 'tar.gz',
      method: 'repack',
      notices: ['打包为 TAR 后 gzip 压缩', '时间戳与权限不保留'],
      params: [levelParam('6', '压缩级别')],
      run: (ctx) => runPack(ctx, 'targz', levelOf(ctx, 6)),
      status: 'live',
      group: '打包',
    },
    {
      id: 'archive:unzip',
      label: '解包 ZIP（成员逐个输出）',
      from: ['zip'],
      to: 'zip',
      method: 'extract',
      notices: ['解出压缩包里的成员，每个单独下载', '时间戳与权限不保留'],
      params: [],
      estimateOutput: (info) => unzipEstimate(info),
      run: (ctx) => runUnzip(ctx),
      status: 'live',
      group: '解包',
    },
    {
      id: 'archive:untar',
      label: '解包 TAR（成员逐个输出）',
      from: ['tar'],
      to: 'tar',
      method: 'extract',
      notices: ['解出 TAR 里的成员，每个单独下载', '时间戳与权限不保留'],
      params: [],
      run: (ctx) => runUntar(ctx),
      status: 'live',
      group: '解包',
    },
    {
      id: 'archive:to-gzip',
      label: 'GZIP（单文件压缩）',
      from: [...ALL_KINDS],
      to: 'gzip',
      method: 'repack',
      notices: ['gzip 只压缩单个文件，不含文件名与目录结构', '时间戳不保留'],
      params: [levelParam('6', '压缩级别')],
      run: (ctx) => runToGzip(ctx, levelOf(ctx, 6)),
      status: 'live',
      group: '压缩流',
    },
    {
      id: 'archive:gunzip',
      label: '解压 GZIP（还原原始字节）',
      from: ['gzip'],
      to: 'bin',
      method: 'extract',
      notices: ['解压得到原始字节流；若原本是 .tar.gz，得到的是 .tar', '时间戳不保留'],
      params: [],
      run: (ctx) => runGunzip(ctx),
      status: 'live',
      group: '压缩流',
    },
    {
      id: 'archive:zip-to-targz',
      label: 'ZIP → TAR.GZ',
      from: ['zip'],
      to: 'tar.gz',
      method: 'repack',
      notices: ['解包后以 TAR.GZ 重新打包，成员内容保持', '时间戳、权限与 ZIP 特有属性不保留'],
      params: [levelParam('6', '压缩级别')],
      run: (ctx) => runZipToTargz(ctx, levelOf(ctx, 6)),
      status: 'live',
      group: '换容器',
    },
    {
      id: 'archive:targz-to-zip',
      label: 'TAR.GZ → ZIP',
      from: ['gzip'],
      to: 'zip',
      method: 'repack',
      notices: ['解包后以 ZIP 重新打包，成员内容保持', '时间戳、权限不保留'],
      params: [levelParam('6', '压缩级别')],
      run: (ctx) => runTargzToZip(ctx, levelOf(ctx, 6)),
      status: 'live',
      group: '换容器',
    },
    {
      id: 'archive:to-zip',
      label: '转换旧压缩包为 ZIP（RAR / 7Z）',
      from: ['rar', '7z'],
      to: 'zip',
      method: 'repack',
      notices: [
        'RAR / 7Z 只支持解包（本站没有 RAR 编码器；7Z 走只解不压的 wasm）',
        '包内内容保持，时间戳与文件属性不保留',
      ],
      params: [levelParam('6', 'ZIP 压缩级别')],
      run: (ctx) => runToZip(ctx, levelOf(ctx, 6)),
      status: 'live',
      group: '换容器',
    },
    {
      id: 'archive:convert-members',
      label: '重压缩 ZIP（level 9，能更小则更小）',
      from: ['zip'],
      to: 'zip',
      method: 'repack',
      notices: [
        '解包后用最高级别重新压缩',
        '对已压缩内容（jpg / mp4 / 已压缩包）几乎无收益，甚至可能更大',
        '时间戳与权限不保留',
      ],
      params: [levelParam('9', '重压缩级别')],
      estimateOutput: (info) => unzipEstimate(info),
      run: (ctx) => runConvertMembers(ctx, levelOf(ctx, 9)),
      status: 'live',
      group: '重压缩',
    },
  ],
};
