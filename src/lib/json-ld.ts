// ─────────────────────────────────────────────────────────────────────────────
// json-ld.ts — 结构化数据（schema.org）的安全出口
//
// 【为什么必须收成一个函数】JSON-LD 只能靠 `dangerouslySetInnerHTML` 注入
// `<script type="application/ld+json">`。而本站**没有任何 CSP**（next.config.mjs
// 与 src/middleware.ts 里都没有内容安全策略，已核实），所以转义写错时**没有任何
// 响应头兜底**：一个含 `</script>` 的**文章标题**就能提前闭合脚本块，把后面的内容
// 变成页面上的 HTML —— 而文章页恰恰是对外**可索引**的，等于把一发 XSS 印在公网上。
//
// 正文里实打实有 XSS 演示内容（见 src/app/blog/page.tsx 关于正文片段渲染的注释），
// 标题同样来自用户输入 —— 这不是假想威胁。
//
// 所以：**别在 JSX 里手写 dangerouslySetInnerHTML**，一律过这里。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把对象序列化成能安全塞进 `<script type="application/ld+json">` 的字符串。
 *
 * 【为什么一条 `<` 就够】HTML 解析器只看 `</script`（大小写不敏感）来决定脚本块在
 * 哪结束，所以把每一个 `<` 转义掉就足以堵死那条路 —— 而 `JSON.parse` 读回来完全
 * 一样（`\u003c` 是合法的 JSON 转义，不是我们发明的方言）。
 *
 * U+2028 / U+2029 是补强：它们**在 JSON 里合法**，但这段内容哪天若被当成 JS 字面量
 * 解析就会断行。转义它们零成本，顺手做掉。
 *
 * ⚠️ 要加新的转义就加在这里，别加在调用点 —— 一旦有两处，就会有第三处漏掉。
 */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
}
