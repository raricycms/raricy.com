import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowLeft } from 'lucide-react';
import { docEntriesOfGroup, docHref, findDocEntry, repoFileUrl } from '@/lib/docs-catalog';
import { docRepoPath, renderDocHtml } from '@/lib/docs-service';

// 文档正文页 —— `/docs/<登记表里的 slug>`。
//
// 取哪一份文档**只由登记表决定**：`findDocEntry` 查不到就是 404，所以 URL 里塞
// `..`、绝对路径、`%2e%2e%2f` 都到不了磁盘（判据与理由见 docs-catalog.ts 里
// findDocEntry 的注释）—— 不要在这里改成「拼一下路径再判断合不合法」。
//
// `force-dynamic`：正文是**请求时**读盘的，改了 `docs/` 下任意一份文档，`git pull`
// 之后不必重新 build 就能看到（与那 6 个指南页同一口径）。别顺手加
// generateStaticParams —— 那会把正文烘进构建产物，文档改动要重新 build 才生效，
// 而「改了没生效」的症状是**静默的**。
export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ slug: string[] }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const entry = findDocEntry((await params).slug);
  if (!entry) return { title: '文档未找到 · 聪明山' };
  return { title: `${entry.title} · 聪明山`, description: entry.summary };
}

export default async function DocPage({ params }: PageProps) {
  const entry = findDocEntry((await params).slug);
  if (!entry) notFound();

  const html = renderDocHtml(entry);
  const repoPath = docRepoPath(entry);
  const siblings = docEntriesOfGroup(entry.group).filter((e) => e.slug !== entry.slug);

  return (
    <div className="docs-page docs-page--doc container">
      <Link className="docs-back" href="/docs">
        <ArrowLeft aria-hidden="true" /> 文档索引
      </Link>

      {/* 文档正文。来源是仓库里的 Markdown（可信内容，非用户输入），
          与 MarkdownGuide 渲染指南页是同一条前提。 */}
      <article className="docs-content" dangerouslySetInnerHTML={{ __html: html }} />

      <p className="docs-source">
        本页内容来自仓库 <code>{repoPath}</code>
        <span className="docs-source__sep">·</span>
        <a href={repoFileUrl(repoPath)} target="_blank" rel="noreferrer">
          在 GitHub 上查看
        </a>
      </p>

      {siblings.length > 0 && (
        <nav className="docs-siblings" aria-label="同组其他文档">
          <h2 className="docs-siblings__title">同组其他文档</h2>
          <ul className="docs-list">
            {siblings.map((s) => (
              <li key={s.slug}>
                <Link className="docs-item" href={docHref(s.slug)}>
                  <span className="docs-item__title">{s.title}</span>
                  <span className="docs-item__summary">{s.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
