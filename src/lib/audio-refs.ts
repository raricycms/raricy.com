// ─────────────────────────────────────────────────────────────────────────────
// audio-refs.ts — `[@音频/<ID>]` 引用语法的（纯逻辑 + DOM 构造）
//
// 【形状为什么是名字形，不是「再抢一个 ID 长度」】`[@…]` 那套按 id **长度**分流
// （content-refs.ts：8 剪贴板 / 9 投票 / 10 图床，favorite-refs.ts：6 收藏夹），
// 空闲长度早被占满。本语法于是跟 `[@用户/<用户名>]` / `[@合集/表情]` 走**具名
// 命名空间** —— 更可读，也不必去动那条「新增正文 ID 先确认长度没被占用」的不变式
// （见 docs/architecture.md §8「ID 风格」）。代价见下面那条保留合集名。
//
// ★ 一个 `\s*` 都不能有 ★（与 sticker-refs.ts / user-refs.ts 同一条纪律）
// 讨论侧的 @ 提及判定 `extractMentions` 跑在**原始正文**上：
//     '[@音频/AbCdEf1234]'   → []     （安全：`/` 卡住 lookahead）
//     '[@音 频/AbCdEf1234]'  → ['音'] （危险：@ 后紧跟字，空格正好满足 lookahead）
// 段内一旦允许空白，就是**向任意同名用户凭空发通知**。字符集也必须是白名单
// （`[A-Za-z0-9]`），宽一点就等于把 id 交还给解析器去拼 URL。
//
// 【`音频` 因此是保留合集名】与 `用户` 完全同构的问题：表情那条正则的形状也是
// `[@A/B]`，会把这个 token 吃成「合集=音频」。**两端必须一起改** ——
// sticker-refs.ts 的 RESERVED_CARD_COLLECTION 让开它，sticker-service.ts 的扫盘
// 跳过同名目录。只改一端 = 「面板里挑得出、一渲染却变成音频播放器」。
//
// 【两条管线接入方式不同，别互相照抄】
//   · 评论 / 讨论（rich-text.ts）：跑在**净化后的 DOM** 上，走 embedAudioRefs ——
//     createElement + setAttribute，绝不拼 innerHTML。这三个格式的白名单里**没有**
//     audio，所以音频只能从这条路出来（与 content-refs.ts 的图片同一条秘密）。
//   · 博客（MarkdownRenderer.tsx）：跑在 **Markdown 源文**上、marked 之前，
//     走 collectAudioRefs + replaceAudioRefs。那边 `audio` 本来就在白名单里
//     （blog-markdown.ts 的 BLOG_SANITIZE_OPTIONS），所以直接拼标签串即可。
//     ⚠️ 但**必须配 maskMarkdownCode** —— 源文阶段没有 DOM，跳过不了 CODE/PRE，
//     不盖码块就会在 `<code>` 里嵌出一个真播放器（见 favorite-refs.ts 的说明）。
//
// 本文件**零 import**：chat-shared.ts 的 stripPreviewTokens 要同时被服务端
// （chat-service.ts）与客户端（ChatApp.tsx）引用，拖进 prisma 会把客户端包弄炸。
// ─────────────────────────────────────────────────────────────────────────────

/** 音频床 ID 长度（复用图床那套 10 位 base62 生成器）。 */
export const AUDIO_ID_LEN = 10;

/**
 * 本语法占用的合集名 —— 表情那条正则**必须让开**（见 sticker-refs.ts）。
 *
 * ⚠️ 必须保持为**纯字面量**（不能含正则元字符）：它会被直接插进先行断言里。
 */
export const AUDIO_REF_COLLECTION = '音频';

/** 内联音频的类名（净化后由我们自己的代码添加，用户伪造不了）。 */
export const AUDIO_REF_CLASS = 'rich-audio-ref';

/** 音频字节的路由前缀。 */
export const AUDIO_URL_PREFIX = '/api/audio/';

/**
 * 一条消息里最多展开几个音频引用（超出部分保留字面量）。
 *
 * 【为什么是 3，而图床是 50】图片那边每个引用背后是一次小文件读；音频每个引用背后是
 * **MB 级**的流式传输。正文上限 5000 字能塞下几百个引用，按 50 放开就是一条消息
 * 放大出几百 MB 流量。3 够用（语音留言的场景里没人一条消息贴四段），又把最坏情况钉死。
 *
 * 上限是正文的**确定性函数**，所以不破坏 rich-text.ts 的渲染缓存
 * （音频 URL 是 id 的纯函数，与图片同理 —— **不需要**像用户名片那样绕开缓存）。
 */
export const MAX_AUDIO_REFS = 3;

/** 字母数字本体（不含斜杠 / 空白 / 引号）—— 白名单，不是黑名单。 */
const ALNUM = '[A-Za-z0-9]';

/** 匹配 `[@音频/<10位>]`（全局版，一次替换全部）。 */
export const AUDIO_REF_RE = new RegExp(
  `\\[@${AUDIO_REF_COLLECTION}/(${ALNUM}{${AUDIO_ID_LEN}})\\]`,
  'g'
);

/** 同上，非全局 —— 只问「这个文本节点里有没有」，避免 `lastIndex` 残留。 */
export const AUDIO_REF_PROBE = new RegExp(
  `\\[@${AUDIO_REF_COLLECTION}/(${ALNUM}{${AUDIO_ID_LEN}})\\]`
);

/**
 * 音频字节的直链。**只接受 id，不接受整条 URL** —— 与本模块「URL 由我们拼」的
 * 全部意义所在：用户能写的只有 token，写不出任意外链播放器
 * （外链 `<audio>` = 访客 IP 泄露的跟踪信标，与评论里禁止外链图同源）。
 */
export function audioUrl(id: string): string {
  return `${AUDIO_URL_PREFIX}${id}/raw`;
}

/** token → 展示用的短标记（侧栏预览 / 通知正文），与既有 `[图片]`/`[博客]`/`[表情]` 同口径。 */
export function stripAudioTokens(text: string, to = '[音频]'): string {
  // 每次新建正则：模块级 g 正则被 test()/exec() 用过之后 lastIndex 会残留
  return text.replace(new RegExp(AUDIO_REF_RE.source, 'g'), to);
}

// ── 评论 / 讨论：净化后的 DOM 上建节点 ────────────────────────────────────────

/**
 * 把**已净化** DOM 文本节点里的 `[@音频/<10位>]` 换成真 `<audio controls>`。
 *
 * 与 content-refs.ts 的 embedImageRefs 逐条同构：先收集再统一改（边走边改会让
 * TreeWalker 位置失效）、每个文本节点新建一个正则（全局正则的 lastIndex 会残留）、
 * 跳过 `A` / `CODE` / `PRE` 父节点（`CODE`/`PRE` 是为了让用户**展示语法本身**时
 * 写得出字面量，`A` 是因为 `<a>` 里套播放器没有意义）。
 *
 * `data-token` 是为了降级：加载失败（已软删 / 站外引用被拦）时，
 * RichContentBody 的捕获期 error 委托会把它换回原文 token —— 与表情那条既有契约
 * 一致（「写错了显示原文」）。属性写在**净化之后**，所以能留住。
 */
export function embedAudioRefs(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
      // walker 是 SHOW_TEXT，所以拿到的一定是 Text
      return AUDIO_REF_PROBE.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let budget = MAX_AUDIO_REFS;
  for (const node of nodes) {
    if (budget <= 0) break;
    const re = new RegExp(AUDIO_REF_RE.source, 'g');
    const frag = doc.createDocumentFragment();
    let last = 0;
    let replaced = 0;
    for (const m of node.data.matchAll(re)) {
      if (budget <= 0) break;
      const at = m.index ?? 0;
      if (at > last) frag.appendChild(doc.createTextNode(node.data.slice(last, at)));
      const el = doc.createElement('audio');
      el.className = AUDIO_REF_CLASS;
      el.setAttribute('controls', '');
      // metadata 而不是 none：要让用户看见时长（语音留言尤其需要）。
      // Range 支持让这一次探测只取容器头部那几百字节，不是整个文件。
      el.setAttribute('preload', 'metadata');
      el.setAttribute('src', audioUrl(m[1]));
      el.setAttribute('data-token', m[0]);
      frag.appendChild(el);
      last = at + m[0].length;
      budget -= 1;
      replaced += 1;
    }
    if (replaced === 0) continue;
    if (last < node.data.length) frag.appendChild(doc.createTextNode(node.data.slice(last)));
    node.replaceWith(frag);
  }
}

// ── 博客：Markdown 源文上的收集与按区间替换 ───────────────────────────────────

/** 正文里的一处音频引用（位置用于精确切片，见 replaceAudioRefs）。 */
export interface AudioRefSlot {
  id: string;
  /** 原文里的完整匹配，用于精确定位替换区间。 */
  match: string;
  /** 匹配区间在原文里的起点。 */
  start: number;
}

/**
 * 扫出正文里所有音频引用，**上限 MAX_AUDIO_REFS**。
 *
 * `masked` 是盖过代码块的副本（maskMarkdownCode 的产物），`source` 是原文 ——
 * 两边**等长**，所以下标一一对应，切片要切 `source`。`match` 也取自 `source`。
 *
 * ★ 每次调用新建正则 ★ 全局正则的 lastIndex 会残留（content-refs.ts 记着同一条）。
 */
export function collectAudioRefs(source: string, masked: string): AudioRefSlot[] {
  const re = new RegExp(AUDIO_REF_RE.source, 'g');
  const slots: AudioRefSlot[] = [];
  for (const m of masked.matchAll(re)) {
    if (slots.length >= MAX_AUDIO_REFS) break;
    const at = m.index ?? 0;
    slots.push({ id: m[1], match: source.slice(at, at + m[0].length), start: at });
  }
  return slots;
}

/**
 * 把引用按**区间切片**换成 `<audio>` 标签串。
 *
 * 【为什么不 replace(match, …)】与 replaceClipboardRef / replaceFavoriteRefs 同一条：
 * 按内容搜索会命中**插入内容里的那处**。这里插进去的是标签串本身，不含 token，
 * 但保持同一种写法，将来改标签内容时不会突然长出这条 bug。
 *
 * 倒序替换，前面的下标才不会被后面的改动位移。
 */
export function replaceAudioRefs(source: string, slots: AudioRefSlot[]): string {
  let out = source;
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    const s = slots[i];
    out = out.slice(0, s.start) + audioRefHtml(s.id) + out.slice(s.start + s.match.length);
  }
  return out;
}

/**
 * 博客侧的 `<audio>` 标签串。
 *
 * 只接 id，且调用方传进来的一定是 AUDIO_REF_RE 捕获组里的 `[A-Za-z0-9]{10}`，
 * 所以这里**不需要转义** —— 但也正因如此，别把本函数导出给「用户能传任意串」的
 * 调用点用。`class` / `controls` / `preload` / `src` 都在 blog-markdown.ts 的
 * BLOG_SANITIZE_OPTIONS 里，DOMPurify 会让它过。
 */
export function audioRefHtml(id: string): string {
  return (
    `<audio class="${AUDIO_REF_CLASS}" controls preload="metadata" ` +
    `src="${audioUrl(id)}"></audio>`
  );
}
