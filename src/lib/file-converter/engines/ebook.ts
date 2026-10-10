// ─────────────────────────────────────────────────────────────────────────────
// file-converter/engines/ebook.ts —— EPUB 3 的构建与解析（共享内核）。
//
// 【谁在用】ebook 类别（Markdown / HTML / TXT ↔ EPUB）与 office 类别（DOCX → EPUB）
// 共用 `epubFromHtml`。**别改它的名字与 (html, meta) 形状** —— office 那边直接复用。
//
// 【纪律】
//   · 引擎（fflate）与 marked 一律 `await import(...)` 动态引入，静态 import 会把
//     它们卷进每个页面主包。
//   · 正文净化是**白名单**：只放行 p/h1-6/em/strong/ul/ol/li/blockquote/code/pre/br/hr/img，
//     script / style（含内容）剥掉，其余标签降级为纯文本。图片只接受 **data: URL 内嵌**，
//     外链一律剥掉并计数（roadmap §15：不外发、不引入跟踪像素）。
//   · 生成的是**最小合法 EPUB 3**：mimetype 为首成员且**不压缩**（OCF 硬要求 ——
//     压缩了就不叫 EPUB，阅读器直接拒收），container.xml → content.opf → nav/spine。
//   · 一切时间戳用真实 UTC（EPUB 的 dcterms:modified 要的是真实瞬间，与库内
//     「UTC+8 墙上时间」无关），且**不经**无参 new Date()（静态守卫会拦）。
// ─────────────────────────────────────────────────────────────────────────────

export interface EpubMeta {
  title: string;
  author?: string;
  language?: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

// ─── XHTML / XML 工具 ─────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 真实 UTC 瞬间的 ISO8601（去掉毫秒；给 EPUB 的 dcterms:modified 用）。 */
function utcNow(): string {
  const ms = Date.now();
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function simpleHash(s: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const g = globalThis.crypto as Crypto | undefined;
  const tail = typeof g?.randomUUID === 'function' ? g.randomUUID().slice(0, 18) : (h1 >>> 0).toString(16).padStart(8, '0');
  return (h1 >>> 0).toString(16).padStart(8, '0') + '-' + tail;
}

// ─── 正文净化（白名单）───────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'em', 'strong', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'br', 'hr', 'img',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);

export interface EmbeddedImage {
  /** 相对 OEBPS 的路径，如 `images/img-1.png`。 */
  path: string;
  mime: string;
  data: Uint8Array;
}

export interface SanitizeResult {
  body: string;
  images: EmbeddedImage[];
  /** 被剥掉的外链 / 非法图数量（结果页如实告知）。 */
  droppedImages: number;
}

const DATA_URL_RE = /^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/i;

function extForImageMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/svg+xml') return 'svg';
  return 'bin';
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const bin = typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/**
 * 白名单净化一段 HTML 正文，抽出内嵌 data: 图片。返回的是可安全放进 XHTML body 的片段。
 * 不是完整解析器，但三条最容易出事的路径都堵死了：script/style（含内容）、外链图片、
 * 未闭合/非白名单标签一律降级为**转义文本**。
 */
export function sanitizeHtml(html: string, imagePrefix = 'images'): SanitizeResult {
  const images: EmbeddedImage[] = [];
  let droppedImages = 0;
  let counter = 0;

  // 1. 去注释与 script/style（连同内容）
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');

  // 2. 先把 img 处理掉（提取 data:、剥外链）
  s = s.replace(/<img\b[^>]*\/?>/gi, (tag) => {
    const srcMatch = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const src = srcMatch ? srcMatch[2] ?? srcMatch[3] ?? srcMatch[4] ?? '' : '';
    const altMatch = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const alt = altMatch ? altMatch[2] ?? altMatch[3] ?? '' : '';
    const dataUrl = DATA_URL_RE.exec(src.trim());
    if (!dataUrl) {
      droppedImages++;
      return ''; // 外链 / 非法 → 剥掉（含外链跟踪像素）
    }
    const mime = dataUrl[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : dataUrl[1].toLowerCase();
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(dataUrl[2]);
    } catch {
      droppedImages++;
      return '';
    }
    counter++;
    const path = `${imagePrefix}/img-${counter}.${extForImageMime(mime)}`;
    images.push({ path, mime, data: bytes });
    return `<img src="${path}" alt="${escapeXml(alt)}"/>`;
  });

  // 3. 逐标签过滤：白名单保留（只留 img 的 src/alt），其余降级为文本
  let out = '';
  let last = 0;
  const tagRe = /<[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s)) !== null) {
    out += escapeText(s.slice(last, m.index));
    last = m.index + m[0].length;
    const raw = m[0];
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(raw);
    if (!nameMatch) {
      out += escapeText(raw); // 不像标签（如 `<3`）→ 转义
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const closing = /^<\s*\//.test(raw);
    if (!ALLOWED_TAGS.has(name)) continue; // 非白名单 → 丢标签，保留内容
    if (name === 'img') {
      // 第 2 步已把 img 重写成 `<img src="images/…" alt="…"/>`；这里**必须重新输出**
      // 它（早期版本在这里 continue 掉了，结果图进了包、正文里却没有引用 —— 静默丢图）。
      // 只回填我们自己产出的路径（src 以 imagePrefix 开头），其他一律丢弃。
      if (!closing) {
        const srcMatch = /\bsrc\s*=\s*"([^"]*)"/i.exec(raw);
        const altMatch = /\balt\s*=\s*"([^"]*)"/i.exec(raw);
        const src = srcMatch ? srcMatch[1] : '';
        if (src.startsWith(`${imagePrefix}/`)) {
          out += `<img src="${src}" alt="${altMatch ? altMatch[1] : ''}"/>`;
        }
      }
      continue;
    }
    if (closing) {
      if (!VOID_TAGS.has(name)) out += `</${name}>`;
    } else if (VOID_TAGS.has(name)) {
      out += `<${name}/>`;
    } else {
      out += `<${name}>`;
    }
  }
  out += escapeText(s.slice(last));

  return { body: out.trim(), images, droppedImages };
}

// ─── epubFromHtml：构建最小合法 EPUB 3 ────────────────────────────────────────

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

/**
 * 由 HTML 正文构建一个最小合法 EPUB 3（单章）。
 * 返回 **Uint8Array<ArrayBuffer>**（TS 5.7 起 Blob 只收 ArrayBuffer 支撑的视图；
 * 调用方 `new Blob([bytes])` 直接可用）。形状与 stub 一致。
 */
export async function epubFromHtml(html: string, meta: EpubMeta): Promise<Uint8Array<ArrayBuffer>> {
  const { zipSync } = await import('fflate');

  const title = meta.title?.trim() || '未命名';
  const language = meta.language?.trim() || 'zh';
  const { body, images } = sanitizeHtml(html);

  const chapterXhtml = xhtmlDoc(title, `<h1>${escapeText(title)}</h1>\n${body}`);
  const navXhtml = xhtmlDoc(
    '目录',
    `<nav xmlns:epub="http://www.idpf.org/2007/ops" epub:type="toc" id="toc"><ol><li><a href="chapter1.xhtml">${escapeText(title)}</a></li></ol></nav>`
  );

  const chapterItem: ManifestItem = { id: 'chapter1', href: 'chapter1.xhtml', mediaType: 'application/xhtml+xml' };
  const navItem: ManifestItem = { id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' };
  const imageItems: ManifestItem[] = images.map((img, i) => ({
    id: `img${i + 1}`,
    href: img.path,
    mediaType: img.mime,
  }));

  const manifest = [navItem, chapterItem, ...imageItems]
    .map(
      (it) =>
        `    <item id="${it.id}" href="${it.href}" media-type="${it.mediaType}"${it.properties ? ` properties="${it.properties}"` : ''}/>`
    )
    .join('\n');

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${simpleHash(title + language)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(language)}</dc:language>${meta.author ? `\n    <dc:creator>${escapeXml(meta.author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${utcNow()}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  // 顺序敏感：mimetype 必须第一个，且**不压缩**（level 0，OCF 硬要求）。fflate 按
  // 对象键的插入顺序写条目，所以 mimetype 放第一个。其余条目用默认压缩。
  type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  const entries: Record<string, [Uint8Array, { level: ZipLevel }]> = {
    mimetype: [textEncoder.encode('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': [textEncoder.encode(container), { level: 6 }],
    'OEBPS/content.opf': [textEncoder.encode(opf), { level: 6 }],
    'OEBPS/nav.xhtml': [textEncoder.encode(navXhtml), { level: 6 }],
    'OEBPS/chapter1.xhtml': [textEncoder.encode(chapterXhtml), { level: 6 }],
  };
  for (const img of images) entries[`OEBPS/${img.path}`] = [img.data, { level: 6 }];

  const zipped = zipSync(entries);
  return zipped as Uint8Array<ArrayBuffer>;
}

function xhtmlDoc(title: string, bodyInner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head>
  <meta charset="utf-8"/>
  <title>${escapeXml(title)}</title>
</head>
<body>
${bodyInner}
</body>
</html>`;
}

// ─── parseEpub：解包 + 按 spine 读章节 ────────────────────────────────────────

export interface ParsedChapter {
  /** 章节名（取 href 的文件名，去掉扩展）。 */
  name: string;
  /** 章节 xhtml 原文。 */
  html: string;
  /** 章节在包内的完整路径（资源相对解析用）。 */
  path: string;
}

export interface ParsedEpub {
  meta: { title: string; creator?: string; language?: string };
  chapters: ParsedChapter[];
  /** 图片 / 样式等非章节资源（zip 内路径 → 字节）。 */
  resources: Map<string, Uint8Array<ArrayBuffer>>;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? m[2] ?? m[3] ?? '' : null;
}

function joinPath(baseDir: string, href: string): string {
  const cleanHref = href.split('#')[0].split('?')[0];
  const parts = (baseDir ? baseDir.split('/') : []).filter(Boolean);
  for (const seg of cleanHref.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** 解包 EPUB：container.xml → opf → spine 顺序读章节（**不**按 zip 字典序）。 */
export async function parseEpub(bytes: Uint8Array): Promise<ParsedEpub> {
  const { unzipSync } = await import('fflate');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw { kind: 'corrupt', message: '无法解压 EPUB，文件可能损坏', detail: String(e) };
  }
  const get = (p: string): Uint8Array | null => files[p] ?? null;
  const decode = (b: Uint8Array | null): string => (b ? textDecoder.decode(b).replace(/^﻿/, '') : '');

  const containerXml = decode(get('META-INF/container.xml'));
  const rootMatch = /<rootfile\b[^>]*full-path\s*=\s*("([^"]*)"|'([^']*)')/i.exec(containerXml);
  const opfPath = rootMatch ? rootMatch[2] ?? rootMatch[3] ?? '' : '';
  // 退化：直接找任意 .opf
  const resolvedOpf =
    (opfPath && get(opfPath) ? opfPath : null) ||
    Object.keys(files).find((k) => k.toLowerCase().endsWith('.opf')) ||
    '';
  if (!resolvedOpf || !get(resolvedOpf)) {
    throw { kind: 'corrupt', message: 'EPUB 里找不到包文档（content.opf）' };
  }
  const opf = decode(get(resolvedOpf));
  const opfDir = resolvedOpf.includes('/') ? resolvedOpf.slice(0, resolvedOpf.lastIndexOf('/')) : '';

  const title = (/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] ?? '').trim();
  const creator = (/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf)?.[1] ?? '').trim() || undefined;
  const language = (/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i.exec(opf)?.[1] ?? '').trim() || undefined;

  // manifest：id → {href, mediaType}
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const m of opf.matchAll(/<item\b[^>]*\/?>/gi)) {
    const tag = m[0];
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (id && href) manifest.set(id, { href, mediaType: attr(tag, 'media-type') ?? '' });
  }
  // spine 顺序
  const spineIds: string[] = [];
  const spineMatch = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf);
  if (spineMatch) {
    for (const m of spineMatch[1].matchAll(/<itemref\b[^>]*\/?>/gi)) {
      const idref = attr(m[0], 'idref');
      if (idref) spineIds.push(idref);
    }
  }

  const chapters: ParsedChapter[] = [];
  const usedPaths = new Set<string>();
  for (const id of spineIds) {
    const item = manifest.get(id);
    if (!item) continue;
    if (!/xhtml|html/i.test(item.mediaType) && !/\.x?html?$/i.test(item.href)) continue;
    const zipPath = joinPath(opfDir, item.href);
    const data = get(zipPath);
    if (!data) continue;
    usedPaths.add(zipPath);
    const base = zipPath.split('/').pop() ?? id;
    chapters.push({ name: base.replace(/\.[^.]+$/, ''), html: decode(data), path: zipPath });
  }

  const resources = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [path, data] of Object.entries(files)) {
    if (path === 'mimetype' || path === 'META-INF/container.xml' || path === resolvedOpf) continue;
    if (usedPaths.has(path)) continue;
    if (path.toLowerCase().endsWith('.ncx') || path === joinPath(opfDir, 'nav.xhtml') || path.endsWith('nav.xhtml')) continue;
    resources.set(path, data as Uint8Array<ArrayBuffer>);
  }

  return { meta: { title, creator, language }, chapters, resources };
}

// ─── 章节 HTML → 纯文本 / Markdown（纯函数，ebook 与 office 都可复用）───────────

const ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, ent: string) => {
    if (ENTITY_MAP[ent]) return ENTITY_MAP[ent];
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
    }
    return full;
  });
}

/** 章节 HTML → 纯文本（保留段落换行）。 */
export function htmlToPlainText(html: string): string {
  const noHead = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const withBreaks = noHead
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|pre)>/gi, '\n')
    .replace(/<(h[1-6]|p|div|li|blockquote|tr|pre)\b[^>]*>/gi, '');
  const noTags = withBreaks.replace(/<[^>]*>/g, '');
  return decodeEntities(noTags)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 章节 HTML → Markdown（简单标签映射，够日常阅读）。 */
export function htmlToMarkdown(html: string): string {
  const noHead = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
  let s = noHead
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `**${inner}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `*${inner}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => `\`${inner}\``)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => `\n\`\`\`\n${decodeEntities(inner.replace(/<[^>]*>/g, ''))}\n\`\`\`\n`);
  for (let level = 1; level <= 6; level++) {
    s = s.replace(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)</h${level}>`, 'gi'), (_m, inner) => `\n${'#'.repeat(level)} ${inner.replace(/<[^>]*>/g, '').trim()}\n`);
  }
  s = s
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => `- ${inner.replace(/<[^>]*>/g, '').trim()}\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => `\n> ${inner.replace(/<[^>]*>/g, '').trim().replace(/\n/g, '\n> ')}\n`)
    .replace(/<\/(p|div)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 供 runner 从图片路径取 MIME（epub-extract 给输出名用）。 */
export function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'css': return 'text/css';
    case 'xhtml':
    case 'html': return 'application/xhtml+xml';
    default: return 'application/octet-stream';
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

function bodyInner(xhtml: string): string {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(xhtml);
  return (m ? m[1] : xhtml).trim();
}

/** 把章节里的 <img src> 换成 resources 里的 data: URL（外链保持原样）。 */
function embedChapterImages(inner: string, chapterPath: string, resources: Map<string, Uint8Array>): string {
  const dir = dirOf(chapterPath);
  return inner.replace(/(<img\b[^>]*\bsrc\s*=\s*)("([^"]*)"|'([^']*)')/gi, (full, pre: string, _q: string, dq?: string, sq?: string) => {
    const src = dq ?? sq ?? '';
    if (!src || src.startsWith('data:')) return full;
    let hit = resources.get(joinPath(dir, src)) ?? resources.get(src);
    if (!hit) {
      const bn = src.split('/').pop()?.split('?')[0];
      for (const [p, d] of resources) {
        if (p.split('/').pop() === bn) {
          hit = d;
          break;
        }
      }
    }
    if (!hit) return full; // 找不到资源：保留原引用（不静默丢图）
    const ext = (src.split('.').pop() ?? '').toLowerCase();
    return `${pre}"${`data:${mimeForExt(ext)};base64,${bytesToBase64(hit)}`}"`;
  });
}

/** 全部章节拼成一个 HTML 文件；资源内嵌为 data: URL（体积会明显增大）。 */
export function chaptersToSingleHtml(parsed: ParsedEpub, title: string): string {
  const parts = parsed.chapters.map((c) => embedChapterImages(bodyInner(c.html), c.path, parsed.resources));
  return `<!DOCTYPE html>
<html lang="${escapeXml(parsed.meta.language ?? 'zh')}">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
</head>
<body>
${parts.join('\n<hr/>\n')}
</body>
</html>
`;
}

/** 全部章节按 spine 顺序拼成一段 Markdown（章间以 --- 分隔）。 */
export function chaptersToMarkdown(parsed: ParsedEpub): string {
  return parsed.chapters.map((c) => htmlToMarkdown(c.html)).join('\n\n---\n\n').trim();
}

/** 全部章节拼成纯文本（章间空行分隔）。 */
export function chaptersToText(parsed: ParsedEpub): string {
  return parsed.chapters.map((c) => htmlToPlainText(c.html)).join('\n\n').trim();
}
