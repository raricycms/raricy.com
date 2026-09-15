// ─────────────────────────────────────────────────────────────────────────────
// sticker-refs.ts — 表情包引用语法 `[@合集/表情]` 的纯逻辑
//
// 【素材在哪】instance/stickers/<合集>/<表情>.{gif,webp,png}，**不入库**
// （/instance/ 已在 .gitignore）。扫盘与 manifest 在 src/lib/sticker-service.ts
// （server-only），本文件只负责**浏览器侧**的识别与替换 —— 与 content-refs.ts
// 的分工完全一样。
//
// 【为什么分隔符是斜杠】文件名在文件系统层面不可能含 `/`，所以切分天然唯一；
// 若用 `-` 就与文件名里的连字符撞车（`[@猫猫-开心-难过]` 无法判断从哪切）。
// 顺带一个好处：token 里含 `/` 就**天然免疫** content-refs.ts 那两条精确长度
// 正则（`{8}` / `{10}` 只认 [A-Za-z0-9]），永远不会被误当成剪贴板或图床引用。
//
// 【只在评论与聊天生效】博客正文走另一条异步管线（MarkdownRenderer.tsx 的
// ContentRefProcessor），那边不支持表情，`[@猫猫/开心]` 原样显示字面量 ——
// 与「9 位投票在评论/聊天里不展开」是同一类有意的口径差异。
//
// 本文件零依赖、不碰 React，故可直接单测（tests/unit/sticker-refs.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单段（合集名 / 表情名）允许的字符：Unicode 字母、数字、`+`、`·`、`-`。
 *
 * 【为什么是白名单，而不是「排除掉 / 和 ]」】
 * 否定式字符集（`[^\]/\s]+`）看着宽容，实际会把 `` ` `` `*` `~` `_` 等
 * markdown 元字符放进来。而 marked 会先把它们吃掉再交给我们：
 *
 *     marked.parse('[@开心/`x`]')  →  '<p>[@开心/<code>x</code>]</p>'
 *
 * token 就此被拆进三个文本节点，TreeWalker 永远匹配不到 —— **静默退回字面量**，
 * 没有报错、没有日志，用户只看到「表情没出来」。白名单让这类 token 从不匹配，
 * 行为至少是可解释的。
 */
const SEG_CHAR = '\\p{L}\\p{N}+·-';

/** 单段长度上限。两端都封顶 → 量词有界，无 ReDoS 风险。 */
const SEG_LEN = 32;

const SEG = `[${SEG_CHAR}]{1,${SEG_LEN}}`;

/**
 * 匹配 `[@合集/表情]`（全局版，一次替换全部）。
 *
 * 【刻意不加 `\s*`】与 IMAGE_REF_RE 的宽容口径（`\[@\s*(...)\s*\]`）不同。
 * 理由是聊天侧的 @ 提及判定：extractMentions 的正则是
 * `/@([\p{L}\p{N}_-]{1,20})(?=\s|$)/gu`，而 token 以 `[@` 开头 ——
 *
 *     '[@猫猫/开心]'   → []        （安全：`/` 卡住 lookahead）
 *     '[@猫 猫/开心]'  → ['猫']     （危险：@ 后紧跟字，空格正好满足 lookahead）
 *
 * 也就是说「段内允许空白」= 允许用户凭空给一个叫「猫」的人发通知。
 * 一个空白都不放进来，这条路直接不存在。
 *
 * 【不含 `[` 和 `]`】`]` 不在 SEG 里，才让 `[@a/b] 和 [@c/d]` 不可能被一个
 * 匹配吞掉（否则第一段的字符集会一路吃到 `] 和 [@c`）。
 */
export const STICKER_REF_RE = new RegExp(`\\[@(${SEG})/(${SEG})\\]`, 'gu');

/** 同上，非全局 —— 只问「这个文本节点里有没有」，避免 `lastIndex` 残留。 */
export const STICKER_REF_PROBE = new RegExp(`\\[@(${SEG})/(${SEG})\\]`, 'u');

/**
 * 内联表情的类名。
 *
 * 【必须与 IMAGE_REF_CLASS 不同】RichContentBody 的点击委托按 `rich-image-ref`
 * 判定「点开原图」，用同一个类名会让点表情弹出大图灯箱。
 * 同理，SCSS 里那条通用的 `img { display: block }`（_markdown-body.scss）
 * 也要靠这个类名盖掉 —— 表情是行内的，不能把整行断开。
 */
export const STICKER_REF_CLASS = 'rich-sticker-ref';

/**
 * 一条消息里最多展开几张表情（超出部分保留字面量）。
 *
 * 【为什么必须封顶】与 MAX_IMAGE_REFS 是同一笔账：5000 字正文能塞下几百个
 * token（`[@a/b]` 只有 7 个字符），每个都是一次 `/api/stickers/...` 的磁盘读。
 * 而表情 token 比图床 ID 短得多，不封顶能塞进的数量更多。
 *
 * 【为什么与 MAX_IMAGE_REFS 分开计】共用一个预算会让「消息里既有图又有表情」
 * 时的行为变得难以解释（谁先谁后、谁占谁的额度）。分开则各管各的，上限都是
 * 正文的**确定性函数**，不破坏 rich-text.ts 的渲染缓存。
 */
export const MAX_STICKER_REFS = 30;

/** 表情图片的路由前缀。 */
export const STICKER_URL_PREFIX = '/api/stickers/';

/**
 * 查表键 —— **两端都归一化成 NFC**。
 *
 * 【为什么必须归一化】站长是在 Windows 上把文件拷进目录的，而 NTFS **不做任何
 * Unicode 归一化**，readdir 返回的就是磁盘上的原始码点；同时手机（iOS/macOS
 * 键盘）与部分输入法产出的是 NFD（分解形）。带音标的拉丁字母、韩文、部分兼容
 * 汉字会「看起来一模一样但码点不同」→ 匹配不上 → **静默退回字面量**。
 *
 * 注意归一化只用于**键**：真实路径一律用 readdir 拿到的原始名（见
 * sticker-service.ts），否则会拿着一个磁盘上不存在的规范化名字去 readFile。
 *
 * 大小写**敏感**：Linux 上 `Cat.png` 与 `cat.png` 是两个不同的文件，做成不敏感
 * 会在那里撞键。而面板插入的是规范形，用户手打不出错的大小写。
 */
export function stickerKey(collection: string, name: string): string {
  return `${collection.normalize('NFC')}/${name.normalize('NFC')}`;
}

/**
 * 表情图片地址。
 *
 * SEG 白名单已经排除了 `%` `?` `#` `/` `\` 与空白，所以对任何合法 token，
 * encodeURIComponent 都是恒等变换 —— 写上是为了「将来放宽 SEG 时 URL 不会
 * 跟着坏」，而不是现在需要它。
 */
export function stickerUrl(collection: string, name: string): string {
  return `${STICKER_URL_PREFIX}${encodeURIComponent(collection)}/${encodeURIComponent(name)}`;
}

/** token → 展示用的短标记（侧栏预览 / 通知正文），与既有 `[图片]`/`[博客]` 同口径。 */
export function stripStickerTokens(text: string, to = '[表情]'): string {
  // 每次新建正则：模块级 g 正则被 test()/exec() 用过之后 lastIndex 会残留
  return text.replace(new RegExp(STICKER_REF_RE.source, 'gu'), to);
}

// ── 渲染（需要 DOM，与 content-refs.ts 的 embedImageRefs 同构）────────────────

/**
 * 把**已净化**文本节点里的 `[@合集/表情]` 换成内联 `<img>`。
 *
 * 与 content-refs.ts 的 embedImageRefs 逐条同构，理由也一样，此处只记差异：
 *
 *   · 富组件的注入点在**净化之后**（rich-text.ts 的 render()），用
 *     `createElement` + `setAttribute`，**绝不拼 innerHTML** —— 拼 innerHTML
 *     等于把到手的内容又交还给解析器，正是 blog-markdown.ts 文件头那次
 *     存储型 XSS 的成因。
 *   · 三处跳过（父节点是 `A` / `CODE` / `PRE`）与 embedImageRefs 逐字相同：
 *     CODE/PRE 让用户写得出字面量（能在文档里展示语法本身），A 避免
 *     `[[@a/b]](url)` 变成 `<a>` 里套 `<img>`。
 *   · `alt` 与 `data-token` 都设成**原始 token**。这两个是降级链的两层：
 *     `data-token` 供 RichContentBody 在图片 404 时换回文本；`alt` 是最后一层
 *     —— JS 没跑到 / 被挡掉时浏览器把 alt 画出来，用户看到的正好是字面量。
 *
 * 加载失败**不在这里处理**：本函数的产物会被序列化成字符串（render() 是
 * 字符串进字符串出），挂在这批节点上的任何监听器都会在那一刻丢失。
 * 降级由 RichContentBody 在**容器上做捕获阶段的事件委托**。
 */
export function embedStickerRefs(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
      // walker 是 SHOW_TEXT，所以拿到的一定是 Text
      return STICKER_REF_PROBE.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let budget = MAX_STICKER_REFS;
  for (const node of nodes) {
    if (budget <= 0) break;
    // 每个文本节点用一个新正则：全局正则的 lastIndex 会在多次 exec 之间残留。
    const re = new RegExp(STICKER_REF_RE.source, 'gu');
    const frag = doc.createDocumentFragment();
    let last = 0;
    let replaced = 0;
    for (const m of node.data.matchAll(re)) {
      if (budget <= 0) break;
      const at = m.index ?? 0;
      if (at > last) frag.appendChild(doc.createTextNode(node.data.slice(last, at)));
      const img = doc.createElement('img');
      img.className = STICKER_REF_CLASS;
      img.setAttribute('src', stickerUrl(m[1], m[2]));
      img.setAttribute('alt', m[0]);
      img.setAttribute('data-token', m[0]);
      img.setAttribute('loading', 'lazy');
      img.setAttribute('draggable', 'false');
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
