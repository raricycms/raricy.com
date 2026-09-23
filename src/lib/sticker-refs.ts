// ─────────────────────────────────────────────────────────────────────────────
// sticker-refs.ts — 表情包引用语法 `[@合集/表情]` 的纯逻辑
//
// 【素材在哪】两个来源，**语法完全一样**，只有 URL 前缀与尺寸不同：
//   · 站长放的图片表情：instance/stickers/<合集>/<表情>.{gif,webp,png}，**不入库**
//     （/instance/ 已在 .gitignore）。扫盘与 manifest 在 src/lib/sticker-service.ts
//     （server-only）。
//   · 内置的「黄脸表情」合集：public/static/emoji/*.svg，来源与许可见
//     src/lib/emoji-faces.ts 的文件头。那份清单是编译期常量，所以**浏览器侧
//     就能解析**，不用问服务器。
// 本文件只负责**浏览器侧**的识别与替换 —— 与 content-refs.ts 的分工完全一样。
//
// 【为什么分隔符是斜杠】文件名在文件系统层面不可能含 `/`，所以切分天然唯一；
// 若用 `-` 就与文件名里的连字符撞车（`[@猫猫-开心-难过]` 无法判断从哪切）。
// 顺带一个好处：token 里含 `/` 就**天然免疫** content-refs.ts 那两条精确长度
// 正则（`{8}` / `{10}` 只认 [A-Za-z0-9]），永远不会被误当成剪贴板或图床引用。
//
// 【`用户` 与 `音频` 是保留合集名】用户名片 `[@用户/张三]`（见 user-refs.ts）与
// 音频引用 `[@音频/<ID>]`（见 audio-refs.ts）都与本语法形状完全同构，所以下面的
// 正则带负向先行断言把它们让开 —— 站长不能用这两个合集名，理由与代价见
// RESERVED_CARD_COLLECTION 的注释。
//
// ⚠️ 加第三个保留名时要**两端一起改**：这里 + sticker-service.ts 的扫盘跳过。
// 只改一端 = 「面板里挑得出、一渲染却变成别的东西」。
//
// 【只在评论与讨论生效】博客正文走另一条异步管线（MarkdownRenderer.tsx 的
// ContentRefProcessor），那边不支持表情，`[@猫猫/开心]` 原样显示字面量 ——
// 与「9 位投票在评论/讨论里不展开」是同一类有意的口径差异。
//
// 本文件不依赖任何 Node 侧东西（会被打进客户端包）、不碰 React，
// 故可直接单测（tests/unit/sticker-refs.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import { AUDIO_REF_COLLECTION } from './audio-refs';
import { EMOJI_COLLECTION, emojiFileFor, emojiUrl } from './emoji-faces';
import { USER_CARD_COLLECTION } from './user-refs';

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
 * 被**别的引用语法**占用的合集名 —— 表情这条正则**必须全部让开**。
 *
 * 目前两个：`用户`（名片 `[@用户/张三]`，user-refs.ts）与
 * `音频`（音频床 `[@音频/<ID>]`，audio-refs.ts）。两者与本语法的形状都完全同构
 * （一段名字 + 斜杠 + 一段），不加断言就会被吃成「合集=用户」「合集=音频」。
 *
 * 【为什么让开的是表情，而不是它们】形状虽同构，但那两趟各自有自己的识别与 DOM
 * 构造，是**更专用**的一方；表情的合集名是站长随手建的目录，撞名的代价小得多。
 * 让开后连带两件事：
 *   · 预览/摘要里的 `[@用户/张三]` 不会被压成 `[表情]`；
 *   · 渲染时不会白去请求一次 `/api/stickers/用户/张三`。
 * 站长侧的表现是「给合集起名『用户』/『音频』会失效」（sticker-service 扫盘时也
 * 不会列出它们），这条写在 docs/guide/表情包使用指南.md 里。
 *
 * ⚠️ 上面那两个来源常量都必须保持为**纯字面量**（不能含正则元字符）—— 它们是直接
 * 插进下面的先行断言里的。哪天要改，记得同时改 tests/unit/sticker-refs.test.ts
 * 里那两条断言（`用户` 那条是既有的，`音频` 那条是后补的）。
 */
const RESERVED_CARD_COLLECTIONS = [USER_CARD_COLLECTION, AUDIO_REF_COLLECTION];
const RESERVED_CARD_COLLECTION = `(?!(?:${RESERVED_CARD_COLLECTIONS.join('|')})/)`;

/**
 * 匹配 `[@合集/表情]`（全局版，一次替换全部）。
 *
 * 【分段捕获仍是 m[1] / m[2]】上面那条负向先行断言是**非捕获**的，组号不变 ——
 * 面板拼 token、用例取段名都依赖这两个下标，改成正则会静默错位。
 *
 * 【刻意不加 `\s*`】与 IMAGE_REF_RE 的宽容口径（`\[@\s*(...)\s*\]`）不同。
 * 理由是讨论侧的 @ 提及判定：extractMentions 的正则是
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
export const STICKER_REF_RE = new RegExp(
  `\\[@${RESERVED_CARD_COLLECTION}(${SEG})/(${SEG})\\]`,
  'gu'
);

/** 同上，非全局 —— 只问「这个文本节点里有没有」，避免 `lastIndex` 残留。 */
export const STICKER_REF_PROBE = new RegExp(
  `\\[@${RESERVED_CARD_COLLECTION}(${SEG})/(${SEG})\\]`,
  'u'
);

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
 * 内置黄脸表情的**尺寸修饰类** —— 叠在 `rich-sticker-ref` 之上，不是替换它。
 *
 * 【为什么必须叠、而不是换一个类名】降级链是按 `STICKER_REF_CLASS` 过滤的：
 * RichContentBody 的捕获期 error 委托里写着
 * `if (!target.classList.contains(STICKER_REF_CLASS)) return;`。
 * 换掉它，黄脸缺图时就会显示**裂图**而不是退回原文 token —— 那正好破坏了
 * 「写错了显示原文」这条既有契约（`docs/guide/表情包使用指南.md` 第五节）。
 *
 * 所以分工是：
 *   · `rich-sticker-ref` = 「这是跟随正文的行内表情图」→ 管降级、管不弹灯箱；
 *   · `rich-emoji-ref`   = 「但它是文字大小的那种」     → 只管尺寸，见 _markdown-body.scss。
 *     （**整条正文只有它一张时**是例外：那时不生效，见 EMOJI_SOLO_CLASS。）
 */
export const EMOJI_REF_CLASS = 'rich-emoji-ref';

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
 *   · 内置黄脸合集（`[@黄脸/…]`）与站长放的表情走**同一条**流程，只有两处不同：
 *     src 取自 `emoji-faces.ts` 的编译期清单、并多叠一个 `EMOJI_REF_CLASS` 改尺寸。
 *     两条**共用一个 30 的预算**（见 MAX_STICKER_REFS），不另立额度。
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
      // 内置黄脸合集在编译期就知道地址，走 /static/emoji/；站长放的表情走字节路由。
      // 名字在清单里查不到（手打错、或站长自己也建了个「黄脸」目录）时**退回字节路由**
      // —— 那条会 404 → 触发降级链显示原文 token，而不是留一张永远加载不出来的裂图。
      const emojiFile = m[1] === EMOJI_COLLECTION ? emojiFileFor(m[2]) : undefined;
      const img = doc.createElement('img');
      img.className = emojiFile ? `${STICKER_REF_CLASS} ${EMOJI_REF_CLASS}` : STICKER_REF_CLASS;
      img.setAttribute('src', emojiFile ? emojiUrl(emojiFile) : stickerUrl(m[1], m[2]));
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

/**
 * 「整条正文只有这一张黄脸」的修饰类 —— 叠在 `rich-sticker-ref` + `rich-emoji-ref` 之上。
 *
 * 【为什么它是「取消压缩」而不是「另写一套尺寸」】黄脸平时压到文字大小（1.2em，
 * 见 _markdown-body.scss），而**单发一张**时用户要的是「发了个表情」的观感 —— 与站长
 * 放的图片表情同一档（4em）。实现上这个类**不重新声明 4em**：它只是让那条 1.2em 的
 * 规则不再匹配，尺寸于是落回图片表情那条盒子 —— 「一样大」这句话全站只有**一处**定义，
 * 以后改表情包尺寸时这一档会自己跟上，不会静默漂成两档。
 *
 * 【三个类一个都不能换】`rich-sticker-ref` 管降级链（换掉 → 缺图显示裂图）、
 * `rich-emoji-ref` 管「平时是文字大小」、这个管「独处时不是」。理由同 EMOJI_REF_CLASS。
 */
export const EMOJI_SOLO_CLASS = 'rich-emoji-solo';

/**
 * 整条正文恰好只有一张黄脸 → 给它叠 EMOJI_SOLO_CLASS（尺寸落回图片表情那一档）。
 *
 * ★ 调用点必须在**所有会建元素的 embed\* 都跑完之后**（rich-text.ts 的 render() 末行）：
 *   它问的是「**最终** DOM 里是不是只有这一张」。往后加新的 embed\* 时忘了这条，
 *   新元素就会漏出判断 —— 表现只是尺寸偶尔不对，不报错、不写日志。
 *
 * 三条判据，缺一不可：
 *
 *  · **文本全空**（`trim()`）—— 这是 `你好 [@黄脸/微笑]` 唯一的出局处：元素计数挡不住它，
 *    因为文本节点不算元素。空白容忍是**刻意的**（`'  [@黄脸/微笑]  '` 也算单发），
 *    否则用户发之前按了个空格，表情就缩回去了。零宽字符（U+200B 之类）不算空白 →
 *    退回 1.2em：看不见的差别，不为它加归一化。
 *  · **恰好一张**带 `rich-emoji-ref` 的图 —— 多颗黄脸、黄脸 + 图床图 / 音频 / 图片表情
 *    都在这一步出局；黄脸合集里查不到的名字走字节路由、本来就没有 `rich-emoji-ref`
 *    （它已经是 4em 了，不需要这个类）。
 *  · **除它以外整棵 DOM 只有它的一层层 `<p>` 祖先** —— `<br>`（marked 开着 `breaks: true`，
 *    换行就是它）、标题 / 列表 / 引用里的那一颗、以及同一段里混进来的第二个元素全部出局。
 *    显式判 `parentElement` 是必需的：`img` 直接挂在容器上时「零个 P 祖先」会让后面的
 *    计数条件**恒真**，于是把一个不是段落的 DOM 判成「一段里只有一张表情」。
 *
 * 失败时**什么都不做**（保持 1.2em），不报错也不降级 —— 缩回去的那张仍然是完全正常的
 * 一张黄脸，只是不放大而已。
 */
export function markSoloEmojiFaces(root: HTMLElement): void {
  if ((root.textContent ?? '').trim() !== '') return;
  const imgs = root.querySelectorAll(`img.${STICKER_REF_CLASS}.${EMOJI_REF_CLASS}`);
  if (imgs.length !== 1) return;
  const img = imgs[0];
  if (img.parentElement?.tagName !== 'P') return;
  // 数一遍元素：img 自己 + 它往上到 root 的每一层 <p>，必须正好是整棵 DOM 的元素数
  let accounted = 1;
  for (let el: Element | null = img.parentElement; el && el !== root; el = el.parentElement) {
    if (el.tagName !== 'P') return;
    accounted += 1;
  }
  if (root.querySelectorAll('*').length !== accounted) return;
  img.classList.add(EMOJI_SOLO_CLASS);
}
