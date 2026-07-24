import { Fragment } from 'react';
import Link from 'next/link';
import { resolvePath } from '@/lib/story-service';
import type { CollectionResult } from '@/lib/story-service';

// 故事根合集 — Flask BEM 样式
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function StoryRootPage() {
  const result = resolvePath([]);

  const data: CollectionResult =
    result.kind === 'collection'
      ? result.data
      : {
          info: { title: '故事', description: '' },
          children: [],
          breadcrumbs: [],
        };

  const { info, children, breadcrumbs } = data;
  const path = breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1].path : '';

  return (
    <>
      <section className="story-hero">
        <h1>{info.title || '故事'}</h1>
        {info.description && <p>{info.description}</p>}
      </section>

      <div className="container">
        {breadcrumbs.length > 0 && (
          <nav className="story-breadcrumbs">
            <Link href="/story">故事</Link>
            {breadcrumbs.map((crumb, i) => (
              <Fragment key={crumb.path}>
                <span className="story-breadcrumbs__sep">/</span>
                {i === breadcrumbs.length - 1 ? (
                  <span className="story-breadcrumbs__current">{crumb.label}</span>
                ) : (
                  <Link href={`/story/${crumb.path}`}>{crumb.label}</Link>
                )}
              </Fragment>
            ))}
          </nav>
        )}

        {path && (
          <div className="story-back">
            {path.includes('/') ? (
              <Link href={`/story/${path.slice(0, path.lastIndexOf('/'))}`}>
                ← 返回上级
              </Link>
            ) : (
              <Link href="/story">← 返回故事首页</Link>
            )}
          </div>
        )}

        {children.length === 0 ? (
          <div className="story-empty">这个合集中还没有内容。</div>
        ) : (
          <div className="story-grid">
            {children.map((child) => {
              const target = `/story/${child.slug}`;
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
