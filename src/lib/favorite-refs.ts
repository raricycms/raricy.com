// ─────────────────────────────────────────────────────────────────────────────
// favorite-refs.ts — 收藏夹引用语法 `[@<六位收藏夹ID>]` 的**纯逻辑**（id 词汇 + 盖码）
//
// 【在哪条管线上】reactive 渲染链（src/lib/reactive/ref-adapter.ts 与
// client-compile.ts / ref-reader.ts）认 6 位收藏夹；评论与讨论走另一条同步管线
// （src/lib/rich-text.ts），**刻意不认** —— 与 9 位投票「只识别不展开」的先例同向：
// 那里是不展开，这里是压根不认，原样保留字面量。理由：讨论气泡里塞一个长列表没有
// 意义，且这样私密收藏夹的 id 永远不会出现在别人写的内容里。
// （旧 Markdown 管线退役后，卡片 HTML 由 components/reactive/site-embed-static.tsx
//  的 React 渲染器唯一产出；本文件只留 id 词汇、预算常量与盖码工具。）
//
// 【为什么是 6 位】`[@…]` 的分流**只按 id 长度**。已占用：8 剪贴板 / 9 投票 /
// 10 图床 / 12 OAuth app / UUID（博客、评论、用户 —— 含连字符，`\w` 匹配不到）。
// 6 位是唯一空闲长度，与任何现有 id 都不会互相误判。
//
// 【字符集必须是白名单】`[@________]` 这类下划线 token 也凑得出 10 个字符，所以
// 判定必须是 `^[0-9]{6}$` 而不是「长度为 6」—— 6 位**字母**的 token 必须落回
// 字面量，而不是拿去请求一次 API。
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
 * 插入用的 token（`[@123456]`）。
 *
 * ⚠️ **只对有 `public_id` 的公开收藏夹有意义**：私有收藏夹的 `public_id` 恒为
 * NULL（没有句柄，而不是藏起来），所以它压根没有可插入的 id —— 资源面板那边
 * 因此把它列成「不可插入」而不是插一个假的。这里不替调用方兜底：传进来什么就
 * 拼什么，传一个空串会得到 `[@]`，而那个 token 谁都不认、原样留在正文里。
 */
export function favoriteRefToken(publicId: string): string {
  return `[@${publicId}]`;
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

/**
 * 把 Markdown 里的**代码块与行内代码**用等长填充盖掉（只用于扫描，不改原文）。
 *
 * 【为什么需要】reactive 适配器（`ref-adapter.ts`）与版本指令扫描
 * （`version-directive.ts`）都在 **Markdown 源文**上扫 `[@…]` / 指令，而
 * 「写在代码块 / 行内代码里的引用与指令不展开 —— 要展示语法本身时就这么写」是
 * **已对外承诺**的行为。盖码副本里那一段是纯 `x`，扫描自然扫不到。
 *
 * 等长填充而不是删除，是为了让**下标与原文一一对应**，切片时不用做映射。
 *
 * 只处理围栏代码块（``` / ~~~）与单反引号行内代码 —— 缩进式代码块（行首 4 空格）
 * 刻意不管：列表项里的续行也是 4 空格，误盖会吃掉正文里合法的引用。
 */
export function maskMarkdownCode(text: string): string {
  let out = text;
  // 围栏代码块：开围栏与闭围栏的符号串相同（3 个以上反引号或波浪线）
  out = out.replace(/(`{3,}|~{3,})[\s\S]*?\1/g, (m) => 'x'.repeat(m.length));
  // 行内代码：单反引号成对、不跨行（围栏已被盖成 x，这里不会再撞上它们）
  out = out.replace(/`[^`\n]*`/g, (m) => 'x'.repeat(m.length));
  return out;
}
