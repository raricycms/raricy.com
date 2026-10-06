// 评论与讨论共用的 @ 词汇；零依赖，客户端也可直接使用。
// 尾随空白或行尾是既有边界：@bob 不匹配 @bobby，名片 / 表情 token 也不算提及。
export function extractMentions(content: string): string[] {
  const names = new Set<string>();
  const re = /@([\p{L}\p{N}_-]{1,20})(?=\s|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) names.add(match[1]);
  return [...names];
}
