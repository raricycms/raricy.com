import Link from 'next/link';
import { Fragment } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { CollectionResult } from '@/lib/story-service';

// 故事合集视图 —— `/story`（根合集）与 `/story/[...path]`（子合集）共用这一份。
//
// 【为什么单独一个文件】这两处原本各写了一份一模一样的合集渲染（hero + 面包屑 +
// 返回 + 卡片网格），只有「根合集取不到 description 时兜底一句抬头文案」这一点不同。
// 复制的那份迟早 drift —— 改文案时只改一边，就是下一次「首页说的和故事页说的不一样」。
export function CollectionView({
  data,
  fallbackDescription,
}: {
  data: CollectionResult;
  /**
   * 合集的 info.json 没写 description 时显示的兜底抬头文案。
   * **只有根合集会传**：子合集是数据，作者没写简介就不该被塞一句站级套话。
   */
  fallbackDescription?: string;
}) {
  const { info, children, breadcrumbs } = data;
  const basePath = breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1].path : '';
  const description = info.description || fallbackDescription || '';

  return (
    <>
      <section className="story-hero">
        <h1>{info.title}</h1>
        {description && <p>{description}</p>}
      </section>

      <div className="container">
        <Breadcrumbs crumbs={breadcrumbs} />

        {basePath && (
          <div className="story-back">
            <Link href={backTarget(basePath)}>
              <ArrowLeft aria-hidden="true" />{' '}
              {basePath.includes('/') ? '返回上级' : '返回故事首页'}
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

function backTarget(currentPath: string): string {
  const idx = currentPath.lastIndexOf('/');
  if (idx < 0) return '/story';
  return `/story/${currentPath.slice(0, idx)}`;
}
