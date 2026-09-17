// ─────────────────────────────────────────────────────────────────────────────
// favorite-refs.ts — 收藏夹引用语法 `[@<六位收藏夹ID>]` 的**纯逻辑**
//
// 【在哪条管线上】只认博客侧那条（src/app/components/MarkdownRenderer.tsx 的
// ContentRefProcessor）。云剪贴板正文复用同一个组件，所以自动跟着生效；
// 评论与讨论走的是另一条同步管线（src/lib/rich-text.ts），**刻意不认** ——
// 与 9 位投票「只识别不展开」的先例同向：那里的投票是不展开，这里是压根不认，
// 原样保留字面量。理由：讨论气泡里塞一个长列表没有意义，且这样私密收藏夹的 id
// 永远不会出现在别人写的内容里。
//
// 【为什么是 6 位】`[@…]` 的分流**只按 id 长度**（MarkdownRenderer 的
// `id.length === 8 / 9 / 10`，无 else 兜底）。已占用：8 剪贴板 / 9 投票 / 10 图床 /
// 12 OAuth app / UUID（博客、评论、用户 —— 含连字符，`\w` 匹配不到）。
// 6 位是唯一空闲长度，与任何现有 id 都不会互相误判。
//
// 【字符集必须是白名单】`[@________]` 这类下划线 token 也凑得出 10 个字符，所以
// 判定必须是 `^[0-9]{6}$` 而不是「长度为 6」—— 6 位**字母**的 token 必须落回
// 字面量，而不是拿去请求一次 API。
//
// 【卡片为什么直接产出成品 HTML，而不是投票那种「占位 div + data-* + 后处理建 DOM」】
// 因为 BLOG_SANITIZE_OPTIONS 是 `ALLOW_DATA_ATTR: false`（blog-markdown.ts）：
// 新加一个 data-favorite-id 会被 DOMPurify **静默剥掉** —— 占位符消失、卡片永远不
// 出现，且完全不报错。而 ALLOWED_TAGS 已含 div/ul/li/a/span、ALLOWED_ATTR 已含
// class/href（同上），成品 HTML 本来就在白名单内。投票之所以必须两段式是因为它
// **可交互**；收藏夹卡片是静态的，该照剪贴板那条先例（预处理器直接产出内容）。
// 于是：不必改净化白名单、不必写第二段 useEffect 建 DOM、也没有「id 拼进属性」的
// 逃逸面。代价是动态文本必须**我们自己转义**（见 escapeHtml）——
// 博客标题是不可信输入。
//
// 本文件零依赖、不碰 DOM 也不碰 React，故可直接单测
// （tests/unit/favorite-refs.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/** 收藏夹对外 ID 长度（`generateFavoriteId()`，见 src/lib/favorite-service.ts）。 */
export const FAVORITE_ID_LEN = 6;

/**
 * 收藏夹 ID 的形态：**恰好 6 位数字**。全程按字符串处理 ——
 * 绝不能 `Number(publicId)`（"000123" 会被压成 "123"，于是「收藏夹不存在」）。
 */
export const FAVORITE_ID_RE = new RegExp(`^[0-9]{${FAVORITE_ID_LEN}}$`);

export function isFavoriteId(value: unknown): value is string {
  return typeof value === 'string' && FAVORITE_ID_RE.test(value);
}

/**
 * 一篇正文里最多展开几张收藏夹卡片（超出部分保留 `[@id]` 字面量）。
 *
 * 【为什么是 3】卡片是**块级**的、比一段文字高得多，一篇正文里插十几张会把文章
 * 冲成一片卡片墙；且每张都是一次 `/api/spider/favorites/<id>` 请求。上限取成正文的
 * **确定性函数**（同样正文 → 同样结果），与 MAX_IMAGE_REFS / MAX_CLIPBOARD_REFS 同口径。
 */
export const MAX_FAVORITE_REFS = 3;

/** 卡片里最多列出几条博客（其余靠「查看全部」进详情页）。 */
export const MAX_CARD_ITEMS = 10;

/** 收藏夹卡片取不到时的占位文案，与 clipboardFailureText 逐字同构。 */
export function favoriteFailureText(id: string): string {
  return `[收藏夹 ${id} 加载失败]`;
}

/**
 * HTML 文本转义 —— 卡片里的标题 / 用户名都是**不可信输入**。
 *
 * ★ 为什么必须自己转义 ★ 卡片 HTML 是在净化**之前**拼进 Markdown 的（要和 marked
 * 一起过一遍），所以 DOMPurify 还没上场。虽然它随后会把危险标签剥掉，但依赖「下一道
 * 防线会兜住」是错的建法 —— 而且 DOMPurify 不负责把 `&`/`<` 还原成用户想显示的字面量。
 * 顺带这也是唯一挡住「标题里写 `</div><script>` 逃出卡片容器」的东西。
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 卡片渲染所需的公开数据（由 /api/spider/favorites/<id> 提供）。 */
export interface FavoriteCardData {
  /** 6 位 ID。 */
  id: string;
  title: string;
  /** 收藏夹内博客总数（可能大于 blogs.length —— 卡片只列前 MAX_CARD_ITEMS 条）。 */
  count: number;
  /** 收藏夹创建者用户名（可为空字符串）。 */
  author?: string;
  /** 已截到 MAX_CARD_ITEMS 的博客列表。 */
  blogs: { id: string; title: string }[];
}

/**
 * 把收藏夹数据拼成卡片 HTML。
 *
 * 形态与投票嵌入同构（一个块级容器 + 内容 + 进详情页的链接），但**一次性产出成品**：
 * 没有占位符、没有 data 属性、没有后续 DOM 构造。
 *
 * 所有动态文本都过 escapeHtml；链接目标只有两种形态 —— `/blog/<UUID>` 与
 * `/favorite/<6位>`，两者的 id 都已在上游过白名单，不参与拼接。
 */
export function buildFavoriteCardHtml(data: FavoriteCardData): string {
  const items = data.blogs
    .map(
      (b) =>
        `<li><a class="favorite-embed__item" href="/blog/${escapeHtml(b.id)}">` +
        `${escapeHtml(b.title)}</a></li>`
    )
    .join('');
  const author = data.author
    ? `<span class="favorite-embed__author">@${escapeHtml(data.author)}</span>`
    : '';
  // 「查看全部」只在真的还有更多时出现（列全了就没有去的理由）
  const more =
    data.count > data.blogs.length
      ? `<a class="favorite-embed__more" href="/favorite/${escapeHtml(data.id)}">` +
        `查看全部 ${data.count} 篇 →</a>`
      : '';
  return (
    `<div class="favorite-embed">` +
    `<div class="favorite-embed__head">` +
    `<span class="favorite-embed__title">${escapeHtml(data.title)}</span>` +
    `<span class="favorite-embed__count">共 ${data.count} 篇</span>` +
    author +
    `</div>` +
    (items ? `<ul class="favorite-embed__list">${items}</ul>` : '') +
    more +
    `</div>`
  );
}

/** 正文里的一处收藏夹引用（位置用于精确切片，见 replaceFavoriteRefs）。 */
export interface FavoriteRefSlot {
  id: string;
  /** 原文里的完整匹配（含内部空白），用于精确定位替换区间。 */
  match: string;
  /** 匹配区间在原文里的起点。 */
  start: number;
}

/**
 * 扫出正文里所有收藏夹引用（含内部空白容忍，与博客侧那条 `\[@\s*(\w+)\s*\]` 同口径）。
 *
 * ★ 每次调用新建正则 ★ 全局正则的 `lastIndex` 会在多次 exec 之间残留，复用同一个
 * 实例会让第二次调用从上次的位置继续（content-refs.ts 的 embedImageRefs 记着同一条）。
 */
export function collectFavoriteRefs(text: string): FavoriteRefSlot[] {
  const re = new RegExp(`\\[@\\s*([0-9]{${FAVORITE_ID_LEN}})\\s*\\]`, 'g');
  const out: FavoriteRefSlot[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ id: m[1], match: m[0], start: m.index ?? 0 });
  }
  return out;
}

/**
 * 把正文里的收藏夹引用换成卡片 HTML，**按区间切片**。
 *
 * ★ 为什么不 `text.replace(match, html)` ★ 与 replaceClipboardRef 同一个理由：
 * 卡片 HTML 里含博客标题，标题里若正好有 `[@…]` 字样，`replace` 会命中**插入内容里
 * 的那处**（而不是原正文里的），于是卡片内容会被再展开一次 —— 标题是不可信输入，
 * 这是一条能被用户触发的路径。切片按原始区间走，插入什么都不会被重扫。
 *
 * 三处行为与既有的引用类型对齐：
 *   · 超出 max 的引用既不请求也不替换，原样留在正文里（静默保留字面量，不报错）；
 *   · `htmlById` 里查不到的 id 保留字面量（fail-closed）；
 *   · 同一个 id 出现多次时每处都替换，且每一处都占一个名额（确定性，与正文一一对应）。
 */
export function replaceFavoriteRefs(
  text: string,
  slots: FavoriteRefSlot[],
  htmlById: Map<string, string>,
  max: number = MAX_FAVORITE_REFS
): string {
  // 按起点排序后单向走一遍 —— 替换长度与原文长度不同，边改边走会让后续下标失效
  const ordered = [...slots].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  let used = 0;
  for (const slot of ordered) {
    if (used >= max) break;
    const html = htmlById.get(slot.id);
    if (html === undefined) continue;
    out += text.slice(cursor, slot.start) + html;
    cursor = slot.start + slot.match.length;
    used += 1;
  }
  return out + text.slice(cursor);
}
