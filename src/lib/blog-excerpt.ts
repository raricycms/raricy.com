// ─────────────────────────────────────────────────────────────────────────────
// blog-excerpt.ts —— 把 Markdown 正文压成一段纯文本摘要（零依赖、纯函数）
//
// 【只给主页的**高**卡片用】个人主页积木墙里，尺寸 h≥2 的文章块有第二行空间，用它
// 填一段正文摘要；h=1 的矮卡片只放标题与日期，拿到的是空串（见 profile-service 的
// resolveViews）。不用于列表页、不用于 SEO 描述 —— 那些各有自己的字段（Blog.description）。
//
// 【它是现算，不是快照】摘要**不进** profile_blocks.config、不落任何表：正文改了，
// 下一次请求的摘要就跟着变；文章降档 / 被删 / 归档 → 那块 view 为 null，摘要一起消失。
// 这与「存指针不存快照」是同一条口径（见 profile-service.ts 文件头第 2 条）。把摘要
// 抄进 config 会得到「正文已经改了、名片上还是旧摘要」的洞，而且**永远不会报错**。
//
// 【它不是渲染】这里只做字符串变换：不 import rich-text / marked / prisma，也不做
// HTML 白名单。产出是**纯文本**，React 直接当子节点画，不存在「摘要里带标签」的问题。
// 反过来也刻意：正文管线里那些 `[@…]` 引用、播放器、卡片一律不展开 —— 摘要不该把
// 一篇文章的资源清单拖到主页上。
//
// 【口径】按「读者看到什么」取：
//   · 围栏代码块与行内代码：连内容一起丢掉（变量名 / 命令 / 路径塞进一句话只会把
//     句子读断，而摘要本来就没有等宽排版）；
//   · 图片：连 alt 一起丢掉（alt 多是文件名）；
//   · `<script>` / `<style>`：连内容一起丢掉，其余 HTML 标签只去标签留文字；
//   · `[@8位]` / `[@音频/ID]` / `[@用户/名字]` 这类引用 token：整个 token 丢掉；
//   · 链接保留**文字**（`[阅读全文](/blog/x)` → `阅读全文`），URL 不进摘要；
//   · 去掉 `# > - * _ ~ \`` 等标记，空白折叠成单个空格，结果恒为一行。
//
// 【截断】超过 max 个 UTF-16 码元就切到 max，再补一个 `…`（所以结果最多 max+1 个码元）。
// 切点落在代理对中间时整个字符让出去 —— 半个 emoji 会变成 U+FFFD，比少一个字符难看。
// ─────────────────────────────────────────────────────────────────────────────

/** 摘要默认长度（UTF-16 码元）。主页高卡片一行放得下的量级，也是本模块的调用口径。 */
export const DEFAULT_EXCERPT_MAX = 280;

/** 围栏代码块的开/闭标记：行首最多 3 个空格，然后 3 个以上反引号或波浪线。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** 行内链接 / 图片的括号部分；允许一跳嵌套括号（URL 里带 `(...)` 的百科条目）。 */
const LINK_TARGET = String.raw`\((?:[^()\n]|\([^()\n]*\))*\)`;

/**
 * 丢掉围栏代码块：逐行扫描，开围栏到**闭围栏**（同字符、长度不少于开围栏）之间的
 * 行整段丢弃。未闭合的围栏一直丢到文末 —— 摘要宁可少一段，也不要把半段代码漏出来。
 */
function stripFencedCode(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      // 闭围栏：同一字符、长度不少于开围栏（CommonMark 允许闭围栏后面带空白）
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 把 Markdown 正文压成一行纯文本摘要。零依赖、无副作用，服务端读路径每次现算。
 *
 * @param markdown 原始 Markdown（不可信输入：正文由作者写、也可能含 HTML）
 * @param max      保留的最大 UTF-16 码元数；超过时切到 max 再补 `…`
 */
export function blogExcerpt(markdown: string, max = DEFAULT_EXCERPT_MAX): string {
  if (typeof markdown !== 'string' || !markdown) return '';
  if (!(max > 0)) return '';

  let out = markdown.replace(/\r\n?/g, '\n');

  // 引用（blockquote）标记先剥：`> ```js` 这种围栏也要能被下一步认出来。
  out = out.replace(/^ {0,3}(?:>[ \t]?)+/gm, '');

  out = stripFencedCode(out);

  // 链接定义行（`[ref]: https://…`）整行删；留着它会把 URL 当正文漏出来。
  out = out.replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, '');

  // script / style 连内容一起删；HTML 注释整段删；其余标签只去标签。
  out = out.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // 自动链接 `<https://…>` / `<mailto:…>`：链接地址本身就是文字，先摘出来再当标签删。
  out = out.replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, '$1');
  // 块级标签换成空格（`<p>a</p><p>b</p>` 不能粘成 `ab`），行内标签直接去掉
  // （`<strong>粗</strong>体` 粘成 `粗体` 才是对的）。
  out = out.replace(
    /<\/?(?:p|div|br|hr|li|ul|ol|h[1-6]|blockquote|pre|table|thead|tbody|tr|td|th|section|article|header|footer|figure|figcaption|details|summary)\b[^<>]*>/gi,
    ' '
  );
  out = out.replace(/<\/?[a-zA-Z][^<>]*>/g, '');

  // 图片：连 alt 一起删（含 `![alt][ref]` 引用式）。
  out = out.replace(new RegExp(String.raw`!\[[^\]\n]*\]` + LINK_TARGET, 'g'), '');
  out = out.replace(/!\[[^\]\n]*\]\[[^\]\n]*\]/g, '');

  // 行内代码：连内容一起删（理由见文件头）。先处理成对的反引号串，落单的反引号
  // 留到后面的标记清理。
  out = out.replace(/(`+)([^`\n]*?)\1/g, '');

  // 链接：保留文字。先转 `[文字](url)`，再转 `[文字][ref]` / `[文字][]`。
  out = out.replace(new RegExp(String.raw`\[([^\[\]\n]*)\]` + LINK_TARGET, 'g'), '$1');
  out = out.replace(/\[([^\[\]\n]*)\]\[[^\[\]\n]*\]/g, '$1');

  // 引用 token：`[@8位]` / `[@音频/ID]` / `[@用户/名字]`。链接已经转过，剩下的
  // `[@…]` 一定是 token（正文里语法就这么写），整块丢掉。
  out = out.replace(/\[@[^\]\n]*\]/g, '');

  // ── 行级标记 ──
  out = out.replace(/^ {0,3}#{1,6}[ \t]+/gm, ''); // ATX 标题
  out = out.replace(/^ {0,3}#{1,6}[ \t]*$/gm, ''); // 只有 # 的空标题行
  out = out.replace(/^ {0,3}(?:={2,}|-{2,})[ \t]*$/gm, ''); // setext 下划线
  out = out.replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, ''); // 分隔线
  out = out.replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, ''); // 列表 marker
  out = out.replace(/^ {0,3}\[[ xX]\][ \t]+/gm, ''); // 任务清单勾选框
  out = out.replace(/^[ \t|:-]*-[ \t|:-]*$/gm, ''); // 表格分隔行 |---|:---:|

  // 反斜杠转义：`\*` 还原成 `*`，随后与真标记一起清掉。
  out = out.replace(/\\([\\`*_{}\[\]()#+\-.!>|~])/g, '$1');

  // 表格竖线当空格，其余标记直接去掉（去掉而不是换空格：中文正文里 `**粗**体`
  // 换空格会多出一个突兀的缝）。
  out = out.replace(/\|/g, ' ');
  out = out.replace(/[*_~`]/g, '');
  out = out.replace(/[\[\]]/g, '');
  out = out.replace(/#/g, '');
  out = out.replace(/>/g, ' ');

  // 空白折叠成单空格 —— 摘要恒为一行，换行交给卡片的排版决定。
  out = out.replace(/[\s\u00a0]+/g, ' ').trim();
  if (!out) return '';

  if (out.length <= max) return out;

  // 截断：切点若落在高代理项之后，就把整个代理对让出去（别产出半个 emoji）。
  let cut = max;
  const code = out.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return out.slice(0, cut) + '…';
}
