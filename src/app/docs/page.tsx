import Link from 'next/link';
import type { Metadata } from 'next';
import {
  DOC_GROUPS,
  REPO_URL,
  docEntriesOfGroup,
  docHref,
} from '@/lib/docs-catalog';

// 文档索引页 —— `/docs`。
//
// 数据全部来自登记表 `src/lib/docs-catalog.ts`（源码里的常量），**不读磁盘**：
// 这一页列的是「有哪些文档、叫什么」，而那些是随代码走的。正文页才读盘（见
// `docs/[...slug]/page.tsx`）。所以本页在构建期静态化、文档正文改一句话不需要重新
// build，两者的新鲜度由不同的东西保证 —— 这是刻意的，不是漏了 force-dynamic。
//
// 加文档 / 改标题 / 调顺序都改那份登记表；守卫 `tests/unit/docs-catalog.test.ts`
// 会盯着「磁盘上有、表里没有」与「标题与 H1 对不上」两件事。

export const metadata: Metadata = {
  title: '文档 · 聪明山',
  description: '聪明山的全部文档：使用指南、站外机器人接口说明，以及开发与运维笔记。',
};

export default function DocsIndexPage() {
  return (
    /* `.container` 与 `.docs-page` 同挂一个元素，**不要**在 `.docs-page` 里写
       padding 简写：`.container` 的两侧檐沟来自 `container-padding` mixin，
       简写会把它一并覆盖成 0，于是窄屏下这一页贴着屏幕两条边（不报错，只有肉眼
       看得见）。这里只加纵向的。同类记录见 docs/frontend-styles.md §4.1。 */
    <div className="docs-page container">
      <header className="docs-hero">
        <h1 className="docs-hero__title">文档</h1>
        <p className="docs-hero__lede">
          使用指南、机器人接口说明与开发资料。
        </p>
        <p className="docs-hero__source">
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            在 GitHub 上浏览仓库
          </a>
        </p>
      </header>

      <nav className="docs-audiences" aria-label="文档受众">{DOC_GROUPS.map(group=><a key={group.key} href={`/docs#docs-${group.key}`}>{group.title}</a>)}</nav>

      {DOC_GROUPS.map((group) => {
        const entries = docEntriesOfGroup(group.key);
        return (
          <section className="docs-group" key={group.key} id={`docs-${group.key}`}>
            <h2 className="docs-group__title">
              {group.title}
              <span className="docs-group__count numeric">{entries.length}</span>
            </h2>
            <p className="docs-group__desc">{group.description}</p>

            <ul className="docs-list">
              {entries.map((entry) => (
                <li key={entry.slug}>
                  <Link className="docs-item" href={docHref(entry.slug)}>
                    <span className="docs-item__title">{entry.title}</span>
                    <span className="docs-item__summary">{entry.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
