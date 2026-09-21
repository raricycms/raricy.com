// ─────────────────────────────────────────────────────────────────────────────
// user-refs.ts — 用户名片引用语法 `[@用户/<用户名>]` 的**纯逻辑**
//
// 【它长什么样】正文里写 `[@用户/张三]`，渲染出来是一枚**行内名片**：带头像框的头像
// + 用户名，整体是一个指向 /u/<id> 的链接。讨论区与评论区共用同一条管线，所以两处
// 一起生效；博客正文走另一条异步管线（MarkdownRenderer 的 ContentRefProcessor），
// 那边**不认**（`\[@\s*(\w+)\s*\]` 里的 `\w` 不含 `/`），`[@用户/张三]` 原样显示字面量
// —— 与「表情只在评论与讨论生效」是同一类有意的口径差异。
//
// 【为什么 token 用用户名而不是 uuid】可读、能手打，而且**用户名在本站不可改**
// （registerUser / createUserAdmin 之后没有任何写入路径），所以引用不会因为改名失效。
// 代价是解析要按名字查一次接口（见 src/app/api/users/[id]/route.ts）。
//
// 【为什么必须自己有一趟 DOM 构造，而不是像收藏夹卡片那样拼 HTML 字符串】
// 评论/讨论的白名单里**没有 `img`、没有 `class`**（见 src/lib/chat-markdown.ts 的
// ALLOWED_TAGS / ALLOWED_ATTR）—— 拼出来的卡片会被 DOMPurify 静默剥成一张白板。
// 所以本文件与 content-refs.ts / sticker-refs.ts 同构：在 rich-text.ts 的 render()
// 里、**净化之后**用 createElement 建节点。能出现的图片只有我们自己构造的站内地址。
//
// 【★ 一个 `\s*` 都不能有 ★】与 sticker-refs.ts 那条纪律逐字同源：extractMentions
// 的正则是 `/@([\p{L}\p{N}_-]{1,20})(?=\s|$)/gu`，它跑在**原始正文**上。段内若允许
// 空白，`[@用户 张三]` 里的 `@用户 ` 正好满足 lookahead → 凭空给一个叫「用户」的人
// 发通知。token 不含空白，这条路才不存在。
//
// 【★ `用户` 是保留合集名 ★】`[@用户/张三]` 的形状与表情 `[@合集/表情]` 完全同构，
// STICKER_REF_RE 本来会把它当成一个叫「用户」的合集（于是预览里变成 `[表情]`、渲染时
// 还会去请求 /api/stickers/用户/张三）。解法是**表情那条正则自己让开**：它带一条
// `(?!用户/)` 的负向先行断言，常量从本文件引（USER_CARD_COLLECTION）。连带地，
// sticker-service 的扫盘也不会列出这个合集 —— 站长给合集起名「用户」是无效的，
// 这条代价写在 docs/guide/表情包使用指南.md 里。
//
// 【查不到 / 超预算怎么办】原样保留字面量（fail-closed，不报错）—— 与 8 位剪贴板
// 超出 1 条、表情超出 30 个的行为一致。
//
// 本文件零依赖（只 import 头像地址的纯函数），不碰 React，故可直接单测
// （tests/unit/user-refs.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

import { avatarUrl } from './avatar-refs';

/**
 * 名片的**保留合集名**（表情语法里的第一段）。
 *
 * 【为什么这个常量住在这里】它是「用户名片」这件事的一部分，而 sticker-refs.ts 是
 * 要**让开**的一方 —— 常量跟着语法走，那边 import 过去用（依赖方向：表情 → 名片，
 * 没有环）。
 */
export const USER_CARD_COLLECTION = '用户';

/** 用户名长度上下限，与 user-service.validateUsername 逐字一致。 */
const NAME_MIN = 3;
const NAME_MAX = 20;

/**
 * 用户名段的正则形态：两端是字母/数字，中间可含 `_` 与 `-`。
 *
 * ⚠️ **必须与 src/lib/user-service.ts 的 validateUsername 对齐**，但那个文件拖着
 * prisma（client 侧 import 它会炸构建），所以规则只能复制一份。两边的一致性由
 * tests/unit/user-refs.test.ts 里一条**逐例对照**的用例钉着（拿同一批样本同时过
 * 两边，断言判定相同）。
 *
 * 【为什么要连「不能以 _ / - 起止」也写进正则】不写的话 `[@用户/-abc-]` 会被认成
 * 名片 token、去请求一次接口、然后失败 —— 结果一样但多一次无谓请求，而且「看起来
 * 合法却永远不生效」是最难查的一类。收紧到只匹配真实可能的用户名，语义就干净了。
 *
 * 【为什么不含 `\s`】见文件头那条纪律。
 */
const EDGE = '[\\p{L}\\p{N}]';
const MID = '[\\p{L}\\p{N}_-]';
const NAME = `${EDGE}(?:${MID}{${NAME_MIN - 2},${NAME_MAX - 2}}${EDGE})`;

/**
 * 匹配 `[@用户/张三]`（全局版，一次替换全部）。
 *
 * 段字符集是**白名单**，`]` 不在其中 —— 才让 `[@用户/a] 和 [@用户/b]` 不可能被一个
 * 匹配吞掉（否则第一段会一路吃到 `] 和 [@用户`）。
 */
export const USER_REF_RE = new RegExp(`\\[@${USER_CARD_COLLECTION}/(${NAME})\\]`, 'gu');

/** 同上，非全局 —— 只问「这个字符串里有没有」，避免 `lastIndex` 残留。 */
export const USER_REF_PROBE = new RegExp(`\\[@${USER_CARD_COLLECTION}/(${NAME})\\]`, 'u');

/**
 * 内联名片的类名（净化后由我们自己的代码添加，用户伪造不了）。
 *
 * 与 rich-image-ref / rich-sticker-ref 并列。**不与它们任何一个共用**：
 * RichContentBody 的点击委托按 `rich-image-ref` 判定「点开原图」，共用会让点名片
 * 弹出一张不属于它的大图。
 */
export const USER_REF_CLASS = 'rich-user-ref';

/**
 * 头像盒子的类名 —— 与 `avatar` 一起叠在同一个 <span> 上。
 *
 * 【为什么必须同时带 `avatar`】头像框那套样式挂在 `.avatar` / `.avatar > img.avatar__frame`
 * 上（src/styles-scss/components/_avatar.scss）。少了 `avatar`，框会被别的 img 规则
 * 压掉 —— 而那**不报错**，只是这张名片永远没有框。
 */
export const USER_REF_AVATAR_CLASS = 'rich-user-ref__avatar';

/** 用户名文本的类名。 */
export const USER_REF_NAME_CLASS = 'rich-user-ref__name';

/**
 * 一条消息里最多展开几张名片（超出部分保留字面量）。
 *
 * 【为什么是 5】名片是**行内**的、一行高，5 张排下来差不多是一段话的长度，再多就是
 * 刷屏；而且每张都要落一次 `/api/users/<名字>`（有缓存，但首次仍是一次请求）。上限取成
 * 正文的**确定性函数**（同样正文 → 同样结果），与 MAX_IMAGE_REFS / MAX_STICKER_REFS 同口径。
 *
 * 【为什么与表情的 30 分开计】共用一个预算会让「消息里既有名片又有表情」时的行为
 * 变得难以解释（谁占谁的额度）。分开则各管各的。
 */
export const MAX_USER_REFS = 5;

/**
 * 名片渲染所需的公开数据（由 GET /api/users/<id 或用户名> 提供）。
 *
 * 【为什么没有头像地址】`/api/avatar/<id>` 是恒定可推导的（那条路由**永不 404**，
 * 读不到文件就生成 identicon），所以由 `avatarUrl(id)` 现拼，不必跟着 DTO 走。
 */
export interface UserCardData {
  id: string;
  username: string;
  /** 头像框贴图地址；null = 没戴 / 已过期 / 素材缺失。**判定已在服务层做完**（frameUrlFor）。 */
  frameUrl: string | null;
}

/**
 * 挑出正文里**值得去查**的用户名（去重、保持出现顺序、最多 MAX_USER_REFS 个）。
 *
 * 【为什么要有上限】调用方要按名字逐个取资料。正文里塞 500 个 token 时，无脑全查
 * 等于让一条 10 字的短消息打出几百次请求。上限与 embedUserRefs 的预算同值 ——
 * 多查的那些反正也不会被渲染。
 *
 * 【为什么要去重】同一个人的名片在一条消息里出现多次只查一次（渲染时每处仍各占
 * 一个名额，与表情那条口径一致）。
 *
 * ★ 每次调用新建正则 ★ 全局正则的 lastIndex 会在多次 exec 之间残留，复用同一个实例
 * 会让第二次调用从上次的位置继续（content-refs.ts 的 embedImageRefs 记着同一条）。
 */
export function collectUserCardNames(text: string, max: number = MAX_USER_REFS): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(USER_REF_RE.source, 'gu'))) {
    if (names.length >= max) break;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    names.push(m[1]);
  }
  return names;
}

/**
 * 把 token 换成可读的 `@张三` —— 给**预览 / 摘要**用（侧栏、引用块、@ 通知正文），
 * 与 `[图片]` / `[博客]` / `[表情]` 同口径。
 *
 * 换成 `@名字` 而不是某个固定词，是因为这三个地方本来就是「一行摘要」，看得懂谁被
 * 提到了才有意义。
 *
 * ⚠️ 调用方必须**先**剥名片再剥表情（chat-service.ts 的三处）：表情那条正则虽然已经
 * 让开了 `用户` 这个合集名，但顺序写死，读的人不用去推理那层保证。
 */
export function stripUserCardTokens(text: string): string {
  return text.replace(new RegExp(USER_REF_RE.source, 'gu'), (_m, name: string) => `@${name}`);
}

// ── 渲染（需要 DOM，与 content-refs.ts 的 embedImageRefs 同构）────────────────

/**
 * 把一张名片建成 DOM。
 *
 * ★ 动态文本一律走 textContent ★ 用户名是**不可信输入**（虽然注册时过了字符白名单，
 * 但那是另一层的事）—— 拼 innerHTML 等于把到手的内容又交还给解析器，正是
 * blog-markdown.ts 文件头那次存储型 XSS 的成因。
 *
 * 产出的 DOM 与 `<Avatar>` 组件**逐字同构**（`avatar` 盒子 + `avatar__img` +
 * `avatar__frame`），否则 `_avatar.scss` 里那套按 `.avatar > img.avatar__frame`
 * 写的规则（权重 (0,2,1)，专门压过各站点的 `img { object-fit: cover }`）不生效 ——
 * 症状是这张名片里的框被裁掉，而且不报错。
 *
 * 链接目标只有一种形态 `/u/<uuid>`，id 来自接口（不是正文里的字符串），不参与拼接。
 */
export function buildUserCardElement(doc: Document, data: UserCardData): HTMLAnchorElement {
  const link = doc.createElement('a');
  link.className = USER_REF_CLASS;
  link.setAttribute('href', `/u/${data.id}`);
  // 悬停给一句人话（与「访问个人主页」同义）；名字本身就在旁边，所以头像图是装饰。
  link.setAttribute('title', `访问 ${data.username} 的主页`);

  const box = doc.createElement('span');
  box.className = `avatar ${USER_REF_AVATAR_CLASS}`;

  const img = doc.createElement('img');
  img.className = 'avatar__img';
  // 头像地址只能走 avatarUrl —— 全仓唯一允许拼 /api/avatar/ 的地方
  //（tests/unit/avatar-sites-guard.test.ts 判据 1 静态盯着）。
  img.setAttribute('src', avatarUrl(data.id));
  // alt 留空：名字就在紧挨着的文本里，屏读器再念一遍头像是噪音（与头像框同一口径）。
  img.setAttribute('alt', '');
  // 与表情同口径：定死尺寸由 CSS 给，所以懒加载不会引起跳版
  img.setAttribute('loading', 'lazy');
  box.appendChild(img);

  if (data.frameUrl) {
    const frame = doc.createElement('img');
    frame.className = 'avatar__frame';
    frame.setAttribute('src', data.frameUrl);
    // alt 留空 + aria-hidden：纯装饰（与 Avatar.tsx 里那两层逐字一致）
    frame.setAttribute('alt', '');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('draggable', 'false');
    box.appendChild(frame);
  }

  const name = doc.createElement('span');
  name.className = USER_REF_NAME_CLASS;
  name.textContent = data.username;

  link.appendChild(box);
  link.appendChild(name);
  return link;
}

/**
 * 把**已净化**文本节点里的 `[@用户/<用户名>]` 换成内联名片。
 *
 * 与 content-refs.ts 的 embedImageRefs / sticker-refs.ts 的 embedStickerRefs 逐条同构，
 * 此处只记差异与理由：
 *
 *   · 三处跳过（父节点是 `A` / `CODE` / `PRE`）与那两条逐字相同：CODE/PRE 让用户写得
 *     出字面量（能在文档里展示这个语法本身），A 避免 `[[@用户/张三]](/blog/1)` 那种
 *     写法变成 `<a>` 里套 `<a>`。
 *   · **cards 为空直接返回** —— 数据还没取到（或者这条消息压根没有名片）时整趟不跑。
 *     这是安全的：表情那条正则带 `(?!用户/)`，不会替我们把 token 吃掉，字面量就留在
 *     原地。等数据到了，RichContentBody 会带着新的 cards 重渲染一次。
 *   · **超预算 / 查不到的名字原样留字面量**（fail-closed，与其他引用同口径）。
 *   · 数据会变（改简介 / 换框 / 框到期），所以带名片 token 的正文**不进渲染缓存** ——
 *     见 rich-text.ts 里那条 cacheable 判断。
 */
export function embedUserRefs(root: HTMLElement, cards: Map<string, UserCardData> | undefined): void {
  if (!cards || cards.size === 0) return;

  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
      // walker 是 SHOW_TEXT，所以拿到的一定是 Text
      return USER_REF_PROBE.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let budget = MAX_USER_REFS;
  for (const node of nodes) {
    if (budget <= 0) break;
    // 每个文本节点用一个新正则：全局正则的 lastIndex 会在多次 exec 之间残留。
    const re = new RegExp(USER_REF_RE.source, 'gu');
    const frag = doc.createDocumentFragment();
    let last = 0;
    let replaced = 0;
    for (const m of node.data.matchAll(re)) {
      const at = m.index ?? 0;
      const data = budget > 0 ? cards.get(m[1]) : undefined;
      if (at > last) frag.appendChild(doc.createTextNode(node.data.slice(last, at)));
      if (data) {
        frag.appendChild(buildUserCardElement(doc, data));
        budget -= 1;
        replaced += 1;
      } else {
        // 查不到 / 超预算：原样留字面量。**不占预算** —— 没渲染出来的东西不该吃掉
        // 后面那些本来画得出来的名片的名额。
        frag.appendChild(doc.createTextNode(m[0]));
      }
      last = at + m[0].length;
    }
    // 一个都没换成名片就不动这个节点（别把好好的文本节点白白重建一遍）
    if (replaced === 0) continue;
    if (last < node.data.length) frag.appendChild(doc.createTextNode(node.data.slice(last)));
    node.replaceWith(frag);
  }
}
