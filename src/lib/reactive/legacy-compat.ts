// ─────────────────────────────────────────────────────────────────────────────
// legacy-compat.ts — 旧 Markdown 正文里的历史 HTML → ReactiveMD 可安全解释的形状
//
// 本站旧管线（marked + DOMPurify）对正文里的 HTML 是**宽容**的：不认识的标签 /
// 属性会被剥掉、子文本保留；`<font style=…>`、`<center>`、`</br>` 这类历史写法
// 都能读。ReactiveMD 的原生 HTML 解析更严格：一个不支持的属性就会让**整段**
// 退成源码（`local.html.fallback`），未知标签甚至会让整篇 `ok: false`。
//
// 直接把旧正文交给新引擎会得到三种静默坏页面：
//   · `<font …>正文</font>` → 屏幕上只剩一段源码，正文消失；
//   · `<TAB>` 这类未知标签 → 整篇不可用；
//   · 十几万字符的 data JPEG → 源码淹没正文。
//
// 本模块在**编译前**做一轮兼容改写，规则对齐旧白名单的净化结果：
//   · 不支持的标签 / 属性：剥掉标签或属性，保留可读子节点；
//   · `</br>` 归一成 `<br/>`；多余的 `</details>` 直接去掉；
//   · 危险能力（script / style / iframe / SVG / 整页 HTML）继续拒绝，
//     冗余 DOM 源码不进入页面；
//   · 历史 data 位图只认受限的四类 MIME + base64 + 魔数（data-image.ts），
//     转成 Markdown 图片，仍由 `isAllowedReactiveUrl(url, 'image')` 复核。
//
// 【长度必须守恒】本函数**只做等长改写**（用空格填充、保留换行）。原因是它跑在
// 引用适配之前，`source-map.ts` 的区间映射依赖「原文与适配后源码等长」；一旦长度
// 变化，编辑器里的诊断会落到错的字上，而且不报错。data 图片转 Markdown 时用
// alt 文本里的空格补齐到原长度。
//
// 【零依赖之外的两个 import】`maskMarkdownCode`（零依赖）与 data-image /
// url-policy（都是零依赖）。不 import prisma / React / DOM，服务端、worker 与
// 浏览器预览共用同一份规则。
// ─────────────────────────────────────────────────────────────────────────────

import { SITE_REACTIVE_COMPONENT_NAMES } from './component-names';
import { maskMarkdownCode } from '../favorite-refs';
import { dataImageRef, MAX_DATA_IMAGE_CHARS, parseLegacyDataImage } from './data-image';
import { isAllowedReactiveUrl } from './url-policy';

/** 兼容规则的显式版本。**改任何规则都要递增** —— 它进快照签名。 */
export const LEGACY_COMPAT_VERSION = 'reactive-legacy-compat/1';

export interface LegacyDataImageAsset {
  url: string;
  alt: string;
  width?: string;
  height?: string;
}

export interface LegacyCompatResult {
  /** 与输入**等长**的兼容改写结果。 */
  source: string;
  changed: boolean;
  /** 每类改写的次数（只进日志 / 测试，不含正文）。 */
  counts: Record<string, number>;
  /** `[@图片/<ref>]` → 受限 data 位图。真实字节只随 hostData 交给宿主组件。 */
  dataImages: Record<string, LegacyDataImageAsset>;
}

type MutableCounts = Record<string, number>;

function count(counts: MutableCounts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

// ── 词汇表 ──────────────────────────────────────────────────────────────────

/** 上游默认模式原生支持的标签（0.7.0 文档的 P0 表）。 */
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 's', 'del', 'u', 'mark', 'sup', 'sub',
  'br', 'hr', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span',
  'details', 'summary', 'blockquote', 'code', 'pre', 'ul', 'ol', 'li',
  'a', 'img', 'table', 'caption', 'colgroup', 'col', 'thead', 'tbody',
  'tfoot', 'tr', 'th', 'td',
]);

const VOID_TAGS = new Set([
  'br', 'hr', 'img', 'col',
]);

/** 旧白名单里允许、但上游原生 HTML 不认识的属性 → 直接剥掉。 */
const GLOBAL_ATTRS = new Set(['title']);
const TAG_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'title', 'rel', 'target']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  details: new Set(['open']),
  div: new Set(['align']),
  p: new Set(['align']),
  h1: new Set(['align']),
  h2: new Set(['align']),
  h3: new Set(['align']),
  h4: new Set(['align']),
  h5: new Set(['align']),
  h6: new Set(['align']),
  // table / caption / summary 的 align 与 col / colgroup 的 span 在 0.7.0
  // 默认模式下会触发 local.html.fallback（整块退成源码），不能保留。
  th: new Set(['align', 'colspan', 'rowspan', 'scope', 'headers']),
  td: new Set(['align', 'colspan', 'rowspan', 'headers']),
  ol: new Set(['start']),
};

function allowedAttr(tag: string, attr: string): boolean {
  if (GLOBAL_ATTRS.has(attr)) return true;
  return TAG_ATTRS[tag]?.has(attr) ?? false;
}

/** 危险 / 不支持的**整块**能力：连同内容一起消失（不输出源码）。 */
const REMOVE_BLOCK_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript',
] as const;

/** 只剥标签、保留子文本的历史标签（旧 DOMPurify 的 KEEP_CONTENT 行为）。 */
const UNWRAP_TAGS = new Set([
  'font', 'center', 'big', 'small', 'tt', 'strike', 'acronym', 'abbr', 'cite', 'q',
  'section', 'article', 'aside', 'header', 'footer', 'figure', 'figcaption',
  'dl', 'dt', 'dd', 'ruby', 'rt', 'rp', 'kbd', 'samp', 'var', 'ins', 'label',
  'form', 'fieldset', 'legend', 'textarea', 'select', 'option', 'optgroup',
  'html', 'head', 'body', 'title', 'main', 'nav', 'address', 'time', 'progress', 'meter',
  'button',
]);

const VOID_UNSUPPORTED = new Set(['input', 'meta', 'link', 'base', 'track', 'source', 'wbr', 'param']);

/** 历史 HTML 里可能出现的冷门标签：旧净化器会解包，这里照做。 */
const LEGACY_UNKNOWN_TAGS = new Set([
  'marquee', 'blink', 'nobr', 'frame', 'frameset', 'applet', 'basefont',
  'bgsound', 'plaintext', 'xmp', 'listing', 'dir', 'menu', 'big', 'tt',
]);

/**
 * ReactiveMD 的组件标签（来自上游公开目录，**不在这里另抄一份**）。
 *
 * 兼容层只处理**历史 HTML**；作者写的 `<counter bind="n">`、`<panel>` 等必须
 * 原样留给编译器 —— 把未知标签一律解包会把「新写的无效结构」静默变成能发布的
 * 普通正文，也会把合法组件拆掉。
 */
const COMPONENT_TAGS = new Set<string>([...SITE_REACTIVE_COMPONENT_NAMES, 'site-embed']);

/** 与原生 HTML 同名、需要靠属性区分「组件还是旧标签」的标签。 */
const HTML_COLLISION_TAGS = new Set([
  'input', 'textarea', 'select', 'table', 'section', 'progress', 'option',
]);

/** 组件属性（`bind` / `bind-start` / `label` / `key`）—— 出现即按组件处理。 */
const COMPONENT_ATTR = /\b(?:bind(?:-[a-z]+)?|label|key)\s*=/i;

// ── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 等长中和。
 *
 * ⚠️ **不能用空格**：被剥掉的标签通常位于行首，连续 4 个空格会让 Markdown 把
 * 紧跟其后的正文当成**缩进代码块** —— 表现是「正文整段变成原样文字」，不报错。
 * 零宽空格（U+200B）在渲染上不可见、也不构成缩进，正好用来保留偏移。
 *
 * 属性内部仍然用空格（它们本来就在标签里，不会影响 Markdown 块结构）。
 */
const NEUTRAL = '​';

function neutralizeRange(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = NEUTRAL;
  }
}

/** 属性用等长空格（不会出现在 Markdown 行首）。 */
function blankRange(chars: string[], start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
  }
}

/**
 * 把想要的替换串塞进原区间：短了用空格补齐，长了返回 null（调用方改为保守处理）。
 * 绝不让函数返回与区间不等长的结果 —— 那会破坏 source-map。
 */
function fitReplacement(length: number, desired: string): string | null {
  if (desired.length > length) return null;
  return desired + ' '.repeat(length - desired.length);
}

/** 从标签原文里读一个属性值（只用于我们自己生成的转换，不用于安全判定）。 */
function readAttr(tag: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = re.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** 取第一个 `<source src=…>`。 */
function readSourceChild(inner: string): string | null {
  const re = /<source\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  const match = re.exec(inner);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** 把标签里的某个属性整体抹成空格（保留标签本身）。 */
function blankAttr(
  chars: string[],
  tagStart: number,
  raw: string,
  name: string,
  counts: MutableCounts
): void {
  const re = new RegExp(`(\\s)${name}(\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, 'i');
  const match = re.exec(raw);
  if (!match) return;
  const at = tagStart + (match.index ?? 0);
  blankRange(chars, at, at + match[0].length);
  count(counts, 'dropped-attribute');
}

function safeAltText(raw: string | null): string {
  const text = (raw ?? '').replace(/[\[\]\r\n]/g, ' ').trim();
  if (!text) return '图片';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** 找到标签结尾（尊重引号；返回 `>` 之后的下标）。 */
function findTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index + 1;
    // data 位图的 img 标签可以到 512k；普通标签也按同一上限截断，
    // 避免把整篇当成一个标签，同时保证大图不会漏过兼容处理。
    if (index - start > MAX_DATA_IMAGE_CHARS + 8192) return -1;
  }
  return -1;
}

// ── 保护区域（代码 / 数学 / pre / code 内部）─────────────────────────────────

/** 把一段文本（保留换行）盖成 x。 */
function maskChars(text: string): string {
  return text.replace(/[^\r\n]/g, 'x');
}

/**
 * 缩进代码块保护。
 *
 * `maskMarkdownCode` 只盖围栏与行内代码，**不盖 4 空格缩进代码**；旧正文里把
 * HTML 当示例缩进粘贴很常见，不保护就会把示例里的 `<script>` 删掉、`<font>` 改写。
 * 规则：上一行是空行、且本行以 4 个空格或 Tab 开头 → 代码块开始，直到遇到非空
 * 且不再缩进的行。
 */
function maskIndentedCode(source: string): string {
  const lines = source.split('\n');
  let inCode = false;
  let previousBlank = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    const indented = /^(?: {4}|\t)/.test(body);
    if (inCode) {
      if (indented || body.trim() === '') {
        lines[index] = maskChars(line);
      } else {
        inCode = false;
      }
    }
    if (!inCode && previousBlank && indented && body.trim() !== '') {
      inCode = true;
      lines[index] = maskChars(line);
    }
    previousBlank = body.trim() === '';
  }
  return lines.join('\n');
}

export function maskProtectedContent(source: string): string {
  let out = maskIndentedCode(maskMarkdownCode(source));
  const mask = (pattern: RegExp): void => {
    out = out.replace(pattern, (match) => maskChars(match));
  };
  // 数学区域：与 markdown-math.ts 的四组定界符同口径。
  mask(/\$\$[\s\S]*?\$\$/g);
  mask(/\\\[[\s\S]*?\\\]/g);
  mask(/\$[^$\n]+?\$/g);
  mask(/\\\([\s\S]*?\\\)/g);
  // 转义美元（`\$5`）不是数学定界符。
  mask(/\\\$/g);
  // HTML 的 <pre> / <code> 内部按字面显示：只保护内部，标签本身仍可被剥属性。
  out = out.replace(
    /(<(pre|code)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (_match, open: string, _name: string, inner: string, close: string) =>
      `${open}${'x'.repeat(inner.length)}${close}`
  );
  return out;
}

// ── 整块能力 ────────────────────────────────────────────────────────────────

/** 危险 / 不支持整块：连同内容一起抹成空格。 */
function removeBlocks(chars: string[], masked: string, counts: MutableCounts): void {
  const names = REMOVE_BLOCK_TAGS.join('|');
  const paired = new RegExp(`<(${names})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
  for (const match of masked.matchAll(paired)) {
    if (masked[(match.index ?? 0)] !== '<') continue;
    neutralizeRange(chars, match.index ?? 0, (match.index ?? 0) + match[0].length);
    count(counts, 'removed-block');
  }
  // 自闭合 / 空元素写法。
  const selfClosing = new RegExp(`<(${names})\\b[^>]*?\\/\\s*>`, 'gi');
  for (const match of masked.matchAll(selfClosing)) {
    if (masked[(match.index ?? 0)] !== '<') continue;
    neutralizeRange(chars, match.index ?? 0, (match.index ?? 0) + match[0].length);
    count(counts, 'removed-block');
  }
  // 未闭合的 script / style：旧浏览器会一直吃到 EOF；这里也清到结尾。
  //
  // ⚠️ 必须在**上面的改写之后**重新取掩码：否则已配对删除的 `<style>…</style>`
  // 仍会出现在旧掩码里，这个「到 EOF」的正则会把后面所有正文一起清掉。
  const afterPaired = maskProtectedContent(chars.join(''));
  const unclosed = /<(script|style)\b[^>]*>[\s\S]*$/gi;
  for (const match of afterPaired.matchAll(unclosed)) {
    if (afterPaired[(match.index ?? 0)] !== '<') continue;
    neutralizeRange(chars, match.index ?? 0, (match.index ?? 0) + match[0].length);
    count(counts, 'removed-unclosed');
  }
}

/**
 * 旧 HTML 音视频 → 受控形态：
 *   · `/api/audio/<10位>/raw` → `[@音频/<id>]`（同一份受控 raw 路由）；
 *   · 其它可安全链接 → `[视频](url)` / `[音频](url)`；
 *   · 不可用的地址 → 只留「视频 / 音频」四个字。
 * 整块替换，长度补齐。
 */
function convertMediaBlocks(chars: string[], masked: string, counts: MutableCounts): void {
  const block = /<(video|audio)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of masked.matchAll(block)) {
    const start = match.index ?? 0;
    if (chars[start] !== '<') continue;
    const tag = match[1].toLowerCase();
    // ⚠️ 属性必须从**原文**取：`masked` 会把 `$…$` / 链接目标盖成 x，
    // 用它生成 URL 会把 `https://e.com/a$b$c.mp4` 悄悄改成 `axxxxc.mp4`。
    const rawBlock = chars.slice(start, start + match[0].length).join('');
    const openEnd = rawBlock.indexOf('>');
    const openTag = openEnd === -1 ? rawBlock : rawBlock.slice(0, openEnd + 1);
    const closeStart = rawBlock.toLowerCase().lastIndexOf('</');
    const inner = openEnd === -1
      ? ''
      : rawBlock.slice(openEnd + 1, closeStart > openEnd ? closeStart : rawBlock.length);
    const url = readAttr(openTag, 'src') ?? readSourceChild(inner);
    let desired: string;
    if (tag === 'audio') {
      const controlled = url?.match(/^\/api\/audio\/([A-Za-z0-9]{10})\/raw$/);
      if (controlled) {
        desired = `[@音频/${controlled[1]}]`;
        count(counts, 'audio-ref');
      } else if (url && isAllowedReactiveUrl(url, 'link')) {
        desired = `[音频](${url})`;
        count(counts, 'audio-link');
      } else {
        desired = '音频';
        count(counts, 'audio-drop');
      }
    } else if (url && isAllowedReactiveUrl(url, 'link')) {
      desired = `[视频](${url})`;
      count(counts, 'video-link');
    } else {
      desired = '视频';
      count(counts, 'video-drop');
    }
    const replacement = fitReplacement(match[0].length, desired);
    if (replacement !== null) {
      chars.splice(start, match[0].length, ...replacement.split(''));
    } else {
      neutralizeRange(chars, start, start + match[0].length);
    }
  }
}

// ── 属性剥离 ────────────────────────────────────────────────────────────────

/**
 * 剥掉标签里不在白名单的属性。只改属性区，引号与 `>` 不动；不支持的属性用空格
 * 填掉，标签本身保留。
 */
function stripUnsupportedAttrs(
  chars: string[],
  tagStart: number,
  tagEnd: number,
  tagName: string,
  counts: MutableCounts
): void {
  let cursor = tagStart + 1;
  if (chars[cursor] === '/') cursor += 1;
  // 跳过标签名。
  while (cursor < tagEnd && /[A-Za-z0-9:-]/.test(chars[cursor])) cursor += 1;

  while (cursor < tagEnd) {
    while (cursor < tagEnd && /\s/.test(chars[cursor])) cursor += 1;
    if (cursor >= tagEnd || chars[cursor] === '>' || chars[cursor] === '/') break;
    const nameStart = cursor;
    while (cursor < tagEnd && !/[\s=/>]/.test(chars[cursor])) cursor += 1;
    const name = chars.slice(nameStart, cursor).join('').toLowerCase();
    let valueStart = cursor;
    let valueEnd = cursor;
    // `=` 与值（可有引号）。
    let probe = cursor;
    while (probe < tagEnd && /\s/.test(chars[probe])) probe += 1;
    if (chars[probe] === '=') {
      probe += 1;
      while (probe < tagEnd && /\s/.test(chars[probe])) probe += 1;
      if (chars[probe] === '"' || chars[probe] === "'") {
        const quote = chars[probe];
        valueStart = probe;
        probe += 1;
        while (probe < tagEnd && chars[probe] !== quote) probe += 1;
        valueEnd = Math.min(probe + 1, tagEnd);
        // 光标必须越过收尾引号，否则下一轮会把这个引号当成一个属性名抹掉。
        cursor = valueEnd;
      } else {
        valueStart = probe;
        while (probe < tagEnd && !/[\s>]/.test(chars[probe])) probe += 1;
        valueEnd = probe;
        cursor = probe;
      }
    }
    if (!allowedAttr(tagName, name)) {
      blankRange(chars, nameStart, valueEnd);
      count(counts, 'dropped-attribute');
    }
  }
}

// ── 未配对数学定界符 ────────────────────────────────────────────────────────

/**
 * 把**未配对**的数学定界符换成视觉相近的全角字符。
 *
 * ReactiveMD 遇到一个落单的 `$` 会把它到行尾都当成 inlineMath（`ok: true`、
 * 没有诊断），于是「公式 $x 没配对，还有后文」会静默吞掉后半句。旧管线在同样
 * 输入下显示原文，所以这里要保住「普通文章仍然可读」。
 *
 * 配对成功的公式已经在上面的 `masked` 里变成 `x`，剩下的 `$` / `\(` / `\[` 就是
 * 未配对的那一些。替换成同长度的全角字符（`＄` / `（ ` / `［ `），既不会触发数学
 * 解析，也保持 source-map 的等长前提。
 */
function normalizeUnpairedMath(chars: string[], masked: string, counts: MutableCounts): void {
  for (let index = 0; index < masked.length; index += 1) {
    // 前面阶段可能已把这个位置中和成零宽字符；别在已删除的块里重新写字。
    if (chars[index] !== '$' && chars[index] !== '\\') continue;
    if (masked[index] === '$') {
      const start = index;
      while (index < masked.length && masked[index] === '$') index += 1;
      for (let at = start; at < index; at += 1) chars[at] = '＄';
      count(counts, 'unpaired-math');
      index -= 1;
      continue;
    }
    if (
      masked[index] === '\\' &&
      index > 0 &&
      masked[index - 1] === '\\'
    ) {
      // `\\(` 是转义后的字面反斜杠 + 括号，不是数学定界符。
      index += 1;
      continue;
    }
    if (masked[index] === '\\' && (masked[index + 1] === '(' || masked[index + 1] === '[')) {
      chars[index] = '（';
      chars[index + 1] = ' ';
      count(counts, 'unpaired-math');
      index += 1;
      continue;
    }
    if (masked[index] === '\\' && (masked[index + 1] === ')' || masked[index + 1] === ']')) {
      chars[index] = '）';
      chars[index + 1] = ' ';
      count(counts, 'unpaired-math');
      index += 1;
    }
  }
}

// ── Markdown 原生 data 图片 ────────────────────────────────────────────────

/**
 * `![alt](data:image/…)` 同样不能交给上游图片闸门（它在宿主 urlPolicy 之前就按
 * http(s) 白名单拒绝）。转成 `[@图片/<ref>]` token，由适配器生成宿主组件，
 * 真实字节走 hostData；渲染前还会再验一次 MIME / 魔数。
 */
function convertMarkdownDataImages(
  chars: string[],
  masked: string,
  counts: MutableCounts,
  dataImages: Record<string, LegacyDataImageAsset>
): void {
  const source = chars.join('');
  const re = /!\[([^\]\r\n]*)\]\((data:image\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of masked.matchAll(re)) {
    const start = match.index ?? 0;
    if (chars[start] !== '!') continue;
    const url = source.slice(start + match[0].indexOf('](') + 2, start + match[0].length - 1).split(/\s+"/)[0];
    const image = parseLegacyDataImage(url);
    if (!image) {
      // 非受限 data 图：不显示、不输出巨长源码。
      const alt = safeAltText(match[1] ?? null);
      const replacement = fitReplacement(match[0].length, alt === '图片' ? '' : alt);
      if (replacement !== null) chars.splice(start, match[0].length, ...replacement.split(''));
      else neutralizeRange(chars, start, start + match[0].length);
      count(counts, 'data-image-rejected');
      continue;
    }
    const ref = dataImageRef(image.url);
    const replacement = fitReplacement(match[0].length, `[@图片/${ref}]`);
    if (replacement !== null) {
      dataImages[ref] = { url: image.url, alt: safeAltText(match[1] ?? null) };
      chars.splice(start, match[0].length, ...replacement.split(''));
      count(counts, 'data-image');
    } else {
      neutralizeRange(chars, start, start + match[0].length);
      count(counts, 'data-image-too-large');
    }
  }
}

// ── 标签主扫描 ──────────────────────────────────────────────────────────────

function transformTags(
  chars: string[],
  masked: string,
  counts: MutableCounts,
  dataImages: Record<string, LegacyDataImageAsset>
): void {
  const stack: string[] = [];
  /** 已确认是 ReactiveMD 组件的 HTML 同名标签（input / table / section …）。 */
  const componentStack: string[] = [];

  for (let index = 0; index < masked.length; index += 1) {
    if (chars[index] !== '<' || masked[index] !== '<') continue;

    // 注释 / doctype / 处理指令。
    if (masked.startsWith('<!--', index)) {
      const close = masked.indexOf('-->', index + 4);
      index = close === -1 ? masked.length : close + 2;
      continue;
    }
    if (masked.startsWith('<!', index) || masked.startsWith('<?', index)) {
      const end = findTagEnd(masked, index);
      if (end !== -1) {
        neutralizeRange(chars, index, end);
        count(counts, 'removed-declaration');
        index = end - 1;
      }
      continue;
    }

    const end = findTagEnd(masked, index);
    if (end === -1) continue;
    // 原文取属性值：masked 只用于定位，不能用来读 URL / data payload。
    const raw = chars.slice(index, end).join('');
    const nameMatch = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(raw);
    if (!nameMatch) {
      index = end - 1;
      continue;
    }
    const closing = nameMatch[1] === '/';
    const rawName = nameMatch[2];
    const name = rawName.toLowerCase();
    const length = end - index;

    // ReactiveMD 组件标签：原样留给编译器。只有与 HTML 同名的标签需要靠属性区分；
    // 旧 HTML 的那一种继续走下面的解包 / 净化，组件的那一种连属性都不能动。
    if (COMPONENT_TAGS.has(name) && !/[A-Z]/.test(rawName)) {
      if (!HTML_COLLISION_TAGS.has(name)) {
        if (!closing) componentStack.push(name);
        else {
          const at = componentStack.lastIndexOf(name);
          if (at !== -1) componentStack.length = at;
        }
        index = end - 1;
        continue;
      }
      if (closing) {
        const at = componentStack.lastIndexOf(name);
        if (at !== -1) {
          componentStack.length = at;
          index = end - 1;
          continue;
        }
        // 没有对应的组件开标签：按旧 HTML 闭标签处理（见下方 ALLOWED / UNWRAP）。
      } else if (COMPONENT_ATTR.test(raw)) {
        componentStack.push(name);
        index = end - 1;
        continue;
      }
    }

    // `</br>` → `<br/>`：长度相同（5）。
    if (closing && name === 'br' && raw === '</br>') {
      chars.splice(index, length, ...'<br/>'.split(''));
      count(counts, 'normalized-br');
      index = end - 1;
      continue;
    }

    if (!closing && name === 'img') {
      const dataUrl = readAttr(raw, 'src');
      if (dataUrl && /^data:/i.test(dataUrl)) {
        const image = parseLegacyDataImage(dataUrl);
        if (image) {
          const ref = dataImageRef(image.url);
          const token = `[@图片/${ref}]`;
          const replacement = fitReplacement(length, token);
          if (replacement !== null) {
            dataImages[ref] = {
              url: image.url,
              alt: safeAltText(readAttr(raw, 'alt')),
              ...(readAttr(raw, 'width') ? { width: readAttr(raw, 'width')! } : {}),
              ...(readAttr(raw, 'height') ? { height: readAttr(raw, 'height')! } : {}),
            };
            chars.splice(index, length, ...replacement.split(''));
            count(counts, 'data-image');
          } else {
            neutralizeRange(chars, index, end);
            count(counts, 'data-image-too-large');
          }
        } else {
          // 非受限 data 位图：不显示、也不把十几万字符源码吐到页面上。
          const alt = safeAltText(readAttr(raw, 'alt'));
          const replacement = fitReplacement(length, alt);
          if (replacement !== null) {
            chars.splice(index, length, ...replacement.split(''));
          } else {
            neutralizeRange(chars, index, end);
          }
          count(counts, 'data-image-rejected');
        }
        index = end - 1;
        continue;
      }
    }

    // URL 属性先按用途过滤：`javascript:` 之类不能留给上游去「整段回退」，
    // 更不能原样进入文档。图片 src 不可用 → 直接丢图；链接 href 不可用 → 只丢属性。
    if (!closing && name === 'a') {
      const href = readAttr(raw, 'href');
      if (href !== null && href !== '' && !isAllowedReactiveUrl(href, 'link')) {
        blankAttr(chars, index, raw, 'href', counts);
      }
    }
    if (!closing && name === 'img') {
      const src = readAttr(raw, 'src');
      if (src !== null && src !== '' && !isAllowedReactiveUrl(src, 'image')) {
        const alt = safeAltText(readAttr(raw, 'alt'));
        const replacement = fitReplacement(length, alt === '图片' ? '' : alt);
        if (replacement !== null) {
          chars.splice(index, length, ...replacement.split(''));
        } else {
          neutralizeRange(chars, index, end);
        }
        count(counts, 'dropped-image');
        index = end - 1;
        continue;
      }
    }

    if (ALLOWED_TAGS.has(name)) {
      if (closing) {
        const at = stack.lastIndexOf(name);
        if (at === -1) {
          // 多余闭标签（例如多出来的 `</details>`）：直接去掉。
          neutralizeRange(chars, index, end);
          count(counts, 'stray-closing');
        } else {
          stack.length = at;
        }
      } else {
        stripUnsupportedAttrs(chars, index, end, name, counts);
        const selfClosing = /\/\s*>$/.test(raw);
        if (!VOID_TAGS.has(name) && !selfClosing) stack.push(name);
      }
      index = end - 1;
      continue;
    }

    if (name === 'input') {
      neutralizeRange(chars, index, end);
      count(counts, 'dropped-tag');
      index = end - 1;
      continue;
    }

    // 整块能力已在前面处理；这里兜底：未配对的危险开标签也抹掉。
    if ((REMOVE_BLOCK_TAGS as readonly string[]).includes(name)) {
      neutralizeRange(chars, index, end);
      count(counts, 'removed-block');
      index = end - 1;
      continue;
    }

    if (
      VOID_UNSUPPORTED.has(name) ||
      UNWRAP_TAGS.has(name) ||
      LEGACY_UNKNOWN_TAGS.has(name) ||
      // 全大写写法（例如 `<TAB>`）：HTML 大小写不敏感，而 ReactiveMD 组件名一律
      // 小写 —— 这类标签不可能是组件，按旧 HTML 的未知标签解包。
      /[A-Z]/.test(rawName)
    ) {
      neutralizeRange(chars, index, end);
      count(counts, 'unwrapped-tag');
      index = end - 1;
      continue;
    }

    // 其它未知标签：按旧 DOMPurify 的宽容行为解包、保留子文本。
    // 已知 ReactiveMD 组件已在上面原样放行；这里剩下的不可能是增强语法。
    neutralizeRange(chars, index, end);
    count(counts, 'unwrapped-tag');
    index = end - 1;
  }
}

/**
 * 兼容改写入口。返回值与输入等长；`counts` 只用于观测。
 */
export function applyLegacyHtmlCompat(source: string): LegacyCompatResult {
  if (
    !source.includes('<') &&
    !source.includes('$') &&
    !source.includes('\\(') &&
    !source.includes('\\[') &&
    !source.includes('data:image')
  ) {
    return { source, changed: false, counts: {}, dataImages: {} };
  }
  const chars = source.split('');
  const counts: MutableCounts = {};
  const dataImages: Record<string, LegacyDataImageAsset> = {};

  // 顺序很重要：先抹掉整块危险能力，再转换音视频，最后逐标签处理。
  //
  // 【只算一次保护掩码】后续阶段只改 `chars`，但都先确认「该位置在原文里仍是那个
  // 字符」（`chars[i] === '<' / '$' / '!'`）——被前面阶段中和掉的位置不会因为旧
  // 掩码还写着 `<` 而被二次处理。这样 200k 正文不必反复重跑掩码扫描。
  const masked = maskProtectedContent(source);
  removeBlocks(chars, masked, counts);
  convertMediaBlocks(chars, masked, counts);
  // 未配对数学只扫正文：HTML 标签内部（属性值可能含 `$`）整体盖掉。
  normalizeUnpairedMath(
    chars,
    masked
      .replace(/<[^>]*>/g, maskChars)
      // 链接目标里的 `$` 是 URL 的一部分，不是公式（只在数学扫描里盖掉）。
      .replace(/\]\((?:[^()\s]|\([^)]*\))*\)/g, maskChars),
    counts
  );
  convertMarkdownDataImages(chars, masked, counts, dataImages);
  transformTags(chars, masked, counts, dataImages);

  const result = chars.join('');
  return { source: result, changed: result !== source, counts, dataImages };
}
