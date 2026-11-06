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
// 引用适配之前，引用 token 的偏移与诊断 range 都依赖「原文与适配后源码等长」；一旦
// 长度变化，定位会落到错的字上，而且不报错。data 图片转 Markdown 时用
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
import type {
  SiteMediaPayload,
  SiteMediaPreload,
  SiteMediaSources,
  SiteMediaSourceItem,
  SiteMediaTrackItem,
} from './ref-types';

/**
 * 兼容规则的显式版本。**改任何规则都要递增** —— 它进快照签名。
 * /2：修复 section/progress/table 组件误拆、线性扫描、align 取值、引用块缩进代码。
 * /3：历史 HTML 音视频转为 `[[媒体:<10hex>]]` + mediaSources（controls / source /
 *     track，preload 默认 none，无 autoplay）。
 * /4：媒体块替换时连**块内换行**一起中和，避免 token 后的软换行变成多余 `<br>`
 *     （播放器下方约 170px 空洞）。输出 AST 变了，旧快照必须 stale。
 * /5：保留 radio-group 的 option 子组件，避免合法 RMD 示例被误拆并阻塞迁移。
 * /6：插值 `{{ … }}` 内部按表达式整体保护。表达式里的 `<` 是比较运算符，不是
 *     标签开头；不保护会把它当标签扫到后面某个 `>`，连带吞掉中间组件开标签，
 *     组件栈错位后把本该闭合容器的 `</panel>` 中和掉（上游报「缺少 </panel>」）。
 */
export const LEGACY_COMPAT_VERSION = 'reactive-legacy-compat/6';

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
  /** `[[媒体/<10hex>]]` → 历史 HTML 音视频的受限播放数据（纯 JSON）。 */
  mediaSources: SiteMediaSources;
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
export const HTML_COLLISION_TAGS: ReadonlySet<string> = new Set([
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
 * 用一段文本替换 `[start, start+length)`。
 *
 * ⚠️ **不要用 `chars.splice(start, length, ...text.split(''))`**：data 位图的标签
 * 最大可到 `MAX_DATA_IMAGE_CHARS`，补位后的替换串同量级；把几十万个字符展开成
 * 函数参数会直接抛 `Maximum call stack size exceeded`，整批语料扫描因此没有报告。
 * 等长（本模块的常态）时逐字符写回；长度不同时用数组重建，不用 spread。
 *
 * 【必须按 UTF-16 code unit 而不是 code point 重建】`chars` 是 `source.split('')`
 * 的结果，下标就是 JS 字符串下标（引用 token 偏移与诊断 range 都用它）。`Array.from`
 * 会把 emoji 收成一个元素，长度差分支一旦碰到代理对，后续所有偏移都会错一位。
 */
function replaceRange(chars: string[], start: number, length: number, text: string): void {
  if (text.length === length) {
    for (let index = 0; index < text.length; index += 1) chars[start + index] = text[index];
    return;
  }
  const next = chars.slice(0, start);
  for (let index = 0; index < text.length; index += 1) next.push(text[index]);
  for (let index = start + length; index < chars.length; index += 1) next.push(chars[index]);
  chars.length = 0;
  for (const char of next) chars.push(char);
}

/**
 * 写入可见前缀，剩余区间用等长中和（零宽 + 保留换行）。
 *
 * ⚠️ **数据图不能走 `fitReplacement` 的空格补齐**：一张 400k 的 `data:` 图被
 * 替换成 `[@图片/…]` 或 alt 后，剩下几十万个空格会拼成一段巨型空白；上游在
 * 这一段上会卡死（实测 400k 空格 > 120s，整批扫描只能超时）。零宽不参与
 * Markdown 的空白/缩进语义，长度不变，偏移仍然对齐。
 */
function writeVisiblePrefix(
  chars: string[],
  start: number,
  length: number,
  text: string
): boolean {
  if (text.length > length) return false;
  for (let index = 0; index < text.length; index += 1) chars[start + index] = text[index];
  neutralizeRange(chars, start + text.length, start + length);
  return true;
}

/**
 * 音视频整块替换专用：剩余区间连**换行**也一起中和。
 *
 * 媒体块是多行标签（`<video>` + `<source>` + `<track>` + `</video>`）；若保留块内
 * 换行，Markdown 软换行会把每个换行渲染成 `<br>` —— 播放器与下一段正文之间凭空
 * 多出约 170px。整块在语义上是一个内联 token，所以内部换行也不该留下版面。
 * 剩余空间用**空格**而不是零宽：零宽会让上游多解析出一个只有不可见文字的段落，
 * 仍然带段落上下边距；空格是行尾空白，不会生成空段落。
 * 块**之后**的换行不在区间里，段落间距保持原样；长度仍严格不变。
 * 超大区块不走空格补齐（见 `MAX_MEDIA_BLOCK_CHARS`），避免重现长空白卡编译。
 */
function writeMediaReplacement(
  chars: string[],
  start: number,
  length: number,
  text: string
): boolean {
  if (text.length > length) return false;
  for (let index = 0; index < text.length; index += 1) chars[start + index] = text[index];
  for (let index = text.length; index < length; index += 1) chars[start + index] = ' ';
  return true;
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
  }
  // 一直扫到 EOF 都没有 `>`。**不要再按字符逐个重试**：调用方在拿到 -1 时
  // 可以直接结束本阶段 —— 从这个 `<` 到文末都没有闭合符，后面的 `<` 更不会有。
  // 原先的「扫到 512k 上限就返回 -1、调用方下标只 +1」是 O(n²)：
  // 25 万个未闭合 `<` 会扫 3×10^10 次比较，单进程整站排队。
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
/**
 * 去掉引用块前缀（`>` / `> ` / 多层 `> >`），返回块内容。
 *
 * CommonMark 的缩进代码也可以在引用块里：`>     <font>示例</font>` 的原始行
 * 以 `>` 开头，只看行首 4 空格会漏掉它，示例里的标签会被兼容层改写。
 */
function blockquoteContent(line: string): string {
  let index = 0;
  let depth = 0;
  while (depth < 16) {
    let probe = index;
    while (probe < line.length && (line[probe] === ' ' || line[probe] === '\t')) probe += 1;
    if (line[probe] !== '>') break;
    probe += 1;
    if (line[probe] === ' ') probe += 1;
    index = probe;
    depth += 1;
  }
  return index === 0 ? line : line.slice(index);
}

function maskIndentedCode(source: string): string {
  const lines = source.split('\n');
  let inCode = false;
  let previousBlank = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    const content = blockquoteContent(body);
    const indented = /^(?: {4}|\t)/.test(content);
    const blank = content.trim() === '';
    if (inCode) {
      if (indented || blank) {
        lines[index] = maskChars(line);
      } else {
        inCode = false;
      }
    }
    if (!inCode && previousBlank && indented && content.trim() !== '') {
      inCode = true;
      lines[index] = maskChars(line);
    }
    previousBlank = blank;
  }
  return lines.join('\n');
}

/** 插值内部只盖这四个字符：`<` `>` 是标签边界，`$` `\` 是公式定界符的原料。 */
const INTERPOLATION_PROTECTED_CHARS = new Set(['<', '>', '$', '\\']);

/**
 * 插值 `{{ … }}` 内部整体保护。
 *
 * 表达式里的 `<` / `>` 是比较运算符，不是标签边界；字符串里也可能出现这两个
 * 字符。不盖掉这段，`{{ probe > 0 ? 1 : probe < 0 ? -1 : 0 }}` 里裸的 `<` 会被
 * 当成标签开头，一路扫到后面某个 `>`（往往正好是下一个组件的开标签 `>`），
 * `index = end - 1` 就把中间的组件开标签整段跳过：组件栈里少了这个容器，
 * 后面它真正的 `</panel>` 便成了「无主闭标签」，被中和成零宽字符交给上游，
 * 上游于是报 `<panel> is missing </panel>` —— 编辑区里明明写着闭合标签。
 *
 * 与上游插值扫描同口径：`"` / `'` 字符串内的 `}}` 不算结束，`\` 转义下一个字符；
 * 未闭合的 `{{` 把表达式内容一直保护到文末（上游会给出自己的插值诊断，这里只
 * 保证不串到标签扫描）。只改扫描副本，`chars` 与原文保持等长。
 *
 * 只盖会被标签 / 数学扫描误读的四个字符：`<` `>` 是标签边界，`$` `\` 是公式
 * 定界符的原料。`{{` / `}}` 与其余字符保留 —— 格式检测要靠 `{{` 定位「未闭合
 * 插值」诊断，语法预算也要数它（`detect-format.ts`、`syntax-budget.ts`）。
 */
function maskInterpolations(source: string): string {
  const chars = source.split('');
  let cursor = 0;
  for (;;) {
    const start = source.indexOf('{{', cursor);
    if (start < 0) break;
    let quote: string | null = null;
    let end = -1;
    for (let index = start + 2; index + 1 < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '}' && source[index + 1] === '}') {
        end = index;
        break;
      }
    }
    const stop = end < 0 ? source.length : end;
    for (let index = start + 2; index < stop; index += 1) {
      if (INTERPOLATION_PROTECTED_CHARS.has(source[index])) chars[index] = 'x';
    }
    if (end < 0) break;
    cursor = end + 2;
  }
  return chars.join('');
}

/** 转义美元（`\$5`）不是数学定界符：先盖掉，别让单 `$` 配对把它当起点。 */
function maskEscapedDollars(source: string): string {
  const chars = source.split('');
  for (let index = 0; index + 1 < source.length; index += 1) {
    if (source[index] === '\\' && source[index + 1] === '$') {
      chars[index] = 'x';
      chars[index + 1] = 'x';
      index += 1;
    }
  }
  return chars.join('');
}

/**
 * 顺序配对定界符并盖成 x（等长）。
 *
 * ⚠️ 不能再用 `open[\s\S]*?close` 的全局正则：未闭合 / 大量起点时，正则会对
 * 每一个起点都扫到文末（O(n²)）。这里用 `indexOf` 只向前推进；一对盖完就跳到
 * 闭符之后，整体线性。找不到闭符直接结束本组。
 */
function maskDelimitedPairs(
  source: string,
  open: string,
  close: string,
  sameLine = false,
  minContent = 0
): string {
  const chars = source.split('');
  let cursor = 0;
  for (;;) {
    const start = source.indexOf(open, cursor);
    if (start < 0) break;
    const searchFrom = start + open.length;
    const end = source.indexOf(close, searchFrom);
    if (end < 0) break;
    if (end - searchFrom < minContent) {
      // `$$` 的两个 `$` 相邻：不是空内容的行内公式，别把它们配成一对。
      cursor = searchFrom;
      continue;
    }
    if (sameLine) {
      const newline = source.indexOf('\n', searchFrom);
      if (newline >= 0 && newline < end) {
        // 行内公式不跨行：这个起点作废，从下一格继续找（仍线性）。
        cursor = searchFrom;
        continue;
      }
    }
    for (let index = start; index < end + close.length; index += 1) {
      if (source[index] !== '\n' && source[index] !== '\r') chars[index] = 'x';
    }
    cursor = end + close.length;
  }
  return chars.join('');
}

/**
 * HTML 的 `<pre>` / `<code>` 内部按字面显示：只保护内部，标签本身仍可被剥属性。
 * 顺序配对而不是回溯正则 —— 大量未闭合 `<pre` 同样不能退化。
 */
/**
 * 只把 ASCII 大写转小写，**保持长度**。
 *
 * `String.prototype.toLowerCase()` 对 `İ`（U+0130）等字符会变长（1 → 2 个
 * UTF-16 码元）；用它算出的下标再去索引原文会整体错位，后续 `<script>` /
 * `<video>` / `<pre>` 的定位全偏一格。标签名本身只有 ASCII，所以这里只做
 * ASCII 归一，长度与原文严格一致。
 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function maskHtmlCodeElements(source: string): string {
  const chars = source.split('');
  const lower = asciiLower(source);
  for (const name of ['pre', 'code'] as const) {
    let cursor = 0;
    for (;;) {
      const open = lower.indexOf(`<${name}`, cursor);
      if (open < 0) break;
      const boundary = lower[open + 1 + name.length];
      if (boundary && /[a-z0-9:-]/.test(boundary)) {
        cursor = open + 1;
        continue;
      }
      const openEnd = findTagEnd(source, open);
      if (openEnd < 0) break;
      const close = lower.indexOf(`</${name}`, openEnd);
      if (close < 0) break;
      const closeEnd = findTagEnd(source, close);
      if (closeEnd < 0) break;
      for (let index = openEnd; index < close; index += 1) {
        if (source[index] !== '\n' && source[index] !== '\r') chars[index] = 'x';
      }
      cursor = closeEnd;
    }
  }
  return chars.join('');
}

export function maskProtectedContent(source: string): string {
  let out = maskIndentedCode(maskMarkdownCode(source));
  // 插值先于数学：表达式里的 `$` 不是公式定界符，盖掉后才不会被单 `$` 配对
  // 误当成公式起点，把后面一整段正文一起保护掉。
  out = maskInterpolations(out);
  out = maskEscapedDollars(out);
  // 数学区域：与 markdown-math.ts 的四组定界符同口径。顺序配对，线性。
  out = maskDelimitedPairs(out, '$$', '$$');
  out = maskDelimitedPairs(out, '\\[', '\\]');
  out = maskDelimitedPairs(out, '$', '$', true, 1);
  out = maskDelimitedPairs(out, '\\(', '\\)');
  out = maskHtmlCodeElements(out);
  return out;
}

// ── 整块能力 ────────────────────────────────────────────────────────────────

/**
 * 危险 / 不支持整块：连同内容一起删除。
 *
 * 用「开标签 → 向后找第一个闭标签」的顺序扫描，而不是 `<tag>[\s\S]*?</tag>`
 * 全局正则：后者在大量未闭合开标签时会对每个起点扫到文末（O(n²)）。
 * `chars[open] !== '<'` 兼作「已被前一轮删除」的跳过判断，所以不需要重新取掩码。
 */
function removeBlocks(chars: string[], masked: string, counts: MutableCounts): void {
  const lower = asciiLower(masked);
  for (const name of REMOVE_BLOCK_TAGS) {
    let cursor = 0;
    for (;;) {
      const open = lower.indexOf(`<${name}`, cursor);
      if (open < 0) break;
      const boundary = lower[open + 1 + name.length];
      if (boundary && /[a-z0-9:-]/.test(boundary)) {
        cursor = open + 1;
        continue;
      }
      const openEnd = findTagEnd(masked, open);
      if (openEnd < 0) break;
      if (chars[open] !== '<') {
        cursor = openEnd;
        continue;
      }
      // 自闭合 / 空元素写法。
      if (/\/\s*>$/.test(masked.slice(open, openEnd))) {
        neutralizeRange(chars, open, openEnd);
        count(counts, 'removed-block');
        cursor = openEnd;
        continue;
      }
      const close = lower.indexOf(`</${name}`, openEnd);
      if (close < 0) {
        // 未闭合的 script / style：旧浏览器会一直吃到 EOF；这里也清到结尾。
        // 其它标签留给后面的标签扫描。
        if (name === 'script' || name === 'style') {
          neutralizeRange(chars, open, masked.length);
          count(counts, 'removed-unclosed');
        }
        break;
      }
      const closeEnd = findTagEnd(masked, close);
      if (closeEnd < 0) break;
      neutralizeRange(chars, open, closeEnd);
      count(counts, 'removed-block');
      cursor = closeEnd;
    }
  }
}

/**
 * 旧 HTML 音视频 → 受控形态：
 *   · `/api/audio/<10位>/raw` → `[@音频/<id>]`（同一份受控 raw 路由）；
 *   · 其它可安全链接 → `[视频](url)` / `[音频](url)`；
 *   · 不可用的地址 → 只留「视频 / 音频」四个字。
 * 整块替换，长度补齐。
 */
/** 媒体整块替换的上限：更长的块不铺空格（长空白会拖慢上游编译），走字面/链接回退。 */
const MAX_MEDIA_BLOCK_CHARS = 4_096;

const MEDIA_PRELOAD: ReadonlySet<string> = new Set(['none', 'metadata', 'auto']);
const MEDIA_TRACK_KIND: ReadonlySet<NonNullable<SiteMediaTrackItem['kind']>> = new Set([
  'subtitles',
  'captions',
  'descriptions',
  'chapters',
  'metadata',
]);
const SAFE_MIME = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/;

/** 标签里是否出现过某属性（布尔属性 `loop` / `muted` / `default` 等）。 */
function hasAttr(tag: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|=|/|>)`, 'i').test(tag);
}

function safeMediaType(value: string | null): string | undefined {
  if (!value || value.length > 100 || !SAFE_MIME.test(value)) return undefined;
  return value;
}

/** 解析一个 `<video>` / `<audio>` 区块；没有任何可用 src 时返回 null。 */
function readMediaPayload(
  media: 'video' | 'audio',
  openTag: string,
  inner: string
): SiteMediaPayload | null {
  const direct = readAttr(openTag, 'src');
  const src = direct && isAllowedReactiveUrl(direct, 'link') ? direct : undefined;

  const sources: SiteMediaSourceItem[] = [];
  for (const match of inner.matchAll(/<source\b[^>]*>/gi)) {
    const source = readAttr(match[0], 'src');
    if (!source || !isAllowedReactiveUrl(source, 'link')) continue;
    const item: SiteMediaSourceItem = { src: source };
    const type = safeMediaType(readAttr(match[0], 'type'));
    if (type) item.type = type;
    sources.push(item);
  }

  const tracks: SiteMediaTrackItem[] = [];
  if (media === 'video') {
    for (const match of inner.matchAll(/<track\b[^>]*>/gi)) {
      const source = readAttr(match[0], 'src');
      if (!source || !isAllowedReactiveUrl(source, 'link')) continue;
      const item: SiteMediaTrackItem = { src: source };
      const kind = readAttr(match[0], 'kind')?.toLowerCase();
      if (kind && MEDIA_TRACK_KIND.has(kind as NonNullable<SiteMediaTrackItem['kind']>)) {
        item.kind = kind as NonNullable<SiteMediaTrackItem['kind']>;
      }
      const srclang = readAttr(match[0], 'srclang');
      if (srclang && /^[A-Za-z0-9-]{1,16}$/.test(srclang)) item.srclang = srclang;
      const label = readAttr(match[0], 'label')?.replace(/[\u0000-\u001f]/g, '').slice(0, 200);
      if (label) item.label = label;
      if (hasAttr(match[0], 'default')) item.default = true;
      tracks.push(item);
    }
  }

  if (!src && sources.length === 0) return null;

  const payload: SiteMediaPayload = { media };
  if (src) payload.src = src;
  if (sources.length > 0) payload.sources = sources;
  if (tracks.length > 0) payload.tracks = tracks;

  const poster = readAttr(openTag, 'poster');
  if (media === 'video' && poster && isAllowedReactiveUrl(poster, 'image')) {
    payload.poster = poster;
  }
  const preload = readAttr(openTag, 'preload')?.toLowerCase();
  if (preload && MEDIA_PRELOAD.has(preload)) payload.preload = preload as SiteMediaPreload;

  if (hasAttr(openTag, 'loop')) payload.loop = true;
  if (hasAttr(openTag, 'muted')) payload.muted = true;
  if (hasAttr(openTag, 'playsinline')) payload.playsInline = true;
  const crossorigin = readAttr(openTag, 'crossorigin')?.toLowerCase();
  if (crossorigin === 'anonymous' || crossorigin === 'use-credentials') {
    payload.crossorigin = crossorigin;
  }
  if (media === 'video') {
    for (const [key, name] of [
      ['width', 'width'],
      ['height', 'height'],
    ] as const) {
      const raw = readAttr(openTag, name);
      if (raw && /^\d{1,5}$/.test(raw) && Number(raw) > 0) payload[key] = Number(raw);
    }
  }
  return payload;
}

/**
 * 旧 HTML 音视频 → 受限媒体 host（保留可播放 controls）：
 *   · 站内受控音频 → 现有 `[@音频/<id>]`（raw 路由判权）；
 *   · 其余有安全 src / `<source>` 的区块 → `[[媒体:<10 hex>]]` + mediaSources
 *     （适配器展开成 `site-embed kind="media"`，阅读 / 导出共用同一渲染器）；
 *   · 装不下 token / 没有可用地址 → 保持既有链接 / 文本回退。
 *
 * 产品口径：controls 恒开、preload 默认 none、**永不带 autoplay**；
 * source / track 结构保留；URL 已在这一层过策略，渲染器还会再验一次。
 */
function convertMediaBlocks(
  chars: string[],
  masked: string,
  counts: MutableCounts,
  mediaSources: Record<string, SiteMediaPayload>
): void {
  const lower = asciiLower(masked);
  for (const tag of ['video', 'audio'] as const) {
    let cursor = 0;
    for (;;) {
      const start = lower.indexOf(`<${tag}`, cursor);
      if (start < 0) break;
      const boundary = lower[start + 1 + tag.length];
      if (boundary && /[a-z0-9:-]/.test(boundary)) {
        cursor = start + 1;
        continue;
      }
      const openEnd = findTagEnd(masked, start);
      if (openEnd < 0) break;
      if (chars[start] !== '<') {
        cursor = openEnd;
        continue;
      }
      const close = lower.indexOf(`</${tag}`, openEnd);
      // 后面已经没有闭标签：再往后找也是同一个结果，直接结束（不要逐个重扫）。
      if (close < 0) break;
      const closeEnd = findTagEnd(masked, close);
      if (closeEnd < 0) break;
      // ⚠️ 属性必须从**原文**取：`masked` 会把 `$…$` / 链接目标盖成 x，
      // 用它生成 URL 会把 `https://e.com/a$b$c.mp4` 悄悄改成 `axxxxc.mp4`。
      const rawBlock = chars.slice(start, closeEnd).join('');
      const openTag = rawBlock.slice(0, openEnd - start);
      const inner = rawBlock.slice(openEnd - start, close - start);
      const url = readAttr(openTag, 'src') ?? readSourceChild(inner);
      const blockLength = closeEnd - start;
      const padded = blockLength <= MAX_MEDIA_BLOCK_CHARS;

      // 站内受控音频仍走现有 `[@音频/<id>]`（音频 kind），不改 media。
      if (tag === 'audio') {
        const controlled = url?.match(/^\/api\/audio\/([A-Za-z0-9]{10})\/raw$/);
        if (controlled) {
          const token = `[@音频/${controlled[1]}]`;
          if (padded && writeMediaReplacement(chars, start, blockLength, token)) {
            count(counts, 'audio-ref');
            cursor = closeEnd;
            continue;
          }
        }
      }

      const payload = readMediaPayload(tag, openTag, inner);
      if (payload) {
        const base = JSON.stringify(payload);
        let ref = '';
        // 同一文档内唯一：用当前条目数做盐，撞键再递增；同 payload 也不复用 token。
        for (let salt = Object.keys(mediaSources).length; salt < 10_000; salt += 1) {
          const candidate = dataImageRef(`${base}#${salt}`).slice(0, 10);
          if (!mediaSources[candidate]) {
            ref = candidate;
            break;
          }
        }
        if (ref) {
          const token = `[[媒体:${ref}]]`;
          if (padded && writeMediaReplacement(chars, start, blockLength, token)) {
            mediaSources[ref] = payload;
            count(counts, 'media');
            cursor = closeEnd;
            continue;
          }
        }
      }

      // 回退：保留原来的链接 / 文本行为（token 装不下或没有安全地址）。
      let desired: string;
      if (tag === 'audio') {
        if (url && isAllowedReactiveUrl(url, 'link')) {
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
      if (!padded || !writeMediaReplacement(chars, start, blockLength, desired)) {
        if (!writeVisiblePrefix(chars, start, blockLength, desired)) {
          neutralizeRange(chars, start, closeEnd);
        }
      }
      cursor = closeEnd;
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
    } else if (name === 'align') {
      // 上游只接受 left / center / right / justify；`align="middle"` 这类历史
      // 值会让整块 HTML 退化成源码文本。取值不在白名单就整条属性抹掉。
      const rawValue = chars
        .slice(valueStart, valueEnd)
        .join('')
        .replace(/^["']|["']$/g, '')
        .trim()
        .toLowerCase();
      if (!['left', 'center', 'right', 'justify'].includes(rawValue)) {
        blankRange(chars, nameStart, valueEnd);
        count(counts, 'dropped-attribute');
      }
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
 * 解析，也保持等长前提。
 */
function normalizeUnpairedMath(chars: string[], masked: string, counts: MutableCounts): void {
  for (let index = 0; index < masked.length; index += 1) {
    // 前面阶段可能已把这个位置中和成零宽字符；别在已删除的块里重新写字。
    if (chars[index] !== '$' && chars[index] !== '\\') continue;
    if (masked[index] === '$') {
      const start = index;
      while (index < masked.length && masked[index] === '$') index += 1;
      // 单个 `$` 上游本来就按字面文本处理（`价格 $5` → 文本 `价格 $5`）。
      // 只有成串的 `$$` 才是未闭合的**显示数学**起始符，会让整篇
      // `local.math.unclosed`；只中和这一种，别把普通价格改成全角。
      if (index - start >= 2) {
        for (let at = start; at < index; at += 1) chars[at] = '＄';
        count(counts, 'unpaired-math');
      }
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
      // 未闭合的 `\(` / `\[` 会让整篇编译失败。去掉反斜杠、把定界符留成
      // 普通字符（等长：第二个字符换成零宽，不改变偏移），可见文字仍是
      // `(` / `[`。真正的闭合符 `\)` / `\]` 上游本来就按普通文本处理，
      // 不必改（改了会把 `结尾 \)` 的可见文字从 `)` 变成 `）`）。
      chars[index] = masked[index + 1];
      chars[index + 1] = NEUTRAL;
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
      if (!writeVisiblePrefix(chars, start, match[0].length, alt === '图片' ? '' : alt)) {
        neutralizeRange(chars, start, start + match[0].length);
      }
      count(counts, 'data-image-rejected');
      continue;
    }
    const ref = dataImageRef(image.url);
    if (writeVisiblePrefix(chars, start, match[0].length, `[@图片/${ref}]`)) {
      dataImages[ref] = { url: image.url, alt: safeAltText(match[1] ?? null) };
      count(counts, 'data-image');
    } else {
      neutralizeRange(chars, start, start + match[0].length);
      count(counts, 'data-image-too-large');
    }
  }
}

// ── 标签主扫描 ──────────────────────────────────────────────────────────────

/**
 * 这些上游组件容器把 `<option>` 当**结构化子组件**（模板本身自带）。
 * 旧 HTML 的 `<option>` 只可能出现在 `<select>` 里；因此只有祖先命中这一组时，
 * 才把没有 bind/label 的 `<option>` 保留为组件子结构。上游目录模板不一定包含
 * radio-group 这样的兼容别名，所以还需单独覆盖这些别名。
 */
const OPTION_CONTAINER_COMPONENTS = new Set(['multi-select', 'choices', 'radio-group', 'quiz', 'select']);

/**
 * 名字本身就是普通英文 / 键名的子组件：光秃秃出现（无属性、无对应父容器）时
 * 按历史文字处理，而不是按组件。
 *
 * `Press <tab>.`、SVG 教程里的 `<text>`、示意图里的 `<node>` 都是普通 Markdown；
 * 把它们当组件会编译失败、再把整篇误判成 invalid-enhanced。真正写在父容器里的
 * `<tabs><tab …></tab></tabs>` 仍按组件保留。
 */
const BARE_AMBIGUOUS_COMPONENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  tab: new Set(['tabs']),
  step: new Set(['steps']),
  node: new Set(['diagram']),
  edge: new Set(['diagram']),
  // `<text>` / `<column>` 没有稳定的父容器语义：光秃秃时一律按文字。
  text: new Set(),
  column: new Set(),
};

/** 标签名之后是否真的有属性（`>` / `/` / 空白不算）。 */
function rawTagHasAttributes(raw: string): boolean {
  const match = /^<\s*\/?\s*[A-Za-z][A-Za-z0-9:-]*/.exec(raw);
  if (!match) return false;
  return /[^\s>/]/.test(raw.slice(match[0].length));
}

/**
 * 裸 `<table>` 后紧跟的是 Markdown 表格（首行以 `|` 开头）。
 *
 * 上游 `table` 组件的 props 全部可选，所以 `<table>` + Markdown 表格 `| … |`
 * 是合法组件；而历史 HTML 表格的 body 是 `<tr>/<td>`。只看开标签不带属性会把
 * 前者误拆成原生表格。看一个**有界窗口**即可（不递归扫描整篇）。
 */
function looksLikeMarkdownTableAfter(chars: readonly string[], tagEnd: number): boolean {
  const limit = Math.min(chars.length, tagEnd + 512);
  let index = tagEnd;
  while (index < limit && /\s/.test(chars[index])) index += 1;
  return chars[index] === '|';
}

/**
 * 与原生 HTML 同名、但属性本身就能证明是上游组件的标签。
 *
 * `section` 的 `color`、`table` 的分页 / 排序参数都没有 `bind/label/key`；
 * 只按 `COMPONENT_ATTR` 判会把它们当历史 HTML 解包（合法组件永久丢失，
 * 还会让 invalid-enhanced 文本在首次编译就“成功”从而绕过写入闸门）。
 */
const COMPONENT_PARAM_ATTRS: Readonly<Record<string, RegExp>> = {
  section: /\bcolor\s*=/i,
  table: /\b(?:page-size|searchable|sortable)\b/i,
  progress: /\bvalue\s*=/i,
};

/** 属性值里出现 `{{ … }}` 时，这个同名标签只可能是上游组件。 */
const COMPONENT_INTERPOLATION_ATTR = /\{\{[\s\S]*?\}\}/;

export function looksLikeComponentTag(
  name: string,
  raw: string,
  componentStack: readonly string[]
): boolean {
  if (name === 'option') {
    // `<option>` 只看祖先：它没有自己的 bind，旧 HTML 的
    // `<select><option label="A">` 也带 `label`，按属性判会把历史正文
    // 留成孤立的组件标签（随后编译失败）。多选 / choices / quiz 的模板子项
    // 一定有对应组件容器祖先。
    return componentStack.some((tag) => OPTION_CONTAINER_COMPONENTS.has(tag));
  }
  if (COMPONENT_ATTR.test(raw)) return true;
  if (COMPONENT_INTERPOLATION_ATTR.test(raw)) return true;
  const extra = COMPONENT_PARAM_ATTRS[name];
  return extra ? extra.test(raw) : false;
}

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
      if (end === -1) break; // 到 EOF 都没有 `>`：后面也不可能有完整标签。
      neutralizeRange(chars, index, end);
      count(counts, 'removed-declaration');
      index = end - 1;
      continue;
    }

    const end = findTagEnd(masked, index);
    // 从当前位置到文末没有 `>`：后面的 `<` 都不会构成标签。直接结束标签扫描
    // （线性上界；原先是 index+1 继续试，未闭合输入会退化成 O(n²)）。
    if (end === -1) break;
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
        if (!closing) {
          const parents = BARE_AMBIGUOUS_COMPONENTS[name];
          const bareAndUnparented =
            parents !== undefined &&
            !rawTagHasAttributes(raw) &&
            !componentStack.some((tag) => parents.has(tag));
          if (!bareAndUnparented) {
            componentStack.push(name);
            index = end - 1;
            continue;
          }
          // 落到下面的历史 HTML 分支：这是 `Press <tab>.` 之类的普通文字。
        } else {
          const at = componentStack.lastIndexOf(name);
          if (at !== -1) {
            componentStack.length = at;
            index = end - 1;
            continue;
          }
          // 没有对应的组件开标签：按历史 HTML 闭标签处理。
        }
      } else {
        if (closing) {
          const at = componentStack.lastIndexOf(name);
          if (at !== -1) {
            componentStack.length = at;
            index = end - 1;
            continue;
          }
          // 没有对应的组件开标签：按旧 HTML 闭标签处理（见下方 ALLOWED / UNWRAP）。
        } else if (
          looksLikeComponentTag(name, raw, componentStack) ||
          // 裸 `<table>` + Markdown 表格 body 也是合法组件（props 全可选）；
          // 历史 HTML 表格的 body 是 `<tr>`，不会以 `|` 开头。
          (name === 'table' &&
            !rawTagHasAttributes(raw) &&
            looksLikeMarkdownTableAfter(chars, end))
        ) {
          componentStack.push(name);
          index = end - 1;
          continue;
        }
      }
    }

    // `</br>` → `<br/>`：长度相同（5）。
    if (closing && name === 'br' && raw === '</br>') {
      replaceRange(chars, index, length, '<br/>');
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
          if (writeVisiblePrefix(chars, index, length, token)) {
            dataImages[ref] = {
              url: image.url,
              alt: safeAltText(readAttr(raw, 'alt')),
              ...(readAttr(raw, 'width') ? { width: readAttr(raw, 'width')! } : {}),
              ...(readAttr(raw, 'height') ? { height: readAttr(raw, 'height')! } : {}),
            };
            count(counts, 'data-image');
          } else {
            neutralizeRange(chars, index, end);
            count(counts, 'data-image-too-large');
          }
        } else {
          // 非受限 data 位图：不显示、也不把十几万字符源码吐到页面上。
          const alt = safeAltText(readAttr(raw, 'alt'));
          if (!writeVisiblePrefix(chars, index, length, alt)) {
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
        if (!writeVisiblePrefix(chars, index, length, alt === '图片' ? '' : alt)) {
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
    return { source, changed: false, counts: {}, dataImages: {}, mediaSources: {} };
  }
  const chars = source.split('');
  const counts: MutableCounts = {};
  const dataImages: Record<string, LegacyDataImageAsset> = {};
  const mediaSources: Record<string, SiteMediaPayload> = {};

  // 顺序很重要：先抹掉整块危险能力，再转换音视频，最后逐标签处理。
  //
  // 【只算一次保护掩码】后续阶段只改 `chars`，但都先确认「该位置在原文里仍是那个
  // 字符」（`chars[i] === '<' / '$' / '!'`）——被前面阶段中和掉的位置不会因为旧
  // 掩码还写着 `<` 而被二次处理。这样 200k 正文不必反复重跑掩码扫描。
  const masked = maskProtectedContent(source);
  removeBlocks(chars, masked, counts);
  convertMediaBlocks(chars, masked, counts, mediaSources);
  // 未配对数学只扫正文：HTML 标签内部（属性值可能含 `$`）整体盖掉。
  normalizeUnpairedMath(
    chars,
    masked
      .replace(/<[^>]*>/g, maskChars)
      // 先盖图片 alt：![价格 $5](url) 的 `$5` 是可见文字，不是公式。
      // **只盖方括号里面**：保留 `](` 结构，后面的链接目标规则才能继续盖
      // `![图](https://e.com/$path)` 的 URL。整段 `![…]` 一起盖会让 `]` 消失，
      // 带 `$` 的链接目标就会被漏掉。
      .replace(/!\[([^\]\n]*)\]/g, (match, alt: string) => `![${maskChars(alt)}]`)
      // 链接目标里的 `$` 是 URL 的一部分，不是公式（只在数学扫描里盖掉）。
      .replace(/\]\((?:[^()\s]|\([^)]*\))*\)/g, maskChars)
      // reference definition：[ref]: https://…/$path
      .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*/gm, maskChars)
      // 正文裸 URL / 自动链接
      .replace(/\b(?:https?|ftp):\/\/[^\s<>()]+/gi, maskChars),
    counts
  );
  convertMarkdownDataImages(chars, masked, counts, dataImages);
  transformTags(chars, masked, counts, dataImages);

  const result = chars.join('');
  return { source: result, changed: result !== source, counts, dataImages, mediaSources };
}
