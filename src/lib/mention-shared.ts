// 评论与讨论共用的 @ 词汇；零依赖，客户端也可直接使用。
// 尾随空白或行尾是既有边界：@bob 不匹配 @bobby，名片 / 表情 token 也不算提及。
export function extractMentions(content: string): string[] {
  const names = new Set<string>();
  const re = /@([\p{L}\p{N}_-]{1,20})(?=\s|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) names.add(match[1]);
  return [...names];
}

export type MentionScope = { kind: 'comment' | 'chat'; id: string };
export interface MentionUser { id: string; username: string }

/** 光标所在的未完成 @；不在邮件、名片 / 表情 token 或选区内弹提示。 */
export function activeMention(text: string, start: number, end = start) {
  if (start !== end || start < 0 || start > text.length) return null;
  const match = /(?:^|\s)@([\p{L}\p{N}_-]{0,20})$/u.exec(text.slice(0, start));
  if (!match) return null;
  const suffix = /^[\p{L}\p{N}_-]*/u.exec(text.slice(start))![0];
  if (match[1].length + suffix.length > 20) return null;
  const tokenEnd = start + suffix.length;
  if (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) return null;
  return { query: match[1], start: start - match[1].length - 1, end: tokenEnd };
}
