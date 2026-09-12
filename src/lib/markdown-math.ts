// ─────────────────────────────────────────────────────────────────────────────
// markdown-math.ts — 数学公式在 Markdown 渲染管线里的「保护 / 还原」两步。
//
// 【为什么需要】公式里的 `_ * \ $` 全是 Markdown 元字符（`x_1` 会被吃成斜体、
// `a*b*c` 变强调、`\\` 变换行），所以正文进 marked 之前先把 `$…$` 等四组定界符
// 整体换成占位符，marked 渲染完再把原文放回去。MathJax 只在最后一步扫描 DOM。
//
// 【为什么要单独成模块】还原这一步踩过两个坑，且都属于「看起来能用、只在特定
// 内容上炸」的类型，只有单测盯得住（tests/unit/markdown-math.test.ts）：
//
//   1. 替换串里的 `$` 会被 String.replace 当特殊语义。用 `str.replace(re, '$$x$$')`
//      还原，得到的是 `$x$` —— 块级公式被降级成行内；若公式还跨行（cases/aligned
//      必然跨行），渲染层的 hasMath 正则 `\$[^$\n]+\$` 也匹配不上，于是整页一次
//      MathJax 都不跑，公式以原始 `$…$` 文本显示。修法：函数式替换（返回值不做
//      替换串解析）。对齐 ContentRefProcessor 里已有的同款写法。
//
//   2. 还原出来的公式是直接拼进 HTML 的，未转义的 `<` `&` 会被 HTML 解析器吃掉：
//      `$$a<b$$` 里的 `<b$$` 被当成未闭合标签，DOMPurify 一净化，公式只剩半截。
//      修法：还原时转义 `& < >`（文本节点语义，解析回来即原字符）。
// ─────────────────────────────────────────────────────────────────────────────

/** 四组定界符，顺序即优先级：先块级后行内，避免 `$$` 被 `$…$` 抢先配对。 */
const MATH_RULES: ReadonlyArray<{ re: RegExp; prefix: string }> = [
  { re: /\$\$([\s\S]*?)\$\$/g, prefix: 'MATHBLOCK' },
  { re: /\\\[([\s\S]*?)\\\]/g, prefix: 'MATHLATEXB' },
  { re: /\$([^$\n]+?)\$/g, prefix: 'MATHINLINE' },
  { re: /\\\(([\s\S]*?)\\\)/g, prefix: 'MATHLATEXI' },
];

export interface ProtectedMath {
  /** 公式被换成占位符后的文本，可直接交给 marked。 */
  text: string;
  /** 占位符 → 公式原文（含定界符）。 */
  placeholders: Map<string, string>;
  /** 抽出的公式数量。渲染层用它决定要不要跑 MathJax —— 比在渲染后的 HTML 上
   *  正则嗅探可靠：跨行公式、被 Markdown 改动过的公式都骗不过计数器。 */
  count: number;
}

/** 把正文里的公式换成占位符（进 marked 之前调用）。 */
export function protectMath(text: string): ProtectedMath {
  const placeholders = new Map<string, string>();
  let out = text;
  let n = 0;
  for (const { re, prefix } of MATH_RULES) {
    out = out.replace(re, (m) => {
      const p = `${prefix}${n++}PLACEHOLDER`;
      placeholders.set(p, m);
      return p;
    });
  }
  return { text: out, placeholders, count: n };
}

/** 文本节点里会破坏 HTML 结构的三个字符。 */
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把占位符还原成公式原文（marked 渲染之后、DOMPurify 净化之前调用）。
 *
 * ⚠️ 必须用函数式替换：返回值按字面插入，不解析 `$&`/`$$` 等替换模式。
 * 公式原文做 HTML 转义后再拼回，见文件头注释第 2 条。
 */
export function restoreMath(html: string, placeholders: Map<string, string>): string {
  let out = html;
  for (const [p, math] of placeholders) {
    out = out.replace(new RegExp(p, 'g'), () => escapeHtmlText(math));
  }
  return out;
}
