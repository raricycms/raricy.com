import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listBlogs } from '@/lib/blog-service';
import { prisma } from '@/lib/db';
import { categoryFullPath } from '@/lib/format';
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

  // 并行拉取博客列表与侧栏分类（对齐 menu.html 的分类侧栏）
  const [result, categories] = await Promise.all([
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
  ]);

  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (sp.category) p.set('category', sp.category);
    if (sp.featured) p.set('featured', sp.featured);
    if (sp.search) p.set('search', sp.search);
    p.set('page', String(page));
    return `?${p.toString()}`;
  };

  // 清除搜索时保留分类 / 精选筛选
  const clearHref = (() => {
    const p = new URLSearchParams();
    if (sp.category) p.set('category', sp.category);
    if (sp.featured) p.set('featured', sp.featured);
    const s = p.toString();
    return s ? `/blog?${s}` : '/blog';
  })();

  // 分页 window-of-3
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
      <section className="phero wrap">
        <h1 className="phero__title">博客</h1>
        <p className="lede phero__lede">分享思考与见解。</p>

        <div className="blog-toolbar">
          <SearchForm
            currentSlug={currentSlug}
            featured={featured}
            search={sp.search ?? ''}
            clearHref={clearHref}
          />
          <a href="/blog/upload_blog" className="upload-button">
            <span className="icon icon-add"></span>创建文章
          </a>
        </div>
      </section>

      <section className="section--tight wrap">
        <div className="blog-layout">
          <BlogSidebar categories={categories} currentSlug={currentSlug} featured={featured} />

          <div className="blog-content">
            {result.blogs.map((b) => (
              <Link key={b.id} className="card blog-item" id={`id${b.id}`} href={`/blog/${b.id}`}>
                <div className="blog-header">
                  <span className="blog-title">{b.title}</span>
                  <div className="blog-stats">
                    <span title="点赞">
                      <span className="icon icon-heart-fill"></span>
                      {b.likesCount ?? 0}
                    </span>
                    <span title="评论">
                      <span className="icon icon-chat-dots_new"></span>
                      {b.commentsCount ?? 0}
                    </span>
                    <span title="小鱼干">🐟 {b.fishCount ?? 0}</span>
                  </div>
                </div>
                <p className="blog-description">{b.description}</p>
                <div className="menu-blog-meta">
                  <div className="blog-author">
                    {/* 头像/图床过渡期由 Flask 提供，经 next.config 的 rewrites 回源 */}
                    <img src={`/api/avatar/${b.authorId}`} alt={b.author?.username ?? ''} />
                    <span>{b.author?.username}</span>
                    {b.category && <span className="blog-category-tag">{categoryFullPath(b.category)}</span>}
                  </div>
                </div>
              </Link>
            ))}

            {result.blogs.length === 0 && <div className="no-blogs">暂无博客文章</div>}

            {result.pages > 1 && (
              <div className="pagination">
                {result.hasPrev && (
                  <Link href={qs(result.page - 1)} className="page-link">
                    &laquo;
                  </Link>
                )}
                {pageItems.map((p, i) =>
                  p === '...' ? (
                    <span key={`e${i}`} className="page-ellipsis">
                      …
                    </span>
                  ) : (
                    <Link
                      key={p}
                      href={qs(p)}
                      className={`page-link ${p === result.page ? 'active' : ''}`}
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
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
