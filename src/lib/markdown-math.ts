// ─────────────────────────────────────────────────────────────────────────────
// markdown-math.ts — 数学公式在 Markdown 渲染管线里的「保护 / 还原」两步。
//
// 【为什么需要】公式里的 `_ * \ $` 全是 Markdown 元字符（`x_1` 会被吃成斜体、
// `a*b*c` 变强调、`\\` 变换行），所以正文进 marked 之前先把 `$…$` 等四组定界符
// 整体换成占位符，marked 渲染完再把原文放回去。MathJax 只在最后一步扫描 DOM。
//
// 【为什么要单独成模块】还原这一步踩过三个坑，且都属于「看起来能用、只在特定
// 内容上炸」的类型，只有单测盯得住（tests/unit/markdown-math.test.ts）：
//
//   1. 替换串里的 `$` 会被 String.replace 当特殊语义。用 `str.replace(re, '$$x$$')`
//      还原，得到的是 `$x$` —— 块级公式被降级成行内；若公式还跨行（cases/aligned
//      必然跨行），渲染层的 hasMath 正则 `\$[^$\n]+\$` 也匹配不上，于是整页一次
//      MathJax 都不跑，公式以原始 `$…$` 文本显示。修法：函数式替换（返回值不做
//      替换串解析）。对齐 content-ref-processor.ts 里已有的同款写法。
//
//   2. 还原出来的公式是直接拼进 HTML 的，未转义的 `<` `&` 会被 HTML 解析器吃掉：
//      `$$a<b$$` 里的 `<b$$` 被当成未闭合标签，DOMPurify 一净化，公式只剩半截。
//      修法：还原时转义 `& < >`（文本节点语义，解析回来即原字符）。
//
//   3. **围栏 / 行内代码里的成对 `$$` 也会被抽走**：marked 之后代码块渲染器把原文
//      写进复制按钮的 `data-code` 属性（`encodeURIComponent` 只编码它自己拿到的那份，
//      占位符是纯字母数字，编不出区别），而还原是对**整份 HTML** 做字符串替换 ——
//      公式原文于是直接落进属性值里。公式含 `"` 时属性提前结束，复制按钮拿到的内容
//      被截断（余下片段被 DOMPurify 按白名单裁掉，不构成注入升级）。修法有两半：
//      · 保护阶段用 `maskMarkdownCode`（等长盖码，与音频 / 收藏夹同一口径）找出代码区，
//        **只对代码区之外的片段**抽公式 —— 代码块里的 `$$` 原样留给 marked 与
//        `encodeURIComponent`；
//      · 还原阶段连 `"` `'` 一起转义，这样万一占位符落在任何属性上下文里，
//        属性值也不会被截断（文本节点里 `&quot;` 解析回来仍是 `"`，显示不变）。
// ─────────────────────────────────────────────────────────────────────────────

import { maskMarkdownCode } from './favorite-refs';

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

/**
 * 代码区间（围栏 / 行内代码）的 `[start, end)` 列表。
 *
 * `maskMarkdownCode` 用等长填充盖住代码区（见 favorite-refs.ts），所以「mask 副本与
 * 原文不同的连续区间」就是代码区，且下标一一对应、不需要额外映射。
 *
 * ⚠️ 填充字符是 `x`：代码里本来就有 `x` 时那一格与原文相同，会把一段代码拆成几段。
 * 这不影响判据 —— 公式的定界符是 `$` / `\`，永远不会被 `x` 盖成相同字符，所以任何
 * 一个在代码里的定界符仍落在某个区间内。
 */
function codeRanges(text: string): Array<readonly [number, number]> {
  const masked = maskMarkdownCode(text);
  const ranges: Array<readonly [number, number]> = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const covered = masked[i] !== text[i];
    if (covered && start < 0) start = i;
    else if (!covered && start >= 0) {
      ranges.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, text.length]);
  return ranges;
}

/** 把正文里（代码区之外）的公式换成占位符（进 marked 之前调用）。 */
export function protectMath(text: string): ProtectedMath {
  const placeholders = new Map<string, string>();
  let count = 0;

  /** 只处理一段**不含代码**的片段；规则顺序与原实现相同（块级优先于行内）。 */
  const protectSegment = (segment: string): string => {
    let out = segment;
    for (const { re, prefix } of MATH_RULES) {
      out = out.replace(re, (m) => {
        const p = `${prefix}${count++}PLACEHOLDER`;
        placeholders.set(p, m);
        return p;
      });
    }
    return out;
  };

  const pieces: string[] = [];
  let cursor = 0;
  for (const [start, end] of codeRanges(text)) {
    if (start > cursor) pieces.push(protectSegment(text.slice(cursor, start)));
    pieces.push(text.slice(start, end)); // 代码区原样保留（跳过公式保护）
    cursor = end;
  }
  if (cursor < text.length) pieces.push(protectSegment(text.slice(cursor)));

  return { text: pieces.join(''), placeholders, count };
}

/**
 * 文本 / 属性两栖的转义。
 *
 * 除 `& < >` 外还转义 `"` `'`：还原发生在 marked 之后，占位符可能落在属性值里
 * （最典型的是代码块复制按钮的 `data-code`，见文件头第 3 条）。引号不转义会让属性
 * 提前结束；而文本节点里 `&quot;` / `&#39;` 解析回来就是原字符，显示不变。
 */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把占位符还原成公式原文（marked 渲染之后、DOMPurify 净化之前调用）。
 *
 * ⚠️ 必须用函数式替换：返回值按字面插入，不解析 `$&`/`$$` 等替换模式。
 * 公式原文做 HTML 转义后再拼回，见文件头注释第 2、3 条。
 */
export function restoreMath(html: string, placeholders: Map<string, string>): string {
  let out = html;
  for (const [p, math] of placeholders) {
    out = out.replace(new RegExp(p, 'g'), () => escapeHtmlText(math));
  }
  return out;
}
