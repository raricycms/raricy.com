/** 去掉 UTF-8 BOM 与 YAML frontmatter：引擎本身不认头部（会当正文渲染）。 */
export function stripFrontmatter(source: string): string {
  const text = source.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return text;
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? text.slice(match[0].length) : text;
}
