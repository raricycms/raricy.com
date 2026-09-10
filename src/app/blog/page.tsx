import Link from 'next/link';
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { requireCoreUser } from '@/lib/guard';
import { COOKIE_NAME } from '@/lib/blog-sort-pref';
import { listBlogs, parseSortParam } from '@/lib/blog-service';
import { prisma } from '@/lib/db';
import { categoryFullPath } from '@/lib/format';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import BlogSidebar from './BlogSidebar';
import SearchForm from './SearchForm';
import BlogSort from './BlogSort';
import BlogPageJump from './BlogPageJump';

export const dynamic = 'force-dynamic'; // 依赖查询参数，禁用静态化

interface SearchParams {
  page?: string;
  category?: string;
  featured?: string;
  search?: string;
  sort?: string;
}

export default async function BlogListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireCoreUser();
  const sp = await searchParams;
  const featured = sp.featured === '1';
  const currentSlug = sp.category ?? null;
  // 回显只认「URL 里显式且合法」的 sort —— 默认 created 与无参等价，不给 URL 补默认值。
  const rawSort = sp.sort === 'created' || sp.sort === 'updated' ? sp.sort : null;
  // 有效排序 = URL 显式合法 > cookie=updated > created(默认)。
  // cookie 是 BlogSort 客户端写入的偏好镜像（非 httpOnly，见 blog-sort-pref.ts），
  // 让无参首访 /blog 的首屏就直接按偏好直出，避免「先 created 水合后再翻 updated」。
  // 列表排序与传给 <BlogSort initialSort> 的值必须同源 —— 同一帧由同一份 SSR 产出，
  // 任何时刻「按钮高亮」与「列表序」才一致。⚠️ 依赖 force-dynamic + staleTimes.dynamic=0：
  // 每次软导航都带当前 cookie 重新取数；去掉 force-dynamic 或改 staleTimes 会让此帧变陈旧。
  const prefUpdated = (await cookies()).get(COOKIE_NAME)?.value === 'updated';
  const effectiveSort: 'created' | 'updated' = rawSort ?? (prefUpdated ? 'updated' : 'created');

  // 专注模式：查看者开启时，列表与侧栏都隐藏 focusHidden 栏目（根整组隐藏、
  // 子项从父组剪掉但父组「全部」入口保留）。本页 requireCoreUser 保证登录，
  // 先取当前用户定 focusOn，再与列表/栏目并行取数。
  const currentUser = await getCurrentUser();
  const focusOn = !!currentUser?.focusMode;

  // ⚠️ 列表**不 await** —— 直接把 promise 交给下面 <Suspense> 里的 BlogListSection。
  // 这样 hero / 搜索框 / 侧栏分类在首个 flush 就能画出来，列表随后流式补上；
  // 若在这里 await，整页要等列表就绪才吐第一个字节（首屏与末屏同一时刻出现）。
  // 守卫不受影响：requireCoreUser 在上面已经 await 过，redirect/forbidden 早于任何 flush。
  const result = listBlogs({
    page: parseInt(sp.page || '1', 10),
    perPage: 50, // 目录每页 50 篇（服务默认 200 是 /api/blogs 的契约，不动）
    categorySlug: sp.category ?? null,
    featured,
    search: sp.search ?? null,
    sort: parseSortParam(effectiveSort),
    focusMode: focusOn,
  });

  const categories = await prisma.category.findMany({
    where: { parentId: null, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      icon: true,
      focusHidden: true,
      children: {
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, slug: true, focusHidden: true },
      },
    },
  });

  /** 专注模式下剪掉被标记栏目：根 focusHidden 整组丢弃；子项从父组过滤（父组保留）。 */
  function pruneFocusCategories<T extends { focusHidden: boolean | null; children: { focusHidden: boolean | null }[] }>(list: T[]): T[] {
    return list
      .filter((c) => !c.focusHidden)
      .map((c) => ({ ...c, children: c.children.filter((x) => !x.focusHidden) }));
  }

  const canUpload = isCoreUser(currentUser);

  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (sp.category) p.set('category', sp.category);
    if (sp.featured) p.set('featured', sp.featured);
    if (sp.search) p.set('search', sp.search);
    if (rawSort) p.set('sort', rawSort);
    p.set('page', String(page));
    return `?${p.toString()}`;
  };

  const clearHref = (() => {
    const p = new URLSearchParams();
    if (sp.category) p.set('category', sp.category);
    if (sp.featured) p.set('featured', sp.featured);
    if (rawSort) p.set('sort', rawSort);
    const s = p.toString();
    return s ? `/blog?${s}` : '/blog';
  })();

  return (
    <>
      <section className="blogs-hero">
        <div className="container">
          <h1>博客</h1>
          <p>分享思考与见解</p>

          <div className="blog-search">
            <SearchForm
              currentSlug={currentSlug}
              featured={featured}
              search={sp.search ?? ''}
              clearHref={clearHref}
              sort={rawSort}
            />
          </div>

          {canUpload && (
            <div className="mt-3">
              <Link href="/blog/upload" className="upload-button">
                <span className="icon icon-add" aria-hidden="true"></span>
                创建
              </Link>
            </div>
          )}
        </div>
      </section>

      {focusOn && (
        <div className="focus-banner" role="status">
          您已开启专注模式，点击 <Link href="/settings#focus-mode">此处</Link> 关闭
        </div>
      )}

      <div className="container">
        <div className="blog-layout">
          <BlogSidebar
            categories={focusOn ? pruneFocusCategories(categories) : categories}
            currentSlug={currentSlug}
            featured={featured}
            sort={rawSort}
          />

          <main className="blog-content">
            {/* 无条件渲染：空结果页也要能执行「LS→cookie 迁移」的恢复 effect */}
            <BlogSort initialSort={effectiveSort} />
            {/* 列表与分页都依赖 result，故连同分页一起放进边界内 ——
                它们要么一起出现，要么一起等。fallback 用骨架，且**不复用 .blog-item**：
                专注模式的用例断言 `.blog-item` 计数为 0，骨架顶着同名类出现会污染它。 */}
            <Suspense fallback={<BlogListSkeleton />}>
              <BlogListSection result={result} qs={qs} />
            </Suspense>
          </main>
        </div>
      </div>
    </>
  );
}

/**
 * 列表区（列表 + 分页）—— 被 <Suspense> 包住，等 listBlogs 的 promise。
 *
 * 拆出来的唯一理由是让 page 组件本身**不 await** 列表数据：React 的提交单位是
 * Suspense 边界，边界内的内容挂起时，边界外的 hero / 搜索框 / 侧栏可以先画出来。
 * 分页依赖 result.pages，所以一并搬进来 —— 拆一半会让首屏出现「列表有了、页码还在等」。
 */
async function BlogListSection({
  result: pending,
  qs,
}: {
  result: ReturnType<typeof listBlogs>;
  qs: (page: number) => string;
}) {
  const result = await pending;

  const win = 3;
  const pageItems: (number | '...')[] = [];
  for (let p = 1; p <= result.pages; p++) {
    if (p === 1 || p === result.pages || (p >= result.page - win && p <= result.page + win)) {
      pageItems.push(p);
    } else if (p === result.page - win - 1 || p === result.page + win + 1) {
      pageItems.push('...');
    }
  }

  return (
    <>
      {result.blogs.length > 0 && (
        <div className="blog-list">
          {result.blogs.map((b) => (
            <article key={b.id} className="blog-item" id={`id${b.id}`}>
              {/* 整卡可点击的拉伸链接（CSS 里 z-index:0，作者链接置顶优先） */}
              <Link href={`/blog/${b.id}`} className="blog-item-cover" aria-label={b.title} />
              <div className="blog-header">
                <Link href={`/blog/${b.id}`} className="blog-title">
                  {b.title}
                </Link>
                <div className="blog-stats">
                  <span className="blog-likes" title="点赞数">
                    <span className="icon icon-heart-fill" aria-hidden="true"></span>
                    <span>{b.likesCount ?? 0}</span>
                  </span>
                  <span className="blog-comments" title="评论数">
                    <span className="icon icon-chat-dots_new" aria-hidden="true"></span>
                    <span>{b.commentsCount ?? 0}</span>
                  </span>
                  <span className="blog-fish" title="小鱼干">
                    <span className="icon icon-fish" aria-hidden="true"></span>
                    <span>{b.fishCount ?? 0}</span>
                  </span>
                </div>
              </div>
              <p className="blog-description">{b.description}</p>
              <div className="menu-blog-meta">
                <div className="blog-author">
                  <Link
                    href={`/u/${b.authorId}`}
                    className="blog-author-link"
                    title={b.author?.username ?? ''}
                  >
                    <img src={`/api/avatar/${b.authorId}`} alt={b.author?.username ?? ''} />
                    <span>{b.author?.username}</span>
                  </Link>
                  {b.category && (
                    <span className="blog-category-tag">{categoryFullPath(b.category)}</span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {result.blogs.length === 0 && (
        <div className="no-blogs">
          <i className="bi bi-journal-x" aria-hidden="true"></i>
          <p>暂无博客文章</p>
        </div>
      )}

      {result.pages > 1 && (
        <nav className="pagination" aria-label="分页">
          {result.hasPrev && (
            <Link href={qs(result.page - 1)} className="page-link">
              &laquo;
            </Link>
          )}
          {pageItems.map((p, i) =>
            p === '...' ? (
              <span key={`e${i}`} className="page-ellipsis">
                ...
              </span>
            ) : (
              <Link
                key={p}
                href={qs(p)}
                className={`page-link${p === result.page ? ' active' : ''}`}
                aria-current={p === result.page ? 'page' : undefined}
              >
                {p}
              </Link>
            )
          )}
          {result.hasNext && (
            <Link href={qs(result.page + 1)} className="page-link">
              &raquo;
            </Link>
          )}
          <BlogPageJump totalPages={result.pages} current={result.page} />
        </nav>
      )}
    </>
  );
}

/**
 * 列表区的等待态。高度按 .blog-item 的实测尺寸对齐，避免换入时列表跳动；
 * 类名一律走 blog-skeleton-* ，不碰 .blog-item / .blog-list 等真实内容类名。
 */
function BlogListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="blog-skeleton-card">
          {/* 桌面：标题与统计同行两端对齐；≤768px：.blog-header 转纵向、间距 6px */}
          <div className="blog-skeleton-head">
            <div className="blog-skeleton-line blog-skeleton-line--heading" />
            <div className="blog-skeleton-line blog-skeleton-line--stats" />
          </div>
          <div className="blog-skeleton-line blog-skeleton-line--desc" />
          <div className="blog-skeleton-line blog-skeleton-line--meta" />
        </div>
      ))}
    </div>
  );
}
