// 公开正文检索：写入时编译并提取自身静态可见文字，读取时仅查 FTS 候选。
// 不执行表达式、不遍历交互组件内部状态、不读取任何引用；编译失败仅保留元数据搜索。
import { compileSource } from './reactive/compile-source';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { LocalNode } from 'reactive-md';
import { prisma } from './db';
// 公开集合的可见性条件只有一份定义（Prisma where / raw SQL / 内存判断三种载体），
// 见 blog-public-scope.ts 的文件头 —— 别在本文件重新手抄 `visibility IN (...)`。
import {
  PUBLIC_BLOG_SQL,
  PUBLIC_BLOG_WHERE,
  PUBLIC_SEARCH_BLOG_SQL,
  isPublicIndexableBlog,
} from './blog-public-scope';
import { parseContentFormat } from './content-format';
import { REACTIVE_COMPILE_OPTIONS } from './reactive/host-components';
import { currentCompileSignature } from './reactive/compile-identity';

// 改正文提取规则时递增基础版本；包 / 语法 / 兼容规则 / 选项变化自动进入组合版本。
export const PUBLIC_SEARCH_BASE_VERSION = 'public-body/3';

/** 独立索引的失效身份，不依赖数据库快照或 SQL 迁移。 */
export const PUBLIC_SEARCH_VERSION = JSON.stringify([
  PUBLIC_SEARCH_BASE_VERSION,
  currentCompileSignature(),
]);
export type SearchAvailability = 'ready' | 'metadata-only' | 'partial';

/** 编码为纯 ASCII FTS 词项；用户输入无法注入 MATCH 运算符。 */
export function searchTerms(text: string, query = false): string {
  const terms = Array.from(text.toLowerCase(), c => 'u' + c.codePointAt(0)!.toString(16)).join(' ');
  // 每个 Unicode 字符一个词项，FTS 位置索引负责连续短语；单字和英文子串同样可查。
  return query ? '"' + terms + '"' : terms;
}

const TEXT = new Set(['text', 'inlineCode', 'code', 'math', 'inlineMath']);
const CONTAINERS = new Set(['root', 'heading', 'paragraph', 'emphasis', 'strong', 'delete', 'underline', 'mark', 'sup', 'sub', 'span', 'div', 'details', 'summary', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'tableCell', 'link', 'footnoteDefinition']);

/** 没有读者可见正文的组件 / 宿主节点；其余组件的子节点继续取文字。 */
const SKIPPED_COMPONENTS = new Set(['computed', 'const', 'validation', 'site-embed', 'if']);
export async function publicBodyText(source: string, rawFormat: unknown): Promise<{ text: string; status: 'ready' | 'missing' }> {
  const format = parseContentFormat(rawFormat);
  if (!format) return { text: '', status: 'missing' };
  try {
    const result = compileSource(source, REACTIVE_COMPILE_OPTIONS);
    if (!result.ok) return { text: '', status: 'missing' };
    const visit = (node: LocalNode): string => {
      // fallback / htmlDocument / hostComponent / interpolation 均不取源码或状态；
      // 普通容器组件（panel / card / tabs …）的可见子正文必须继续递归。
      if (TEXT.has(node.type)) return node.value || '';
      if (node.type === 'component') {
        if (SKIPPED_COMPONENTS.has(node.name ?? '')) return ' ';
        return (node.children || []).map(visit).join('');
      }
      if (!CONTAINERS.has(node.type)) return ' ';
      const separator = ['paragraph','heading','list','listItem','tableRow','tableCell','blockquote','div'].includes(node.type) ? '\n' : '';
      return (node.children || []).map(visit).join('') + separator;
    };
    const text = result.document.nodes.map(visit).join('\n')
      .replace(/\[@[^\]\n]+\]/g, ' ')
      // compat 的历史媒体 token 是内部协议，不进公开索引 / 片段。
      .replace(/\[\[媒体:[a-f0-9]{10}\]\]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return { text, status: 'ready' };
  } catch { return { text: '', status: 'missing' }; }
}

/** 写入与索引编译分开；事务内复核原文，防慢编译把更新后的版本盖回去。 */
export async function syncPublicBlogSearch(blogId: string, db: PrismaClient = prisma): Promise<void> {
  const row = await db.blog.findUnique({ where: { id: blogId }, include: { content: true } });
  if (!row || !isPublicIndexableBlog(row) || !row.content) {
    await db.$transaction([db.$executeRaw`DELETE FROM public_blog_search WHERE blog_id = ${blogId}`, db.$executeRaw`DELETE FROM public_blog_search_state WHERE blog_id = ${blogId}`]);
    return;
  }
  const source = row.content.content;
  const format = row.content.format;
  const body = await publicBodyText(source, format);
  const tokens = searchTerms(body.text);
  const version = PUBLIC_SEARCH_VERSION;
  await db.$transaction(async tx => {
    const current = await tx.blog.findUnique({ where: { id: blogId }, include: { content: true } });
    if (!current || !isPublicIndexableBlog(current) || current.content?.content !== source || current.content?.format !== format) return;
    await tx.$executeRaw`DELETE FROM public_blog_search WHERE blog_id = ${blogId}`;
    await tx.$executeRaw`INSERT INTO public_blog_search(rowid,blog_id,body,folded,tokens,version,body_status)
      SELECT rowid,id,${body.text},${body.text.toLowerCase()},${tokens},${version},${body.status}
      FROM blogs WHERE id=${blogId}`;
    await tx.$executeRaw`INSERT OR REPLACE INTO public_blog_search_state(blog_id,version,body_status) VALUES(${blogId},${version},${body.status})`;
  });
}

/** 索引故障不回滚已提交文章；查询会明确显示降级范围。 */
export async function refreshPublicBlogSearch(blogId: string): Promise<void> {
  try { await syncPublicBlogSearch(blogId); }
  catch (error) { console.error('[public-search] 索引更新失败', { blogId, error: error instanceof Error ? error.name : 'unknown' }); }
}

export async function rebuildPublicBlogSearch(db: PrismaClient = prisma) {
  const rows = await db.blog.findMany({ where: PUBLIC_BLOG_WHERE, select: { id: true } });
  for (const row of rows) await syncPublicBlogSearch(row.id, db);
  // 用同一个片段判断「哪些索引行不再属于公开集合」（子查询里 blogs 别名必须是 b）。
  await db.$executeRaw`DELETE FROM public_blog_search WHERE blog_id NOT IN (SELECT b.id FROM blogs b WHERE ${PUBLIC_BLOG_SQL})`;
  return rows.length;
}

export async function searchPublicBlogIds(tx: Prisma.TransactionClient, q: string, categoryIds: number[] | null, page: number, perPage: number) {
  // 公开集合（含 raw SQL 对归档作者的补偿）—— 唯一定义见 blog-public-scope.ts。
  const publicWhere = PUBLIC_SEARCH_BLOG_SQL;
  const version = PUBLIC_SEARCH_VERSION;
  const coverage = await tx.$queryRaw<{ missing: bigint; partial: bigint }[]>`SELECT
    SUM(CASE WHEN p.blog_id IS NULL OR p.version != ${version} THEN 1 ELSE 0 END) AS missing,
    SUM(CASE WHEN p.body_status = 'missing' THEN 1 ELSE 0 END) AS partial
    FROM blogs b JOIN users u ON u.id=b.author_id LEFT JOIN public_blog_search_state p ON p.blog_id=b.id WHERE ${publicWhere}`;
  const availability: SearchAvailability = Number(coverage[0]?.missing || 0) > 0 ? 'metadata-only' : Number(coverage[0]?.partial || 0) > 0 ? 'partial' : 'ready';
  const folded = q.toLowerCase();
  const bodyMatches = availability === 'metadata-only' ? Prisma.sql`SELECT -1 AS rowid` : Prisma.sql`SELECT rowid FROM public_blog_search
    WHERE public_blog_search MATCH ${searchTerms(folded, true)} AND version=${version} AND body_status='ready'`;
  const meta = Prisma.sql`instr(lower(b.title),${folded})>0 OR instr(lower(b.description),${folded})>0 OR instr(lower(u.username),${folded})>0`;
  const filter = Prisma.sql`${publicWhere} AND (${meta} OR b.rowid IN (${bodyMatches}))
    ${categoryIds ? Prisma.sql`AND b.category_id IN (${Prisma.join(categoryIds.length ? categoryIds : [-1])})` : Prisma.empty}`;
  const counts = await tx.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM blogs b JOIN users u ON u.id=b.author_id WHERE ${filter}`;
  const hits = await tx.$queryRaw<{ id: string; snippet: string | null }[]>`SELECT ranked.id,
    CASE WHEN ${availability !== 'metadata-only'} AND p.version=${version} AND p.body_status='ready' AND instr(p.folded,${folded})>0 THEN substr(p.body,MAX(1,instr(p.folded,${folded})-55),180) ELSE NULL END AS snippet
    FROM (SELECT b.rowid AS blogrow,b.id FROM blogs b JOIN users u ON u.id=b.author_id
      WHERE ${filter}
      ORDER BY (CASE WHEN instr(lower(b.title),${folded})>0 THEN 8 ELSE 0 END
        + CASE WHEN instr(lower(b.description),${folded})>0 THEN 4 ELSE 0 END
        + CASE WHEN instr(lower(u.username),${folded})>0 THEN 2 ELSE 0 END) DESC, b.created_at DESC,b.id DESC
      LIMIT ${perPage} OFFSET ${(page-1)*perPage}
    ) ranked LEFT JOIN public_blog_search p ON p.rowid=ranked.blogrow AND p.blog_id=ranked.id`;
  return { hits, total: Number(counts[0].count), availability };
}
