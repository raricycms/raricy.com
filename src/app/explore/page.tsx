import Link from 'next/link';
import { Suspense } from 'react';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { prisma } from '@/lib/db';
import { rateLimit, RULES } from '@/lib/rate-limit';
import { clientIp } from '@/lib/request-ip';
import { listPublicBlogs, listPublicCategoryFacets } from '@/lib/blog-service';
import Avatar from '@/app/components/Avatar';
import { categoryFullPath, ymd } from '@/lib/format';
// 侧栏与搜索框与站内 `/blog` 共用同一份实现（两条列表的差别是数据与去处，不是交互）。
// 它们住在 app/blog/ 下，是因为先有的站内列表；跨路由 import 没问题 ——
// 这两个文件不是 Next 的特殊文件，不会被当成路由。
import BlogSidebar from '@/app/blog/BlogSidebar';
import SearchForm from '@/app/blog/SearchForm';

// 根 layout 读 cookie 取登录态，整棵树本来就是动态的 —— 这里写 revalidate/静态化
// 都是自欺（它不会生效，只会让下一个人以为这页有缓存）。见「已知风险」。
export const dynamic = 'force-dynamic';

const PER_PAGE = 20;
/** 搜索词长度上限。LIKE 的参数长度直接决定扫描代价，而这是匿名入口。 */
const SEARCH_MAX = 100;

interface SearchParams {
  page?: string;
  category?: string;
  search?: string;
}

/** 把 URL 参数归一化成「这一页是谁」——canonical 与查询共用同一份，避免两处口径漂移。 */
function readParams(sp: SearchParams) {
  const page = Math.max(1, parseInt(sp.page || '1', 10) || 1);
  const category = (sp.category ?? '').trim() || null;
  // 截断而不是拒绝：超长搜索词是「用户粘多了」，不是攻击；但他也不该让我们扫一个
  // 4KB 的 LIKE。截断后行为可预期，且与 maxLength 的前端提示一致。
  const raw = (sp.search ?? '').trim();
  const search = raw ? raw.slice(0, SEARCH_MAX) : null;
  return { page, category, search };
}

/**
 * 标题 / 摘要 / canonical / robots。
 *
 * ⚠️ metadata 与页面是**两个独立的渲染步** —— 页面那道判定管不到这里，所以这里
 * 自己算。这条教训在本仓库写过不止一次（见 `blog/[id]/page.tsx` 的 generateMetadata）。
 *
 * 【为什么这里要多查一次库】「结果集为空 → noindex」这条规则需要知道总数，而空页面
 * 不该被索引（与 sitemap「不收不能 200 的路径」同一条纪律）。为它多一次 count 是
 * 划算的：爬虫抓一个空页面的代价比我们多一次 count 高得多，而且被收录的空页面会
 * 长期留在索引里。搜索请求不查（它恒 noindex，无需知道空不空）。
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { page, category, search } = readParams(await searchParams);

  // 搜索结果页恒 noindex：那是无穷多组参数的薄页面，收录它只会制造重复内容。
  // follow 留着 —— 页面上的文章链接仍然值得被跟。
  let indexable = !search;
  if (indexable) {
    const { total } = await listPublicBlogs({ page: 1, perPage: 1, categorySlug: category });
    indexable = total > 0;
  }

  // canonical 恒指向**自身**（带 page 与 category）。⚠️ 别把分页 canonical 到第 1 页：
  // 那等于告诉搜索引擎「第 2 页是第 1 页的副本」，后几页的文章会跟着一起掉出索引。
  const qs = new URLSearchParams();
  if (category) qs.set('category', category);
  if (search) qs.set('search', search);
  if (page > 1) qs.set('page', String(page));
  const self = qs.toString() ? `/explore?${qs.toString()}` : '/explore';

  return {
    // 恒定标题：**不**把搜索词拼进来。用户输入反射进 metadata 是没必要的暴露面，
    // 而且搜索结果本来就 noindex，拼了也没用。
    //
    // 【标题与描述：刻意不提「公开」】见 h1 处的注释 —— 这一页对站外读者**就是**本站的
    // 博客，不是「博客的公开切片」。写「公开文章」等于在标题栏里告诉每个访客
    // 「你看到的是个子集」。描述也自足，不写「作者选择公开的」那类对比句。
    title: '博客 - 聪明山',
    description: '聪明山的原创文章与思考分享。',
    alternates: { canonical: self },
    robots: { index: indexable, follow: true },
  };
}

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { page, category, search } = readParams(sp);

  // ── 搜索限频 ────────────────────────────────────────────────────────────────
  // 只对**真的带搜索词**的请求计数。写成无条件计数的话，光是翻页 / 换栏目就把额度
  // 耗光，限频会变成「限页」，正常访客翻两页就撞墙 —— 而且不报错、单测也测不出来，
  // 只有真实使用才会现形（站内 `/blog` 在同一处踩过）。
  //
  // 本站第一个**匿名页面**的限频，所以只能按 IP（没有会话可依）。取不到 IP 就整条
  // 跳过 —— 不要传占位串，那会把所有无 IP 的请求塞进同一个桶（见 request-ip.ts）。
  const ip = clientIp({ headers: await headers() });
  const searchLimited =
    !!search && !!ip && !rateLimit(`explore:search:ip:${ip}`, RULES.exploreSearchPerIp).allowed;

  // ⚠️ 被限频时**不创建**查询 promise。创建即发起查询：照旧创建只是不 await 的话，
  // count + findMany 照跑，限频就只省了流量、没省 CPU，且没有任何症状。
  const result = searchLimited
    ? null
    : listPublicBlogs({ page, perPage: PER_PAGE, categorySlug: category, search });

  // 侧栏：从**公开集合**反推出来的栏目，不是站内栏目树的照搬。
  // 数据与列表并行取；两件事互不依赖。
  const [facets, categories] = await Promise.all([
    listPublicCategoryFacets(),
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

  /**
   * 剪枝：只留「自己或某个子栏目有公开文章」的栏目，子栏目同样剪。
   *
   * 空栏目是死链（点进去什么都没有），而且会给搜索引擎一批空页面 —— 与 sitemap
   * 不收空路径是同一条纪律。**不递归**：本站只支持两级栏目。
   */
  const publicCategories = categories
    .map((c) => ({ ...c, children: c.children.filter((x) => facets.has(x.id)) }))
    .filter((c) => facets.has(c.id) || c.children.length > 0);

  const qs = (p: number) => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (search) params.set('search', search);
    params.set('page', String(p));
    return `/explore?${params.toString()}`;
  };

  const clearHref = category ? `/explore?category=${encodeURIComponent(category)}` : '/explore';

  return (
    <>
      <section className="blogs-hero">
        <div className="container">
          {/* 【为什么这一页自称「博客」，而不是「公开文章」】
              这一页对站外读者**就是本站的博客** —— h1 与副标题与站内 `/blog` 逐字相同
              （那边是「博客 / 分享思考与见解」）。写「公开文章」等于在页面最显眼处告诉
              每个访客「你看到的是个子集，还有一半没给你看」：那既没有信息量，也不是
              我们想让他关心的事。访客点顶栏「博客」进来看到「博客」，这条链是自洽的。

              ⚠️ 别在这里加「（仅显示公开文章）」之类的补充说明，也别在空态里写
              「还没有公开的文章」。要区分的是**这一页自己的两种空**（有没有搜索词），
              不是「公开 / 非公开」——见下面 ExploreListSection 的空态分支。 */}
          <h1>博客</h1>
          <p>分享思考与见解</p>

          <div className="blog-search">
            {/* featured / sort 恒为假值 —— 对外列表没有精选，也不带排序偏好 */}
            <SearchForm
              basePath="/explore"
              currentSlug={category}
              featured={false}
              search={search ?? ''}
              clearHref={clearHref}
              sort={null}
            />
          </div>
        </div>
      </section>

      <div className="container">
        <div className="blog-layout">
          <BlogSidebar
            basePath="/explore"
            showFeatured={false}
            categories={publicCategories}
            currentSlug={category}
            featured={false}
            sort={null}
          />

          <main className="blog-content">
            {result === null ? (
              <SearchRateLimited />
            ) : (
              <Suspense fallback={<ExploreListSkeleton />}>
                <ExploreListSection result={result} qs={qs} searching={!!search} />
              </Suspense>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

/**
 * 列表区（列表 + 分页）—— 被 <Suspense> 包住，等 listPublicBlogs 的 promise。
 *
 * 拆出来的理由与站内列表相同：让 hero / 搜索框 / 侧栏在首个 flush 就画出来，
 * 列表随后流式补上。
 */
async function ExploreListSection({
  result: pending,
  qs,
  searching,
}: {
  result: ReturnType<typeof listPublicBlogs>;
  qs: (page: number) => string;
  /** 是不是「搜出来的空」。空态要分这两种说法 —— 见下面的注释。 */
  searching: boolean;
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

  if (result.blogs.length === 0) {
    return (
      <div className="no-blogs">
        <i className="icon icon-journal-text" aria-hidden="true"></i>
        {/* 空态只说「这一页现在没有内容」，**不说**「没有**公开的**文章」—— 后者等于
            把「本站还有一半没给你看」明说出来（见 h1 处的注释）。

            两种空要分开说：搜索无结果写成「这里还没有文章」，搜的人会以为自己搜错了
            地方。这与「限频提示不能写成没有结果」是同一条纪律的另一面 —— 文案必须
            指向真实原因。 */}
        <p>{searching ? '没有找到匹配的文章' : '这里还没有文章'}</p>
      </div>
    );
  }

  return (
    <>
      <div className="blog-list">
        {result.blogs.map((b) => (
          <article key={b.id} className="blog-item" id={`id${b.id}`}>
            {/* 整卡可点击的拉伸链接（与站内列表同一套：z-index 由 .blog-item-cover 给） */}
            <Link href={`/blog/${b.id}`} className="blog-item-cover" aria-label={b.title} />
            <div className="blog-header">
              <Link href={`/blog/${b.id}`} className="blog-title">
                {b.title}
              </Link>
              {/* 刻意**没有** .blog-stats —— 对外视图没有评论区，卡片上写「评论 12」
                  却翻不到评论是自相矛盾的；点赞与鱼干更是站内的事。这不是漏了。 */}
            </div>
            {/* 纯文本插值：简介是原始 markdown 片段，绝不进 dangerouslySetInnerHTML */}
            <p className="blog-description">{b.description}</p>
            <div className="menu-blog-meta">
              <div className="blog-author">
                {/* 头像 + 昵称，但**不是链接** —— 第 2 期刻意不做作者页对外。
                    与详情页一致（那里作者名也是纯文本）。 */}
                <Avatar
                  userId={b.authorId}
                  frameUrl={b.author?.frameUrl}
                  alt={b.author?.username ?? ''}
                />
                <span>{b.author?.username}</span>
                {b.category && (
                  <span className="blog-category-tag">{categoryFullPath(b.category)}</span>
                )}
              </div>
              {/* 右侧的日期：无类名，字号/颜色继承 .menu-blog-meta */}
              <span>{ymd(b.createdAt)}</span>
            </div>
          </article>
        ))}
      </div>

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
        </nav>
      )}
    </>
  );
}

/**
 * 搜索被限频时的提示。
 *
 * 【文案必须与「没有结果」可区分】写成空态那句「这里还没有文章」就是在说谎 —— 访客会
 * 得出「没有搜到」的结论，而实际是请求压根没发出去。这种静默失效正是本仓库红线紧盯
 * 的那类错，所以宁可多一句解释。
 *
 * 复用 .no-blogs 的容器样式（居中 + 次要色，零新 CSS）；**不带**它那个文档图标 ——
 * 那个图标指向「这里没有内容」，与「请求被挡下了」是两回事。
 */
function SearchRateLimited() {
  return (
    <div className="no-blogs">
      <p>搜索太频繁了，请稍候一分钟再试。</p>
    </div>
  );
}

/**
 * 列表区的等待态。类名一律走 blog-skeleton-*（与站内列表共用），不碰 .blog-item
 * 等真实内容类名 —— 骨架顶着同名类出现会污染按类名计数的用例。
 */
function ExploreListSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="blog-skeleton-card">
          <div className="blog-skeleton-head">
            <div className="blog-skeleton-line blog-skeleton-line--heading" />
          </div>
          <div className="blog-skeleton-line blog-skeleton-line--desc" />
          <div className="blog-skeleton-line blog-skeleton-line--meta" />
        </div>
      ))}
    </div>
  );
}
