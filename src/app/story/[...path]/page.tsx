import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { resolvePath } from '@/lib/story-service';
import type { StoryResult } from '@/lib/story-service';
import CattcaPlayer from '@/app/components/CattcaPlayer';
import { CollectionView } from '../CollectionView';
import StoryReaderClient from './StoryReaderClient';

// 故事路径页 — 样式走 story-reader__* / story-cattca__* 类命名
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
            <ArrowLeft aria-hidden="true" /> 上一章
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
            下一章 <ArrowRight aria-hidden="true" />
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
            <ArrowLeft aria-hidden="true" />{' '}
            {data.parentPath ? '返回合集' : '返回故事首页'}
          </Link>
        </div>
      </header>

      <div className="story-cattca__game">
        <CattcaPlayer script={data.contentRaw ?? ''} variant="story" />
      </div>
    </div>
  );
}
