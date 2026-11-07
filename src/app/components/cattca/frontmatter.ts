/** 去掉 UTF-8 BOM 与 YAML frontmatter：引擎本身不认头部（会当正文渲染）。 */
export function stripFrontmatter(source: string): string {
  const text = source.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return text;
  // 与 src/lib/story-service.ts 的 parseFrontmatter 用同一条正则（R3-517）：开口行
  // `---` 后面允许空格 / 制表符，否则写 `--- ` 的文件在故事页会被剥掉、在 cattca 里
  // 却被当正文渲染 —— 同一份文件两套标准，且不报错。
  const match = text.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? text.slice(match[0].length) : text;
}
