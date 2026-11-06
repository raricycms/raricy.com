// ─────────────────────────────────────────────────────────────────────────────
// content-refs.ts — `[@<内容ID>]` 引用语法的**纯逻辑**（识别 / 替换 / 截断）
//
// 【与 reactive 正文的关系】博客 / 云剪贴板正文由 reactive 渲染链适配
// （src/lib/reactive/ref-adapter.ts）—— 旧 Markdown 异步预处理器已随 legacy 渲染面
// 整体退役。本文件同时服务两条仍在用的管线：
//   · 评论 / 讨论（src/lib/rich-text.ts）：跑在**净化后的 DOM** 上，只认 8 位剪贴板
//     与 10 位图床（见下）；9 位投票刻意不认，原样保留字面量。
//   · reactive 引用适配：数字 id 按长度分流 + 音频 token，展开成宿主组件。
//
//   8 位  → 云剪贴板，正文内联；**一条消息最多展开 1 条**（见 MAX_CLIPBOARD_REFS）
//   10 位 → 图床图片，内联成 <img>；**不请求 API**，只拼 /api/images/<id>/raw
//   9 位  → 投票，评论 / 讨论里**刻意不认**，原样保留字面量（2026-09 定的口径：
//           投票箱是交互组件，塞进讨论气泡 / 楼中楼里没有意义）；reactive 正文里走
//           宿主组件，由适配器单独处理。
//
// ⚠️ 这里导出的正则**比博客那条 `\[@\s*(\w+)\s*\]` 严**（`\w` 含下划线，
// `[@__________]` 也凑得出 10 个字符）。理由：id 会被拼进 `/api/images/<id>/raw`
// 并写成 DOM 属性，形态收紧到「只可能是图床 id」就注入不进任何东西。
// 不匹配的一律保留字面量（fail-closed）。
//
// 【一批**跨管线**的东西，别在别处再写一份】id 长度词汇（上面三个常量）、
// `MAX_BLOG_REF_ITEMS`（**只管客户端主循环那 50 处显示**：剪贴板 / 投票 / 图床
// 共用一份替换额度）、「取数取多少 / 并发多少 / 展开多大」这三个预算
// （`MAX_REF_FETCHES` / `MAX_REF_CONCURRENCY` /
// `MAX_REF_EXPAND_CHARS`），以及那个并发闸门（`createConcurrencyLimiter`）。
// **收藏夹与音频各有自己的显示上限**（不在 `MAX_BLOG_REF_ITEMS` 之列，见各自的
// `MAX_FAVORITE_REFS` / `MAX_AUDIO_REFS`）。本文件零依赖，客户端渲染器与服务端
// 解析都 import 得起。
//
// 本文件零依赖、不碰 DOM 也不碰 React，故可直接单测
// （tests/unit/content-refs.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/** 云剪贴板 ID 长度（`generateShortId(8)`，见 src/lib/short-id.ts）。 */
export const CLIPBOARD_ID_LEN = 8;
/** 投票 ID 长度 —— 认出来只是为了**跳过**它。 */
export const VOTE_ID_LEN = 9;
/** 图床 ID 长度（`generateImageId(10)`，见 src/lib/image-upload.ts）。 */
export const IMAGE_ID_LEN = 10;

/** 字母数字本体（不含下划线 / 空白 / 引号 / 斜杠），两种 id 共用。 */
const ALNUM = '[A-Za-z0-9]';

// ── 插入用的 token 构造 ─────────────────────────────────────────────────────
// 【为什么构造和识别住在一起】资源面板（编辑器的「插入引用」）要拼这两种 token。
// 拼写散在组件里的话，改长度（或哪天改成分隔符）时正则跟着改、拼字符串的地方
// 忘掉，得到的是**一插进去就不展开的引用**：页面上只是一段方括号原文，
// 没有任何报错，看着像「这条资源坏了」。
//
// 【只有一个函数，因为这两种引用的形状本来就一样】`[@<id>]` 按 **id 长度**分流：
// 8 位是剪贴板、9 位是投票、10 位是图床（见上面的常量与文件头）。所以调用方传
// **正确长度的 id** 就是全部契约 —— 传错了不会报错，只会渲染成另一种东西，
// 或者谁都不认、原样留下方括号。

/** `[@<id>]` 引用 token（插入用）。id 长度决定它是哪一种资源。 */
export function contentRefToken(id: string): string {
  return `[@${id}]`;
}

/**
 * 在**已净化的文本节点**里找图床引用（全局版，一次替换全部）。
 *
 * 匹配 `[@AbCdEf1234]`，也容忍 `[@ AbCdEf1234 ]` 这样的内部空白（与博客同口径）。
 */
export const IMAGE_REF_RE = new RegExp(`\\[@\\s*(${ALNUM}{${IMAGE_ID_LEN}})\\s*\\]`, 'g');

/** 同上，非全局 —— 只问「这个文本节点里有没有」，避免 `lastIndex` 残留。 */
export const IMAGE_REF_PROBE = new RegExp(`\\[@\\s*(${ALNUM}{${IMAGE_ID_LEN}})\\s*\\]`);

/** 找云剪贴板引用（非全局版，只取第一条）。 */
export const CLIPBOARD_REF_PROBE = new RegExp(
  `\\[@\\s*(${ALNUM}{${CLIPBOARD_ID_LEN}})\\s*\\]`
);

/**
 * 客户端主循环里最多替换几处 `[@…]` 引用（**按引用条数**，不是按种类）。
 *
 * 【只管显示，不管取数】这是**显示档**：reactive 适配器（`ref-adapter.ts` 的替换
 * 主循环）用它封顶替换次数，剪贴板 / 投票 / 图床**共用**这一份额度。**取数预算
 * 另行计算**（见 `MAX_REF_FETCHES`）；**收藏夹与音频也各有自己的显示上限**，
 * 不占这 50 处（各跑一趟，见 `MAX_FAVORITE_REFS` / `MAX_AUDIO_REFS`）。
 */
export const MAX_BLOG_REF_ITEMS = 50;

/**
 * 一轮预处理里最多解析几个**需要取数**的引用（剪贴板 / 投票 / 收藏夹）。
 *
 * 【和 `MAX_BLOG_REF_ITEMS` 是两件事，别合并】**那个**管「最多替换几处」，这个管
 * 「最多发几次取数」。两者都按原文出现顺序数，但数的是不同的东西：
 *
 *   · 图床只拼 URL、不取数，所以**不占**这份预算 —— 否则一篇图多的文章会把
 *     剪贴板 / 投票的取数名额饿死（「图多的页面点不动引用」）。
 *   · 取到了却因为替换上限 / 展开预算而没处放的候选**仍然占过**这份名额：候选只按
 *     出现顺序挑，与「最终放不放得下」无关。
 *   · **缓存命中同样占名额**：候选是从正文文本选出来的，与缓存状态无关 —— 这样同一篇
 *     正文每轮挑中的都是同一批，结果确定。
 *
 * 超出这份预算的引用**既不发请求、也不替换**，原样留在正文里（静默保留字面量）。
 * 阅读与编辑器预览两条路径共用这个数，两边必须一致。
 */
export const MAX_REF_FETCHES = 50;

/**
 * 同一个取数层实例的**真实异步读取**并发上限。
 *
 * 【为什么要有】一次渲染把整篇的引用一股脑交给取数层（`Promise.all`）—— 没有这个闸，
 * 一篇塞满引用的正文会同时打出几十条请求，连上站内其它限频、把上游打成一堵墙。
 *
 * 【谁排队】只有**真正会发 HTTP 的**那一类（expand 模式的剪贴板 / 投票 / 收藏夹）
 * 才占名额；图床（只拼 URL）与对外视图（一个请求都不发）**不排队** ——
 * 占着名额只会让真正的取数变慢。判据在 reactive/ref-adapter.ts 的候选筛选。
 *
 * 【共享实例】编辑器预览 + 导出共用 client-compile.ts 的**模块级**闸门（同一时刻
 * 在飞 ≤ 4）；单次适配（如服务端阅读）没注入时按本次适配自建一个，上限相同。
 */
export const MAX_REF_CONCURRENCY = 4;

/**
 * 引用展开后的**总字符预算**。
 *
 * 【管两处】ReactiveMD 适配器（reactive/ref-adapter.ts）和编辑器导出
 * （markdown-editor/export.ts）都用它封顶「整篇 Markdown 展开后有多长」。
 *
 * 【语义】按出现顺序**整块**接受替换：接受后总量不超过本值就换，超了就**原样保留
 * token** —— 绝不截断内容、更不切整篇字符串（把半截 Markdown / HTML 交给 marked 或
 * 浏览器就是另一种坏法）。原文本身就超预算时**保留原文、不再增长**（编辑中的未合法草稿）。
 *
 * 【为什么是 50 万】单条剪贴板正文上限 5 万；同一条引用 50 次就是 250 万（改版前实测，
 * 无上限）。50 万 ≈ 十篇满额剪贴板，正常写作远远够用，又把最坏情况钉在一个可下发的量级。
 */
export const MAX_REF_EXPAND_CHARS = 500000;

/**
 * 一个「同一时刻最多跑 `limit` 个」的并发闸门（先进先出）。
 *
 * 【为什么住在这里】取数层与导出都要同一个上限：编辑器预览/导出（client-compile.ts
 * 的共享闸门）、reactive 适配器（未注入时的默认闸门）都用它；服务端映射的查库
 * （clipboard-service.ts）也沿用同一实现。各写一份的话，改了一处另一处
 * 还是老数 —— **没有任何报错**，只是并发悄悄翻倍。
 *
 * 【语义】返回的 Promise 在任务真正跑完时兑现；任务抛错**原样透传**（调用方自己 catch，
 * 出错也照常放行下一个，闸门不会卡住）。**不保证按入队顺序完成**，只保证同一时刻在跑的
 * 不超过 `limit`。排队期间要不要放弃（比如代际过期）由**任务自己**在开工时判断 ——
 * 闸门不管这个，也不该管。
 */
export function createConcurrencyLimiter(limit: number) {
  const cap = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = () => {
    while (active < cap) {
      const start = queue.shift();
      if (!start) return;
      active += 1;
      start();
    }
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        // **同步**调用 task：闸门未满时要让请求立刻发出 —— 在飞的那一格因此同步可见
        // （这条时序被取数层的并发用例钉着）。任务**同步抛错**时走 catch
        // 直接兑现成 reject，不能让它逃出 pump 把 `active` 漏成永久占用。
        let started: Promise<T>;
        try {
          started = task();
        } catch (err) {
          active -= 1;
          pump();
          reject(err);
          return;
        }
        started.then(
          (value) => {
            active -= 1;
            pump();
            resolve(value);
          },
          (err) => {
            active -= 1;
            pump();
            reject(err);
          }
        );
      });
      pump();
    });
  };
}

/**
 * 扫出正文里所有云剪贴板引用的 id（**去重、保持出现顺序**）。
 *
 * 与 `CLIPBOARD_REF_PROBE` 同一个形态：`[A-Za-z0-9]{8}`，**不含下划线**。
 * 理由见文件头那段 —— 伪 id（`[@________]`）一个都不该被拿去查库 / 拼 URL。
 * `\w` 那种宽松形态是博客渲染器按 id 长度分流时的事，不在这里。
 *
 * ★ 每次调用新建正则 ★ 全局正则的 `lastIndex` 会在调用之间残留。
 */
export function collectClipboardRefIds(text: string): string[] {
  const re = new RegExp(CLIPBOARD_REF_PROBE.source, 'g');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/**
 * 一条消息里最多展开几条云剪贴板。
 *
 * 【为什么是 1】剪贴板正文上限 50000 字（CLIP_CONTENT_MAX），而一条消息正文上限
 * 5000 字 —— 放开数量等于给「一条 10 字的短消息」变成几十万字 DOM 的机会，而且
 * 每条引用都是一次额外请求。1 条既够用（引用一段材料），又把最坏情况钉死。
 */
export const MAX_CLIPBOARD_REFS = 1;

/**
 * 一条消息里最多展开几张图床图片（超出部分保留 `[@id]` 字面量）。
 *
 * 【为什么必须封顶】5000 字正文理论上能塞下 ~450 个引用 = 450 次
 * `/api/images/<id>/raw` 的磁盘读。上限是正文的**确定性函数**，所以不破坏渲染
 * 缓存（同样正文 → 同样结果）。
 */
export const MAX_IMAGE_REFS = 50;

/**
 * 展开后的剪贴板正文上限。
 *
 * 【为什么截断】引用只占 10 个字符，但展开出来的是**另一名用户**写的、上限
 * 50000 字的内容。博客正文里 5 万字是合理的，讨论列表里就是灾难（而且这些节点
 * 会长期挂在列表上）。截断处给一句说明 + 回原剪贴板的链接，信息不丢。
 */
export const CLIP_EXPAND_MAX = 2000;

/** 剪贴板取不到时的占位文案。评论 / 讨论的取数层（useResolvedContent.ts）用的就是本函数。 */
export function clipboardFailureText(id: string): string {
  return `[剪贴板 ${id} 加载失败]`;
}

/**
 * reactive 剪贴板在 **Markdown 文本**里的唯一合法形态：一个站内链接。
 *
 * 评论 / 讨论那条管线读不懂 reactive 语法，内联源码的结果是整段源码被当成
 * Markdown/HTML 重新解释（静默坏内容）。文案不掺标题等用户输入，id 再过滤一遍
 * 非字母数字字符 —— 这个字符串会被拼进 Markdown 再交给富文本管线。
 *
 * （曾住在 content-ref-resolver.ts；legacy 渲染管线退役后随本文件迁入。）
 */
export function reactiveClipboardLink(id: string): string {
  const safeId = id.replace(/[^A-Za-z0-9]/g, '');
  return `[查看剪贴板](/clipboard/${safeId})`;
}

/** 内联图片的类名（净化后由我们自己的代码添加，用户伪造不了）。 */
export const IMAGE_REF_CLASS = 'rich-image-ref';

// ── 云剪贴板（8 位）─────────────────────────────────────────────────────────

export interface ClipboardRef {
  id: string;
  /** 原文里的完整匹配（含内部空白），用于精确定位替换区间。 */
  match: string;
  /** 匹配区间在原文里的起点。 */
  start: number;
}

/**
 * 找出**第一条**要展开的云剪贴板引用（没有就 null）。
 *
 * 只认第一条 = MAX_CLIPBOARD_REFS 的落地点：后面的 `[@8位]` 既不请求也不替换，
 * 原样留在正文里（与博客超出 50 处时的行为一致 —— 静默保留字面量，不报错）。
 */
export function firstClipboardRef(text: string): ClipboardRef | null {
  const m = CLIPBOARD_REF_PROBE.exec(text);
  if (!m || m.index === undefined) return null;
  return { id: m[1], match: m[0], start: m.index };
}

/**
 * 把那条引用换成剪贴板正文。
 *
 * ★ 按区间切片，不重扫整串 ★ —— 若照博客那样 `processed.replace(match, ...)`，
 * 插入的剪贴板正文里若含同样的 `[@id]`，`replace` 会命中**插入内容里的那处**，
 * 于是「一条消息最多 1 条剪贴板」被绕过（剪贴板正文里的引用会被再展开一次）。
 * 切片没有这个问题。
 */
export function replaceClipboardRef(text: string, ref: ClipboardRef, content: string): string {
  return text.slice(0, ref.start) + content + text.slice(ref.start + ref.match.length);
}

/**
 * 展开结果过长时截断，并附一句说明 + 回原剪贴板的链接。
 *
 * 链接写成 Markdown，因为它随后会跟正文一起过 marked。
 */
export function truncateClipboardContent(content: string, id: string): string {
  if (content.length <= CLIP_EXPAND_MAX) return content;
  return (
    `${content.slice(0, CLIP_EXPAND_MAX)}\n\n` +
    `> 内容过长，已截断。[查看完整剪贴板](/clipboard/${id})`
  );
}

// ── 图床图片（10 位 → 净化后换成 <img>）──────────────────────────────────────

/**
 * 把**已净化** DOM 文本节点里的 `[@<10位图床ID>]` 换成真 `<img>`。
 *
 * ★ 这是「我们不放开 img 白名单、图片却出得来」的全部秘密 ★
 * 换在 DOMPurify **之后**：走 createElement + setAttribute，绝不拼 innerHTML
 * （拼 innerHTML = 把到手的内容又交还给解析器；历史上投票嵌入因此出过一次真实的
 * 存储型 XSS）。因此用户手写的 `<img>` 照旧被转义、
 * `![](外链)` 照旧降级成链接 —— 能出现的图片只有我们亲手建的这一种形态。
 *
 * 三处刻意跳过（父节点是 `A` / `CODE` / `PRE`）：
 *   · `CODE` / `PRE` —— 用户想**展示这个语法本身**时应该写得出字面量；
 *   · `A` —— `[[@AbCdEf1234]](/blog/1)` 那种写法里，插图会变成 `<a>` 套 `<img>`。
 *
 * 与 linkifyTextNodes 同构：先收集再统一改（边走边改会让 TreeWalker 位置失效）。
 */
export function embedImageRefs(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
      // walker 是 SHOW_TEXT，所以拿到的一定是 Text
      return IMAGE_REF_PROBE.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let budget = MAX_IMAGE_REFS;
  for (const node of nodes) {
    if (budget <= 0) break;
    // 每个文本节点用一个新正则：全局正则的 lastIndex 会在多次 exec 之间残留。
    const re = new RegExp(IMAGE_REF_RE.source, 'g');
    const frag = doc.createDocumentFragment();
    let last = 0;
    let replaced = 0;
    for (const m of node.data.matchAll(re)) {
      if (budget <= 0) break;
      const at = m.index ?? 0;
      if (at > last) frag.appendChild(doc.createTextNode(node.data.slice(last, at)));
      const img = doc.createElement('img');
      img.className = IMAGE_REF_CLASS;
      img.setAttribute('src', `/api/images/${m[1]}/raw`);
      img.setAttribute('alt', m[1]);
      img.setAttribute('loading', 'lazy');
      frag.appendChild(img);
      last = at + m[0].length;
      budget -= 1;
      replaced += 1;
    }
    if (replaced === 0) continue;
    if (last < node.data.length) frag.appendChild(doc.createTextNode(node.data.slice(last)));
    node.replaceWith(frag);
  }
}
