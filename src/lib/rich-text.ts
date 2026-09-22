// ─────────────────────────────────────────────────────────────────────────────
// rich-text.ts — 用户输入正文 → 安全 HTML 的**共享管线**（marked → DOMPurify → 后处理）
//
// 【为什么单独成模块】讨论正文与评论正文是同一类东西：**用户输入**，且渲染进所有
// 登录用户都能看到的公共区域 —— 一处 XSS 等于全站会话沦陷（偷 cookie / 冒名发消息
// / CSRF 写操作）。两者的威胁模型与防线**逐条相同**，差别只在白名单与链接类名。
//
// 各写一份的代价不是重复代码，是**防线漂移**：任一边漏打一个补丁（比如下面
// walkTokens 堵的那个 marked 裸文本通道 —— 那是实测过的假密码框钓鱼向量），
// 另一边不会知道，而两边看起来都「有净化」。
//
// 所以本文件是唯一管线，白名单 / 类名 / 缓存上限由调用方注入：
//   · src/lib/chat-markdown.ts    → 讨论气泡（linkClass: chat-msg__link）
//   · src/lib/comment-markdown.ts → 评论正文（linkClass: comment-link）
//
// ⚠️ 改本文件 = 改安全边界。单测在 tests/unit/chat-markdown.test.ts（五道防线逐条
//    覆盖），comment-markdown 另有一份对等用例 —— 两者都要跟着跑。
//
// 【威胁模型：五道防线】
//   1. 原始 HTML —— marked 默认把 <script> / <img onerror> **原样透传**（实测 v18）。
//      override renderer.html 后，用户自带标签一律转义成可见文本：既挡住注入，也让
//      用户看得见「你写的标签被当成文本了」，不静默吞内容。
//      ⚠️ 光有 renderer.html 不够：marked 的 inRawBlock 状态会让「它认不出、浏览器
//      认得」的畸形标签走裸文本通道直出（实测 `<input type="password"y>`），
//      故另有 walkTokens 补丁 —— 见下方 marked.use 里的注释。
//   2. 伪协议 —— `[x](javascript:alert(1))` / data: / vbscript: 靠 DOMPurify 的
//      ALLOWED_URI_REGEXP 拦截：只放行 http(s) / mailto / 站内相对路径，其余摘除 href。
//   3. 属性注入 —— ALLOWED_ATTR 白名单里没有 class / style / on*；链接类名一律由
//      **净化之后**的后处理代码添加（固定字符串），用户无从伪造 `.chat-msg__blog`
//      之类 UI 类名去冒充博客卡片。
//   4. 外链图片 —— <img> 不在白名单，`![](url)` 降级成链接：发图走图床**附件**
//      （imageId），不允许正文里嵌任意外链图片（第三方跟踪像素 / 访客 IP 泄露 /
//      混合内容告警）。评论与讨论共用这条口径。
//      ⚠️ **唯一的例外是 `[@<10位图床ID>]`** —— 它不是「放开了这个白名单」，
//      而是全程绕开白名单：`[@id]` 本身就是纯文本，marked 原样留着，等 DOMPurify
//      净化完之后，再由 embedImageRefs 用 createElement 把它换成
//      <img src="/api/images/<id>/raw">。因此用户手写的 <img> 与 `![](外链)` 的
//      待遇**一点没变**；能出现的图片只有我们自己构造的站内图床 URL 这一种形态
//      （id 还先过严格形态）。细节见 src/lib/content-refs.ts 的文件头。
//   5. 服务端无 DOM —— DOMPurify 在没有 window 时 sanitize 会**原样返回输入**
//      （purify.js: `if (!DOMPurify.isSupported) return dirty`），这是个静默的
//      安全洞。故此处显式拦：净化不可用 → 只输出转义纯文本，绝不透传 HTML。
//
// 【为什么关掉 marked 的 GFM 自动链接】它的 `_backpedal` 只认 ASCII 标点，中文写作
// 里「见 https://a.com/x。后面」会把「。后面」整段吞进 href（实测）。这里关掉它，
// 改在净化后的 DOM 上跑 linkify —— 那份实现专门处理中文句读 / 成对括号，且有单测
// （tests/unit/linkify.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { linkify } from './linkify';
import { embedAudioRefs } from './audio-refs';
import { embedImageRefs } from './content-refs';
import { embedStickerRefs } from './sticker-refs';
import { USER_REF_PROBE, embedUserRefs, type UserCardData } from './user-refs';

/**
 * 只放行 http(s) / mailto / 站内相对路径。
 * DOMPurify 在测试前会把值里的控制字符与首尾空白清掉（`java\nscript:` 这类绕不过去）。
 */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

export interface RichTextOptions {
  /**
   * DOMPurify 标签白名单。刻意**不含** img / iframe / svg / style / form（见防线 4）。
   * 由调用方给全 —— 少了标签用户就少一种排版，多了标签就是开安全口子。
   */
  allowedTags: string[];
  /**
   * DOMPurify 属性白名单。刻意**不含** class / style / id / 任何 on*：
   *   · class —— 类名是本站 UI 的「身份」，允许用户自带就能伪造博客卡片、系统提示行；
   *   · style —— CSS 注入（position:fixed 盖住整页、url() 外链探测）。
   */
  allowedAttr: string[];
  /** 净化后给所有 <a> 加的类名（固定字符串，用户无从伪造）。 */
  linkClass: string;
  /** 渲染结果缓存上限（以正文为键的 FIFO）。 */
  cacheMax: number;
}

/**
 * 渲染正文时**随正文一起**交进来的外挂数据。
 *
 * 【为什么要有这个东西】管线是「字符串进、字符串出」的纯函数，而用户名片 `[@用户/张三]`
 * 需要一次异步查询才能拿到头像框与 id（见 src/app/components/useUserCards.ts）。
 * 异步留在 React 层（理由与剪贴板那条一致，见 useResolvedContent.ts 的文件头），
 * 取到之后由调用方把它递到这里。
 */
export interface RichTextContext {
  /**
   * 用户名 → 名片数据。缺省 / 查无此人 = token 原样显示字面量（与剪贴板的
   * 「加载中显示字面量」同口径，见 user-refs.ts）。
   */
  userCards?: Map<string, UserCardData>;
}

export interface RichTextRenderer {
  /**
   * 正文 → 安全 HTML。无 DOM（SSR）/ 净化不可用时退回转义纯文本。
   * `ctx` 只影响名片那一趟，缺省即「没有名片数据」。
   */
  render(content: string, ctx?: RichTextContext): string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * marked 实例：只做结构，不做信任。
 *   · html      → 转义成文本（防线 1）；
 *   · image     → 降级成链接（防线 4）；
 *   · url       → 返回 undefined 关闭 GFM 自动链接（裸 URL 交给 linkify）；
 *   · walkTokens → 堵住 marked 的「裸文本通道」（见下）。
 */
function createMarked(): Marked {
  const marked = new Marked({ gfm: true, breaks: true });
  marked.use({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      image({ href, text }) {
        const label = (text ?? '').trim() || href;
        return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
      },
    },
    tokenizer: {
      url() {
        return undefined;
      },
    },
    walkTokens(token) {
      // ★ 防线 1 的漏洞补丁 ★
      // marked 的 lexer 有个 inRawBlock 状态：一旦见过 <pre / <code / <kbd / <script 这类
      // 开始标签，后续文本 token 就带 escaped=true，而默认 renderer 对 escaped 文本
      // **原样输出**（不转义）。于是「marked 的 tag 正则认不出、浏览器却认」的畸形标签
      // 能绕过 renderer.html 直出为真元素 —— 实测 `<input type="password"y>`（属性之间
      // 缺空格）会在每个浏览者的讨论里渲染出一个真实密码框（钓鱼）。
      // 这里在渲染前把 escaped 文本转义掉，并保留 escaped=true 让默认 renderer 直接输出。
      if (token.type === 'text' && token.escaped) {
        token.text = escapeHtml(token.text);
      }
    },
  });
  return marked;
}

/**
 * 把文本节点里的裸 URL 变成链接（跳过 <a> / <code> / <pre> 内部）。
 * 输入是**已净化**的 DOM，新建的 <a> 只带 linkify 产出的 http(s) 地址（见 linkify.ts）。
 */
function linkifyTextNodes(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);

  for (const text of texts) {
    const parts = linkify(text.data);
    if (parts.length === 1 && parts[0].type === 'text') continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.type === 'text') {
        frag.appendChild(document.createTextNode(part.text));
      } else {
        const a = document.createElement('a');
        a.setAttribute('href', part.href);
        a.textContent = part.text;
        frag.appendChild(a);
      }
    }
    text.replaceWith(frag);
  }
}

/**
 * 只保留 marked 任务列表生成的「禁用复选框」形态的 input。
 *
 * 为什么净化之后还要再管一遍：`input` 在白名单里只为 GFM 任务列表服务，而它恰好是
 * 最有钓鱼价值的标签（假密码框）。上游 marked 的裸文本通道已被 walkTokens 堵住，
 * 但白名单本身不该给这类标签留后门 —— 万一 marked 升级/改动又漏出裸 HTML，
 * 这里兜底：任何非「disabled checkbox」的 input 直接摘除。
 */
function restrictInputs(root: HTMLElement): void {
  root.querySelectorAll('input').forEach((el) => {
    if (el.getAttribute('type') !== 'checkbox' || !el.hasAttribute('disabled')) el.remove();
  });
}

/**
 * 链接加固：加统一样式类、外链补 rel/target、非 http(s)/mailto 的 href 一律摘除。
 * DOMPurify 已经过滤过一遍协议，这里是第二道 —— 纵深防御，不依赖单一组件的行为。
 */
function hardenLinks(root: HTMLElement, linkClass: string): void {
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    let url: URL;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      a.removeAttribute('href');
      return;
    }
    const proto = url.protocol.toLowerCase();
    const isHttp = proto === 'http:' || proto === 'https:';
    if (!isHttp && proto !== 'mailto:') {
      a.removeAttribute('href');
      return;
    }
    a.classList.add(linkClass);
    // 站内链接保持本页跳转；跨站一律新标签页 + noopener（防 window.opener 反向控制）
    if (isHttp && url.origin !== window.location.origin) {
      a.setAttribute('rel', 'noopener noreferrer nofollow');
      a.setAttribute('target', '_blank');
    }
  });
}

/**
 * 建一个渲染器。每个渲染器持有**自己的** marked 实例与缓存 —— 白名单不同就不能
 * 共用缓存，否则会把讨论口径的 HTML 喂给评论（反之亦然）。
 */
export function createRichTextRenderer(options: RichTextOptions): RichTextRenderer {
  const { allowedTags, allowedAttr, linkClass, cacheMax } = options;
  const marked = createMarked();
  const cache = new Map<string, string>();

  /** 纯函数：内容 → 安全 HTML。仅在 DOM 与净化器都可用时调用。 */
  function render(content: string, ctx?: RichTextContext): string {
    const parsed = marked.parse(content, { async: false }) as string;
    const clean = DOMPurify.sanitize(parsed, {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: allowedAttr,
      ALLOWED_URI_REGEXP,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });
    // clean 已由 DOMPurify 净化：这里再解析一次只是为了补类名 / 内联图片 / linkify / 链接加固
    const holder = document.createElement('div');
    holder.innerHTML = clean;
    restrictInputs(holder);
    // ★ 内联图床图（`[@<10位ID>]`）—— 必须是净化之后，见 content-refs.ts 的说明
    embedImageRefs(holder);
    // ★ 内联用户名片（`[@用户/<用户名>]`）★
    // 同样必须在净化之后（评论/讨论的白名单里没有 img、没有 class，拼 HTML 字符串
    // 会被剥成白板），同样用 createElement 建节点，见 user-refs.ts 的文件头。
    // ctx 里没有数据时它整趟不跑 —— 那正是「数据还没取到」，token 留在原处当字面量。
    embedUserRefs(holder, ctx?.userCards);
    // ★ 内联音频（`[@音频/<10位ID>]`）★
    // 同样必须在净化之后：评论 / 讨论的白名单里**没有 audio**（与没有 img 同理），
    // 走白名单这条路等于给任意外链播放器开口子 —— 只能由我们 createElement 建出来。
    // 它与表情那条正则互不重叠（sticker-refs 的 RESERVED_CARD_COLLECTION 让开了
    // `音频/`），所以与 embedStickerRefs 的先后无所谓；放在这组 embed* 里是因为
    // 音频也认 id、不需要等任何异步数据（URL 是 id 的纯函数）。
    embedAudioRefs(holder);
    // ★ 内联表情（`[@合集/表情]`）★
    //
    // ① 同样必须在净化之后（理由同上）。
    // ② 必须在 linkifyTextNodes 之前：linkify 只走文本节点，此刻表情已经是 <img>，
    //    碰不到它。反过来虽然 STICKER 的字符集也排除了 `.` / `:` 不会出事，但那是
    //    「靠字符集侥幸」，不是顺序保证。
    // ③ **必须再走一遍树**：embedImageRefs 会把一个文本节点切成「文本 + img + 文本」，
    //    表情这一遍得重新遍历才看得见新切出来的文本节点。两个函数各建自己的
    //    TreeWalker，天然满足。
    embedStickerRefs(holder);
    linkifyTextNodes(holder);
    hardenLinks(holder, linkClass);
    return holder.innerHTML;
  }

  return {
    render(content: string, ctx?: RichTextContext): string {
      if (!content) return '';

      // 防线 5：净化不可用（SSR / 无 DOM）时绝不能透传 HTML
      if (typeof window === 'undefined' || !DOMPurify.isSupported) {
        return escapeHtml(content).replace(/\n/g, '<br>');
      }

      // ★ 带名片 token 的正文不进缓存 ★
      //
      // 缓存以**正文**为键，而名片数据里有会变的字段（头像框：换框 / 到期 / 卸下）。
      // 同一条正文在数据到达前后会得到两份**不同**的 HTML：先字面量、后卡片。缓存会把
      // 第二份吃掉，表现成「名片永远不出现」—— 不报错、不写日志，只有那一个人看得见
      // 自己发的名片是死的。所以含名片 token 的正文一律直算。
      //
      // 代价可以忽略：这层缓存的价值在于「同一段文字出现在很多条消息里」（『哈哈哈』
      // 满屏），而带名片的正文各不相同、且在一次挂载里本来也只渲染一次（调用方的
      // useMemo 钉着）。别把它改成「按 ctx 的样子做键」—— 那就得让缓存认识名片数据的
      // 内容，等于把「什么算变了」这条判断搬到安全管线的核心文件里。
      const cacheable = !USER_REF_PROBE.test(content);

      if (cacheable) {
        const cached = cache.get(content);
        if (cached !== undefined) return cached;
      }

      const html = render(content, ctx);
      if (cacheable) {
        if (cache.size >= cacheMax) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(content, html);
      }
      return html;
    },
  };
}
