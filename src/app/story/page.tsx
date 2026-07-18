import { Fragment } from 'react';
import Link from 'next/link';
import { resolvePath } from '@/lib/story-service';
import type { CollectionResult } from '@/lib/story-service';

// 读磁盘 instance/stories（由 STORIES_DIR 覆盖），禁用静态化；fs 需要 Node.js runtime（非 edge）。
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function StoryRootPage() {
  const result = resolvePath([]);

  // 根目录缺失 / 被 ignore → 空状态（不崩溃，不 404，保留标题）。
  const data: CollectionResult =
    result.kind === 'collection'
      ? result.data
      : { info: { title: '故事', description: '' }, children: [], breadcrumbs: [] };

  const { info, children, breadcrumbs } = data;
  // 对齐 Flask collection.html 的 path 变量：根合集为空串，嵌套时取末级面包屑路径。
  const path = breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1].path : '';

  return (
    <>
      <section className="phero wrap">
        <h1 className="phero__title">{info.title || '故事'}</h1>
        {info.description && <p className="lede phero__lede">{info.description}</p>}
      </section>

      <section className="section--tight wrap">
        {breadcrumbs.length > 0 && (
          <nav className="crumbs">
            <Link href="/story">故事</Link>
            {breadcrumbs.map((crumb, i) => (
              <Fragment key={crumb.path}>
                <span className="sep">/</span>
                {i === breadcrumbs.length - 1 ? (
                  <span className="cur">{crumb.label}</span>
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
              <Link href={`/story/${path.slice(0, path.lastIndexOf('/'))}`}>← 返回上级</Link>
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
