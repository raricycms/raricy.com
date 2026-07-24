import Link from 'next/link';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { resolvePath } from '@/lib/story-service';
import type { CollectionResult, StoryResult } from '@/lib/story-service';
import CattcaPlayer from '@/app/components/CattcaPlayer';
import StoryReaderClient from './StoryReaderClient';

// 故事路径页 — Flask BEM 样式
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
    <nav className="story-breadcrumbs">
      <Link href="/story">故事</Link>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={c.path}>
            <span className="story-breadcrumbs__sep">/</span>
            {last ? (
              <span className="story-breadcrumbs__current">{c.label}</span>
            ) : (
              <Link href={`/story/${c.path}`}>{c.label}</Link>
            )}
          </Fragment>
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
      <section className="story-hero">
        <h1>{info.title}</h1>
        {info.description && <p>{info.description}</p>}
      </section>

      <div className="container">
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
              const target = basePath
                ? `/story/${basePath}/${child.slug}`
                : `/story/${child.slug}`;
              return child.isCollection ? (
                <Link
                  key={child.slug}
                  href={target}
                  className="story-card story-card--collection"
                >
                  <h3 className="story-card__title">{child.title}</h3>
                  {child.description && (
                    <p className="story-card__desc">{child.description}</p>
                  )}
                  <div className="story-card__meta">
                    <span className="story-card__badge">{child.itemCount} 篇</span>
                  </div>
                  <div className="story-card__actions">
                    <span className="story-card__btn">浏览合集</span>
                  </div>
                </Link>
              ) : (
                <Link key={child.slug} href={target} className="story-card">
                  <h3 className="story-card__title">{child.title}</h3>
                  {child.description && (
                    <p className="story-card__desc">{child.description}</p>
                  )}
                  <div className="story-card__meta">
                    <span className="story-card__tag story-card__tag--words">
                      {child.wordCount} 字
                    </span>
                    {child.genre && (
                      <span className="story-card__tag story-card__tag--genre">
                        {child.genre}
                      </span>
                    )}
                    {child.aiAssisted && (
                      <span className="story-card__tag story-card__tag--ai-assisted">
                        AI 辅助
                      </span>
                    )}
                    <span className="story-card__author">{child.author}</span>
                  </div>
                  <div className="story-card__actions">
                    <span className="story-card__btn">开始阅读</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function backTarget(currentPath: string): string {
  const idx = currentPath.lastIndexOf('/');
  if (idx < 0) return '/story';
  return `/story/${currentPath.slice(0, idx)}`;
}

// ── Markdown 故事视图 ───────────────────────────────────────────────────────
function MarkdownView({ data }: { data: StoryResult }) {
  return (
    <>
      <StoryReaderClient />

      <article className="story-reader">
        <header className="story-reader__header">
          <h1>{data.title}</h1>
          <div className="story-reader__meta">
            <span>作者：{data.author}</span>
            {data.genre && <span>{data.genre}</span>}
            {data.aiAssisted && (
              <span className="story-reader__ai-badge">AI 辅助创作</span>
            )}
          </div>
        </header>

        {/* 可信管理员撰写的内容，dangerouslySetInnerHTML 是安全的 */}
        <div
          className="story-reader__content"
          dangerouslySetInnerHTML={{ __html: data.contentHtml ?? '' }}
        />

        <nav className="story-reader__nav">
          <span
            className="story-card__btn story-card__btn--ghost"
            aria-hidden="true"
          >
            ← 上一章
          </span>
          <Link
            href={data.parentPath ? `/story/${data.parentPath}` : '/story'}
            className="story-card__btn"
          >
            目录
          </Link>
          <span
            className="story-card__btn story-card__btn--ghost"
            aria-hidden="true"
          >
            下一章 →
          </span>
        </nav>
      </article>

      <p
        style={{
          color: 'var(--color-text-secondary)',
          fontSize: '0.95rem',
          textAlign: 'center',
          margin: '24px auto 48px',
        }}
      >
        作者：{data.author} | 版权归原作者所有
      </p>
    </>
  );
}

// ── Cattca 交互小说视图 ─────────────────────────────────────────────────────
function CattcaView({ data }: { data: StoryResult }) {
  return (
    <div className="story-cattca">
      <header className="story-cattca__header">
        <h2>{data.title}</h2>
        <div className="story-cattca__meta">
          <span>作者：{data.author}</span>
          {data.genre && <span>{data.genre}</span>}
          {data.aiAssisted && (
            <span className="story-cattca__ai-badge">AI 辅助创作</span>
          )}
        </div>
        <div className="story-back">
          <Link href={data.parentPath ? `/story/${data.parentPath}` : '/story'}>
            {data.parentPath ? '← 返回合集' : '← 返回故事首页'}
          </Link>
        </div>
      </header>

      <div className="story-cattca__game">
        <CattcaPlayer script={data.contentRaw ?? ''} variant="story" />
      </div>
    </div>
  );
}
