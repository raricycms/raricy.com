// 公开正文检索：写入时编译并提取自身静态可见文字，读取时仅查 FTS 候选。
// 不执行表达式、不遍历交互组件内部状态、不读取任何引用；编译失败仅保留元数据搜索。
import { Prisma, type PrismaClient } from '@prisma/client';
import type { LocalNode } from 'reactive-md';
import { prisma } from './db';
import { INDEXABLE_VISIBILITIES } from './blog-visibility';
import { parseContentFormat } from './content-format';
import { reactiveCompileOptions } from './reactive/host-components';

export const PUBLIC_SEARCH_VERSION = 'public-body/1';
export type SearchAvailability = 'ready' | 'metadata-only' | 'partial';

/** 编码为纯 ASCII FTS 词项；用户输入无法注入 MATCH 运算符。 */
export function searchTerms(text: string, query = false): string {
  const terms = Array.from(text.toLowerCase(), c => 'u' + c.codePointAt(0)!.toString(16)).join(' ');
  // 每个 Unicode 字符一个词项，FTS 位置索引负责连续短语；单字和英文子串同样可查。
  return query ? '"' + terms + '"' : terms;
}

const TEXT = new Set(['text', 'inlineCode', 'code', 'math', 'inlineMath']);
const CONTAINERS = new Set(['root', 'heading', 'paragraph', 'emphasis', 'strong', 'delete', 'underline', 'mark', 'sup', 'sub', 'span', 'div', 'summary', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'tableCell', 'link', 'footnoteDefinition']);
export async function publicBodyText(source: string, rawFormat: unknown): Promise<{ text: string; status: 'ready' | 'missing' }> {
  const format = parseContentFormat(rawFormat);
  if (!format) return { text: '', status: 'missing' };
  try {
    const { compileLocal } = await import('reactive-md');
    const result = compileLocal(source, reactiveCompileOptions(format));
    if (!result.ok) return { text: '', status: 'missing' };
    const visit = (node: LocalNode): string => {
      // fallback / htmlDocument / component / hostComponent / interpolation 均不取源码或状态。
      if (TEXT.has(node.type)) return node.value || '';
      if (!CONTAINERS.has(node.type)) return ' ';
      const separator = ['paragraph','heading','list','listItem','tableRow','tableCell','blockquote','div'].includes(node.type) ? '\n' : '';
      return (node.children || []).map(visit).join('') + separator;
    };
    const text = result.document.nodes.map(visit).join('\n')
      .replace(/\[@[^\]\n]+\]/g, ' ').replace(/\s+/g, ' ').trim();
    return { text, status: 'ready' };
  } catch { return { text: '', status: 'missing' }; }
}

/** 写入与索引编译分开；事务内复核原文，防慢编译把更新后的版本盖回去。 */
export async function syncPublicBlogSearch(blogId: string, db: PrismaClient = prisma): Promise<void> {
  const row = await db.blog.findUnique({ where: { id: blogId }, include: { content: true } });
  if (!row || row.ignore || !(INDEXABLE_VISIBILITIES as readonly string[]).includes(row.visibility) || !row.content) {
    await db.$transaction([db.$executeRaw`DELETE FROM public_blog_search WHERE blog_id = ${blogId}`, db.$executeRaw`DELETE FROM public_blog_search_state WHERE blog_id = ${blogId}`]);
    return;
  }
  const source = row.content.content;
  const format = row.content.format;
  const body = await publicBodyText(source, format);
  const tokens = searchTerms(body.text);
  await db.$transaction(async tx => {
    const current = await tx.blog.findUnique({ where: { id: blogId }, include: { content: true } });
    if (!current || current.ignore || !(INDEXABLE_VISIBILITIES as readonly string[]).includes(current.visibility) || current.content?.content !== source || current.content?.format !== format) return;
    await tx.$executeRaw`DELETE FROM public_blog_search WHERE blog_id = ${blogId}`;
    await tx.$executeRaw`INSERT INTO public_blog_search(rowid,blog_id,body,folded,tokens,version,body_status)
      SELECT rowid,id,${body.text},${body.text.toLowerCase()},${tokens},${PUBLIC_SEARCH_VERSION},${body.status}
      FROM blogs WHERE id=${blogId}`;
    await tx.$executeRaw`INSERT OR REPLACE INTO public_blog_search_state(blog_id,version,body_status) VALUES(${blogId},${PUBLIC_SEARCH_VERSION},${body.status})`;
  });
}

/** 索引故障不回滚已提交文章；查询会明确显示降级范围。 */
export async function refreshPublicBlogSearch(blogId: string): Promise<void> {
  try { await syncPublicBlogSearch(blogId); }
  catch (error) { console.error('[public-search] 索引更新失败', { blogId, error: error instanceof Error ? error.name : 'unknown' }); }
}

export async function rebuildPublicBlogSearch(db: PrismaClient = prisma) {
  const rows = await db.blog.findMany({ where: { ignore: false, visibility: { in: [...INDEXABLE_VISIBILITIES] } }, select: { id: true } });
  for (const row of rows) await syncPublicBlogSearch(row.id, db);
  await db.$executeRaw`DELETE FROM public_blog_search WHERE blog_id NOT IN (SELECT id FROM blogs WHERE visibility IN (${Prisma.join(INDEXABLE_VISIBILITIES)}) AND ignore=0)`;
  return rows.length;
}

export async function searchPublicBlogIds(tx: Prisma.TransactionClient, q: string, categoryIds: number[] | null, page: number, perPage: number) {
  const publicWhere = Prisma.sql`b.visibility IN (${Prisma.join(INDEXABLE_VISIBILITIES)}) AND b.ignore=0 AND u.archived_at IS NULL`;
  const coverage = await tx.$queryRaw<{ missing: bigint; partial: bigint }[]>`SELECT
    SUM(CASE WHEN p.blog_id IS NULL OR p.version != ${PUBLIC_SEARCH_VERSION} THEN 1 ELSE 0 END) AS missing,
    SUM(CASE WHEN p.body_status = 'missing' THEN 1 ELSE 0 END) AS partial
    FROM blogs b JOIN users u ON u.id=b.author_id LEFT JOIN public_blog_search_state p ON p.blog_id=b.id WHERE ${publicWhere}`;
  const availability: SearchAvailability = Number(coverage[0]?.missing || 0) > 0 ? 'metadata-only' : Number(coverage[0]?.partial || 0) > 0 ? 'partial' : 'ready';
  const folded = q.toLowerCase();
  const bodyMatches = availability === 'metadata-only' ? Prisma.sql`SELECT -1 AS rowid` : Prisma.sql`SELECT rowid FROM public_blog_search
    WHERE public_blog_search MATCH ${searchTerms(folded, true)} AND version=${PUBLIC_SEARCH_VERSION} AND body_status='ready'`;
  const meta = Prisma.sql`instr(lower(b.title),${folded})>0 OR instr(lower(b.description),${folded})>0 OR instr(lower(u.username),${folded})>0`;
  const filter = Prisma.sql`${publicWhere} AND (${meta} OR b.rowid IN (${bodyMatches}))
    ${categoryIds ? Prisma.sql`AND b.category_id IN (${Prisma.join(categoryIds.length ? categoryIds : [-1])})` : Prisma.empty}`;
  const counts = await tx.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM blogs b JOIN users u ON u.id=b.author_id WHERE ${filter}`;
  const hits = await tx.$queryRaw<{ id: string; snippet: string | null }[]>`SELECT ranked.id,
    CASE WHEN ${availability !== 'metadata-only'} AND p.version=${PUBLIC_SEARCH_VERSION} AND p.body_status='ready' AND instr(p.folded,${folded})>0 THEN substr(p.body,MAX(1,instr(p.folded,${folded})-55),180) ELSE NULL END AS snippet
    FROM (SELECT b.rowid AS blogrow,b.id FROM blogs b JOIN users u ON u.id=b.author_id
      WHERE ${filter}
      ORDER BY (CASE WHEN instr(lower(b.title),${folded})>0 THEN 8 ELSE 0 END
        + CASE WHEN instr(lower(b.description),${folded})>0 THEN 4 ELSE 0 END
        + CASE WHEN instr(lower(u.username),${folded})>0 THEN 2 ELSE 0 END) DESC, b.created_at DESC,b.id DESC
      LIMIT ${perPage} OFFSET ${(page-1)*perPage}
    ) ranked LEFT JOIN public_blog_search p ON p.rowid=ranked.blogrow AND p.blog_id=ranked.id`;
  return { hits, total: Number(counts[0].count), availability };
}
