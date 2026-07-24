import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listBlogs } from '@/lib/blog-service';
import { prisma } from '@/lib/db';
import { categoryFullPath } from '@/lib/format';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import BlogSidebar from './BlogSidebar';
import SearchForm from './SearchForm';
import BlogPageJump from './BlogPageJump';

export const dynamic = 'force-dynamic'; // 依赖查询参数，禁用静态化

interface SearchParams {
  page?: string;
  category?: string;
  featured?: string;
  search?: string;
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

  const [result, categories, currentUser] = await Promise.all([
    listBlogs({
      page: parseInt(sp.page || '1', 10),
      categorySlug: sp.category ?? null,
      featured,
      search: sp.search ?? null,
    }),
    prisma.category.findMany({
      where: { parentId: null, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        icon: true,
        children: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          select: { id: true, name: true, slug: true },
        },
      },
    }),
    getCurrentUser(),
  ]);

  const canUpload = isCoreUser(currentUser);

  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (sp.category) p.set('category', sp.category);
    if (sp.featured) p.set('featured', sp.featured);
    if (sp.search) p.set('search', sp.search);
    p.set('page', String(page));
    return `?${p.toString()}`;
  };

  const clearHref = (() => {
    const p = new URLSearchParams();
    if (sp.category) p.set('category', sp.category);
    if (sp.featured) p.set('featured', sp.featured);
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

      <div className="container">
        <div className="blog-layout">
          <BlogSidebar
            categories={categories}
            currentSlug={currentSlug}
            featured={featured}
          />

          <main className="blog-content">
            {result.blogs.length > 0 && (
              <div className="blog-list">
                {result.blogs.map((b) => (
                  <article key={b.id} className="blog-item" id={`id${b.id}`}>
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
                          <span className="icon" aria-hidden="true">🐟</span>
                          <span>{b.fishCount ?? 0}</span>
                        </span>
                      </div>
                    </div>
                    <p className="blog-description">{b.description}</p>
                    <div className="menu-blog-meta">
                      <div className="blog-author">
                        <img src={`/api/avatar/${b.authorId}`} alt={b.author?.username ?? ''} />
                        <span>{b.author?.username}</span>
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