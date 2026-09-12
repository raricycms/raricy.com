// ─────────────────────────────────────────────────────────────────────────────
// linkify.ts — 纯文本里的 URL 识别（聊天消息正文用）
//
// 【安全前提】只认 `http://` / `https://` 开头的绝对 URL —— `javascript:` / `data:`
// 这类伪协议根本进不了正则，从源头上就构造不出危险链接。渲染侧（ChatMessageItem）
// 再补 `rel="noopener noreferrer" target="_blank"`。
//
// 【为什么不用现成库】只需要「切分纯文本」这一个能力，不需要 Markdown/Autolink 的
// 全部语义；一个正则 + 尾部标点剥离约 40 行，且能被单测完全覆盖。
//
// 【尾标点剥离】中文写作里 URL 常直接跟着句号/逗号（「见 https://a.com/x。」），
// 直接按正则切会把标点吞进 href。这里反复剥离尾部的标点与「多余的」右括号，
// 但保留成对括号（维基那种 .../wiki/Foo_(bar) 要完整保留）。
// ─────────────────────────────────────────────────────────────────────────────

export type LinkifyPart =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCT = /[.,;:!?，。；：！？、]+$/;
// 收尾括号要连全角一起收：中文写作里「见 https://a.com。）」很常见
const CLOSER = /[)\]}>）］｝〉】》」』〕〗]$/;
const OPENER = /[([{（［｛〈【《「『〔〖]/g;
const CLOSER_ALL = /[)\]}>）］｝〉】》」』〕〗]/g;

/** 反复剥离尾部标点；右括号只在「多出来的」时候剥（成对括号属于 URL 本身）。 */
function stripTrailing(url: string): string {
  let s = url;
  for (;;) {
    const before = s;
    s = s.replace(TRAILING_PUNCT, '');
    if (CLOSER.test(s)) {
      const opens = (s.match(OPENER) ?? []).length;
      const closes = (s.match(CLOSER_ALL) ?? []).length;
      if (closes > opens) s = s.slice(0, -1);
    }
    if (s === before) return s;
  }
}

/**
 * 把纯文本切成「文本 / 链接」片段。没有链接时返回单个 text 片段。
 * 片段顺序即原文顺序，拼回去与原文等长（渲染端按片段依次输出即可）。
 */
export function linkify(text: string): LinkifyPart[] {
  if (!text) return [];
  const parts: LinkifyPart[] = [];
  let cursor = 0;
  URL_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = stripTrailing(m[0]);
    const start = m.index;
    if (!url || start < cursor) continue; // 剥离后为空 / 与上一段重叠 → 跳过
    if (start > cursor) parts.push({ type: 'text', text: text.slice(cursor, start) });
    parts.push({ type: 'link', text: url, href: url });
    cursor = start + url.length;
    // 把扫描指针拉回剥离后的位置：被剥掉的标点要作为普通文本被下一段收走
    URL_RE.lastIndex = cursor;
  }

  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
}
