import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolvePath } from '@/lib/story-service';
import type { CollectionResult, StoryResult } from '@/lib/story-service';
import CattcaPlayer from '@/app/components/CattcaPlayer';
import StoryReaderClient from './StoryReaderClient';

// 读磁盘 instance/stories（由 STORIES_DIR 覆盖），禁用静态化；fs 需要 Node.js runtime（非 edge）。
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function StoryPathPage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path } = await params;
  const parts = path ?? [];
  const result = resolvePath(parts);

  if (result.kind === 'collection') return <CollectionView data={result.data} />;
  if (result.kind === 'markdown') return <MarkdownView data={result.data} />;
  if (result.kind === 'cattca') return <CattcaView data={result.data} />;
  notFound();
}

// ── 面包屑 ──────────────────────────────────────────────────────────────────

function Breadcrumbs({ crumbs }: { crumbs: CollectionResult['breadcrumbs'] }) {
  if (crumbs.length === 0) return null;
  return (
    <nav className="crumbs">
      <Link href="/story">故事</Link>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.path}>
            <span className="sep">/</span>
            {last ? (
              <span className="cur">{c.label}</span>
            ) : (
              <Link href={`/story/${c.path}`}>{c.label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ── 合集视图 ────────────────────────────────────────────────────────────────

function CollectionView({ data }: { data: CollectionResult }) {
  const { info, children, breadcrumbs } = data;
  const basePath = breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1].path : '';

  return (
    <>
      <section className="phero wrap">
        <h1 className="phero__title">{info.title}</h1>
        {info.description && <p className="lede phero__lede">{info.description}</p>}
      </section>

      <section className="section--tight wrap">
        <Breadcrumbs crumbs={breadcrumbs} />

        {basePath && (
          <div className="story-back">
            <Link href={backTarget(basePath)}>
              {basePath.includes('/') ? '← 返回上级' : '← 返回故事首页'}
            </Link>
          </div>
        )}

        {children.length === 0 ? (
          <div className="story-empty">这个合集中还没有内容。</div>
        ) : (
          <div className="story-grid">
            {children.map((child) => {
              const target = basePath ? `/story/${basePath}/${child.slug}` : `/story/${child.slug}`;
              return child.isCollection ? (
                <Link key={child.slug} href={target} className="card card--link scard scard--collection">
                  <span className="scard__title">{child.title}</span>
                  {child.description && <p className="scard__desc">{child.description}</p>}
                  <div className="scard__meta">
                    <span className="scard__tag">{child.itemCount} 篇</span>
                  </div>
                  <span className="scard__go">浏览合集</span>
                </Link>
              ) : (
                <Link key={child.slug} href={target} className="card card--link scard">
                  <span className="scard__title">{child.title}</span>
                  {child.description && <p className="scard__desc">{child.description}</p>}
                  <div className="scard__meta">
                    <span className="scard__tag">{child.wordCount} 字</span>
                    {child.genre && <span className="scard__tag scard__tag--genre">{child.genre}</span>}
                    {child.aiAssisted && <span className="scard__tag scard__tag--ai">AI 辅助</span>}
                    <span className="scard__author">{child.author}</span>
                  </div>
                  <span className="scard__go">开始阅读</span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

/** 「返回上级」目标：父路径存在则回父合集，否则回故事首页。 */
function backTarget(currentPath: string): string {
  const idx = currentPath.lastIndexOf('/');
  if (idx < 0) return '/story';
  return `/story/${currentPath.slice(0, idx)}`;
}

// ── Markdown 故事视图 ───────────────────────────────────────────────────────

function MarkdownView({ data }: { data: StoryResult }) {
  return (
    <>
      {/* 阅读进度条 + 键盘翻页（客户端增强，对齐 reader.html 尾部脚本）。 */}
      <StoryReaderClient />

      <div className="story-reader">
        <div className="story-reader__header">
          <h1>{data.title}</h1>
          <div className="story-reader__meta">
            <span>作者：{data.author}</span>
            {data.genre && <span>{data.genre}</span>}
            {data.aiAssisted && <span className="story-reader__ai-badge">AI辅助创作</span>}
          </div>
        </div>

        {/* 服务端渲染 + 去脚本，内容为可信管理员撰写，dangerouslySetInnerHTML 可用。 */}
        <div
          className="story-reader__content"
          dangerouslySetInnerHTML={{ __html: data.contentHtml ?? '' }}
        />

        <div className="story-reader__nav">
          <span className="story-card__btn story-card__btn--ghost" aria-hidden="true">← 上一章</span>
          <Link href={data.parentPath ? `/story/${data.parentPath}` : '/story'} className="story-card__btn">
            目录
          </Link>
          <span className="story-card__btn story-card__btn--ghost" aria-hidden="true">下一章 →</span>
        </div>
      </div>

      {/* 按篇作者/版权署名（对齐 reader.html 覆写的 copyright block；
          全局页脚不可改，沿用 blog 详情页同款内联做法）。 */}
      <p className="text-muted text-center mt-3">
        作者：{data.author} | 版权归原作者所有
      </p>
    </>
  );
}

// ── Cattca 交互小说视图 ─────────────────────────────────────────────────────

function CattcaView({ data }: { data: StoryResult }) {
  return (
    <div className="story-cattca">
      <div className="story-cattca__header">
        <h2>{data.title}</h2>
        <div className="story-cattca__meta">
          <span>作者：{data.author}</span>
          {data.genre && <span>{data.genre}</span>}
          {data.aiAssisted && <span className="story-cattca__ai-badge">AI辅助创作</span>}
        </div>
        <Link href={data.parentPath ? `/story/${data.parentPath}` : '/story'} className="story-back">
          {data.parentPath ? '← 返回合集' : '← 返回故事首页'}
        </Link>
      </div>

      <div className="story-cattca__game">
        <CattcaPlayer script={data.contentRaw ?? ''} variant="story" />
      </div>
    </div>
  );
}
