// ─────────────────────────────────────────────────────────────────────────────
// docs-service.ts —— 把一份登记在案的文档读出来、渲染成 HTML（服务端专用）
//
// 【谁在用】`/docs/<...>` 的正文页。索引页只读登记表，不碰磁盘。
//
// 【为什么请求时读盘，而不是构建期静态化】与那 6 个指南页同一口径：`docs/` 跟着
// git pull 走，改好文档重启即生效，不需要为了改一句话重新 build。代价是每次请求
// 读一次盘 —— 几十 KB 的文本，与既有的指南页同量级，不构成问题。
// （**但没有走 MarkdownGuide 那条路**：那条读的是 `docs/guide/` 且带着「读不到就
// 显示一句占位」的兜底。见下面 readDocSource 的注释，这里刻意不要那种兜底。）
//
// 【与前端的分工】`marked` 只在本文件里出现。**HTML 一律当作可信内容**：
// 来源是仓库里的 Markdown，不是用户输入（与 MarkdownGuide 同一条前提）——
// 所以这里不做净化，也不该被拿去渲染任何用户提交的文本。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import {
  docAnchor,
  resolveDocRef,
  rewriteDocHref,
  sectionKeyOf,
  type DocEntry,
} from './docs-catalog';

/** 文档根目录。进程 cwd 即项目根（systemd 的 WorkingDirectory / `next start` 的起点）。 */
const DOCS_DIR = ['docs'];

/** 文档在仓库里的路径（`docs/bot/chat-bot.md`）—— 页脚要拿它拼 GitHub 地址。 */
export function docRepoPath(entry: DocEntry): string {
  return [...DOCS_DIR, ...entry.slug.split('/')].join('/') + '.md';
}

function docFilePath(entry: DocEntry): string {
  return path.join(process.cwd(), ...DOCS_DIR, ...entry.slug.split('/')) + '.md';
}

/**
 * 读一份文档的 Markdown 原文。
 *
 * 【刻意不 catch】指南页那边的 `loadGuideHtml` 读不到时返回一句「暂时无法加载」，
 * 那是因为「这份文档在不在」对它是个运行时未知量。这里不是：能走到这一步说明
 * `findDocEntry` 命中了登记表，**文件不在就说明工作区与登记表不一致**（漏了 rsync、
 * 少提交一次 git pull）。那种故障要响 —— 让它抛出去变成 500 并落进 journalctl，
 * 而不是渲染一张看起来正常的页面。守卫 `tests/unit/docs-catalog.test.ts` 会在
 * 部署之前就把它拦下来。
 */
export function readDocSource(entry: DocEntry): string {
  return fs.readFileSync(docFilePath(entry), 'utf-8');
}

// ── 渲染管线 ────────────────────────────────────────────────────────────────

/** marked 的 token。只声明我们碰得到的字段 —— 树的三种挂法见 `childTokenArrays`。 */
interface Token {
  type?: string;
  text?: string;
  raw?: string;
  href?: string;
  title?: string | null;
  tokens?: Token[];
  items?: Token[];
  header?: Token[];
  rows?: Token[][];
  /** 见 `linkifyDocRefs` 里那条注释 —— 防递归用的私标记。 */
  docRefChild?: true;
}

/**
 * **标题键**的形状 —— 与 `sectionKeyOf` 从标题里抽出来的那一截**逐字一致**
 *（数字段取 `6.4`，中文段只取到顿号：`五、`）。
 *
 * ⚠️ 锚点是拿这个键拼的，所以「引用里怎么认」必须与「标题里怎么认」是同一个形状。
 * 中文段上这两者天然不同：标题 `### 五、命令清单` 的键是 `五、`，
 * 而引用 `§五、命令清单` 里那个「命令清单」是行文，**不能进锚点** ——
 * 否则 href 指向 `#sec-五、命令清单`、id 却只有 `sec-五、`，一点就落在文档顶部。
 */
const KEY = String.raw`(?:\d+(?:\.\d+)*|[一-龥]+、)`;
/** 引用里的段号：键后面可以还跟着标题文字。`(?![\w])` 挡掉 `§2b` 被读成 `§2`。 */
const SEC = String.raw`(?:` + KEY + String.raw`[一-龥A-Za-z0-9]*(?![\w]))`;
/** 一段引用：`§` + 段号 + 可选「标题」。 */
const SEG = String.raw`§[ \t]*` + SEC + String.raw`(?:[ \t]*「[^」]*」)?`;
/**
 * 串首的「空白 + 段号链」—— `` `docs/deploy.md` §6/§13 `` 里跟在路径后面的那截。
 * 链内各段只认 `/` 相连（与守卫 `docs-xref.test.ts` 的 `scanSectionChain` 同一口径，
 * 本仓实测只有这一种链式写法）。
 */
const LEADING_SECTION_RE = new RegExp(
  String.raw`^([ \t]+)(` + SEG + String.raw`(?:[ \t]*\/[ \t]*` + SEG + String.raw`)*)`
);
/** 取链里**第一个**段号的标题键 —— 链式里其余段归同一个被引文档，指首段即可。 */
const FIRST_SECTION_RE = new RegExp(String.raw`§[ \t]*(` + KEY + String.raw`)`);

/**
 * 一棵 token 树下所有「装着子 token 的数组」。
 *
 * ⚠️ marked 的树有**三种挂法**，只认 `tokens` 会**静默**漏掉后两类：
 *   · `tokens` —— 段落 / 引用块 / em,strong / 链接 / 列表项 / 标题
 *   · `items` —— 列表（元素是 list_item，各自带 `tokens`）
 *   · `header` + `rows` —— 表格（单元格是 `{text, tokens}`，**没有 `type`**，
 *     所以下面把单元格本身也当 token 往下递）
 * 漏掉哪一类，那一处的引用就点不动、也不报错 —— 实测表格与列表正是这样漏过去的。
 */
function childTokenArrays(token: Token): Token[][] {
  const out: Token[][] = [];
  if (Array.isArray(token.tokens)) out.push(token.tokens);
  if (Array.isArray(token.items)) out.push(token.items);
  if (Array.isArray(token.header)) out.push(token.header);
  if (Array.isArray(token.rows)) out.push(...token.rows);
  return out;
}

/**
 * 把正文里的反引号文档路径变成站内链接，并把紧随的 `§N` 一并吃进链接。
 *
 * 【为什么不挂 marked 的 `walkTokens` 钩子】「路径后面那截 §N」是**另一个同级
 * token**（行内 token 是扁平兄弟数组：`[text, codespan, text, …]`），而 walkTokens
 * 一次只给一个 token，看不到兄弟。所以这里自己递归。
 *
 * 【递归面见 `childTokenArrays`】漏掉哪一种挂法，那一处的引用就点不动、也不报错。
 *
 * 【代码围栏天然免疫】围栏块的 token 类型是 `code`（不是 `codespan`），块里也没有
 * 行内 token 数组 —— 示例代码里的假路径不会被链上。
 */
function linkifyDocRefs(tokens: Token[], fromSlug: string): void {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'codespan' && !token.docRefChild) {
      const target = resolveDocRef(fromSlug, token.text ?? '');
      if (target) {
        const children: Token[] = [
          // 子节点保持 codespan：渲染出 <a><code>…</code></a>，代码样式与转义都沿用 marked。
          // ⚠️ 这个标记是**防递归**：兄弟数组会被再遍历一次，而子节点又是一条
          // codespan，不打标记就会被再改写成 link 的 link……直到爆栈（实测踩到）。
          { type: 'codespan', raw: token.raw, text: token.text, docRefChild: true },
        ];

        let href = target.href;
        const next = tokens[i + 1];
        if (next?.type === 'text' && typeof next.text === 'string') {
          const m = LEADING_SECTION_RE.exec(next.text);
          const head = m?.[2] ? FIRST_SECTION_RE.exec(m[2])?.[1] : undefined;
          if (m && head) {
            // id 用原始段号（heading 那边也这么写），只有 fragment 百分号编码 ——
            // 中文段号（`五、命令`）不编码会在部分客户端上比对不上。
            href += `#${encodeURIComponent(docAnchor(head))}`;
            // m[1] 是路径与 `§` 之间那截空白，**要一起带进链接** —— 丢了会渲染成
            // `<code>x.md</code>§6.3`，紧贴着，读起来像路径的一部分。
            children.push({ type: 'text', raw: m[0], text: m[1] + m[2] });
            next.text = next.text.slice(m[0].length);
            next.raw = next.text;
          }
        }

        token.type = 'link';
        token.href = href;
        token.title = null;
        token.tokens = children;
        continue; // 子节点已就绪，不必再往下走
      }
    }

    // 作者真写的 Markdown 链接（本仓规范不鼓励，但确实有 5 条）：相对链接 → 站内页 /
    // 仓库地址。反引号那条路走上面，两边互不影响。
    if (token.type === 'link' && typeof token.href === 'string') {
      token.href = rewriteDocHref(fromSlug, token.href);
    }

    for (const kids of childTokenArrays(token)) linkifyDocRefs(kids, fromSlug);
  }
}

/** 属性值转义（段号只可能是数字 / `、` / 中文，这里是防御性的）。 */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 把一份 Markdown 渲染成正文 HTML。**两条管线共用这一个入口**
 *（`/docs/<slug>` 与 6 个 ★ 指南页）—— 两边渲染的是同一批文档，行为必须一致。
 *
 * 分三步而不是一句 `parse()`：链接改写需要**同级可见**（见 linkifyDocRefs），
 * 而 `walkTokens` 看不到兄弟，所以自己 lex → 改写 token → parse。
 */
export function renderDocMarkdown(markdown: string, fromSlug: string): string {
  const parser = new Marked({
    renderer: {
      // 给编号标题加 id，好让 `docs/x.md` §6.3 那种链接点得进去。
      // 段号认不出来（无编号的标题）就不加 —— 也没有引用会指向它。
      heading(token) {
        const key = sectionKeyOf(token.text ?? '');
        const id = key ? ` id="${escapeAttr(docAnchor(key))}"` : '';
        return `<h${token.depth}${id}>${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
    },
  });

  // 只在交给遍历器时收窄成自己的 Token：改写是**就地**的，`tokens` 里的对象
  // 仍是同一批，所以 `parser.parser` 直接吃原数组即可。
  const tokens = parser.lexer(markdown);
  linkifyDocRefs(tokens as Token[], fromSlug);
  return parser.parser(tokens);
}

/**
 * 渲染一份登记在案的文档。
 *
 * 链接改写有两种，都在这一步发生：
 *   · **真 Markdown 链接**（本仓极少，规范要求别写）→ `rewriteDocHref`
 *   · **反引号路径**（规范要求的写法）→ `linkifyDocRefs`
 */
export function renderDocHtml(entry: DocEntry): string {
  return renderDocMarkdown(readDocSource(entry), entry.slug);
}
