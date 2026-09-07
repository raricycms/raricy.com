import Link from 'next/link';
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

  const [result, categories] = await Promise.all([
    listBlogs({
      page: parseInt(sp.page || '1', 10),
      categorySlug: sp.category ?? null,
      featured,
      search: sp.search ?? null,
      sort: parseSortParam(effectiveSort),
      focusMode: focusOn,
    }),
    prisma.category.findMany({
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
    }),
  ]);

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
            {result.blogs.length > 0 && (
              <div className="blog-list">
                {result.blogs.map((b) => (
                  <article key={b.id} className="blog-item" id={`id${b.id}`}>
                    {/* 整卡可点击的拉伸链接（CSS 里 z-index:0，作者链接置顶优先） */}
                    <Link
                      href={`/blog/${b.id}`}
                      className="blog-item-cover"
                      aria-label={b.title}
                    />
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
                          <span className="blog-category-tag">
                            {categoryFullPath(b.category)}
                          </span>
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
          </main>
        </div>
      </div>
    </>
  );
}