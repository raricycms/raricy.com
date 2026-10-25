import Link from 'next/link';
import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { requireCoreUser } from '@/lib/guard';
import { rateLimit, RULES } from '@/lib/rate-limit';
import Avatar from '@/app/components/Avatar';
import BlogTimestamps from '@/app/components/BlogTimestamps';
import { COOKIE_NAME } from '@/lib/blog-sort-pref';
import { listBlogs, getBlogDirectorySummary, parseSortParam, ALL_SEARCH_FIELDS } from '@/lib/blog-service';
import { BLOG_SCOPES, parseBlogScope } from '@/lib/blog-directory';
import { frameUrlFor } from '@/lib/frame-service';
// 客户端与服务端共用同一份短标记文案（零依赖模块）—— 不在 JSX 里写死档名。
import { VISIBILITY_BADGE } from '@/lib/blog-visibility';
import { prisma } from '@/lib/db';
import { categoryFullPath } from '@/lib/format';
// 锚点常量（零依赖模块）—— 设置页那块卡片的 id 就是它，别在 JSX 里再抄一遍字符串
import { FOCUS_MODE_SETTINGS_HREF } from '@/lib/focus-mode';
import { resolveFocusHiddenCategoryIds } from '@/lib/focus-service';
import BlogPersonalSidebar from './BlogPersonalSidebar';
import BlogCategorySelect from './BlogCategorySelect';
import BlogFilters from './BlogFilters';
import SearchForm from './SearchForm';
import BlogSort from './BlogSort';
import SitePager from '@/app/components/SitePager';

export const dynamic = 'force-dynamic'; // 依赖查询参数，禁用静态化

interface SearchParams {
  page?: string;
  category?: string;
  featured?: string;
  search?: string;
  sort?: string;
  scope?: string;
}

export default async function BlogListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireCoreUser();
  const sp = await searchParams;
  // ⚠️ 精选筛选是**三态**，别把布尔值直接递给 listBlogs：
  //   '1' → true（只看精选） / '0' → false（只看非精选） / 缺省 → undefined（不筛）
  // listBlogs 里 `featured: false` 是**生效的筛选**（与「不筛」的 undefined 不是一回事），
  // 所以「URL 没带 featured」若算成 false，「全部文章」和栏目目录就只剩非精选 ——
  // 精选文整体消失，只有点侧栏「精选」才看得见（线上发生过的 bug）。
  const featuredFilter = sp.featured === '1' ? true : sp.featured === '0' ? false : undefined;
  const scope = parseBlogScope(sp.scope);
  const scopeLabel = BLOG_SCOPES.find((item) => item.value === scope)!.label;
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

  // 专注模式：查看者开启时，列表与栏目下拉都隐藏**查看者自选**的栏目（未自定义
  // 时用站长标记的默认集合；已展开子栏目）。解析口径只有 focus-service 一处 ——
  // 别在这里直接读 categories.focusHidden。
  const focusOn = !!viewer.focusMode;
  const focusHiddenCategoryIds = await resolveFocusHiddenCategoryIds(viewer);
  const summary = getBlogDirectorySummary(viewer.id, focusHiddenCategoryIds);

  // ── 正文搜索限频 ──────────────────────────────────────────────────────────
  // 只对**真的会扫正文**的请求计数（search 非空）。不能写成无条件计数 —— 那样光是
  // 翻页 / 换栏目就把额度耗光了，限频会变成「限页」，正常用户翻两页就撞墙，
  // 而且不报错、单测也测不出来，只有真实使用才会现形。
  //
  // rateLimit 是纯内存同步函数（内部无 await），所以这一步不改变本页的时序结构。
  //
  // ⚠️ 超限时**不创建** listBlogs 的 promise。创建即发起查询：照旧创建只是不 await
  // 的话，两次全表扫描照跑，限频就只省了流量、没省 CPU，且没有任何症状。
  const searching = (sp.search ?? '').trim().length > 0;
  const searchLimited =
    searching && !rateLimit(`blog:search:${viewer.id}`, RULES.blogSearchMinute).allowed;

  // ⚠️ 列表**不 await** —— 直接把 promise 交给下面 <Suspense> 里的 BlogListSection。
  // 这样 hero / 搜索框 / 侧栏分类在首个 flush 就能画出来，列表随后流式补上；
  // 若在这里 await，整页要等列表就绪才吐第一个字节（首屏与末屏同一时刻出现）。
  // 守卫不受影响：requireCoreUser 在上面已经 await 过，redirect/forbidden 早于任何 flush。
  const result = searchLimited
    ? null
    : listBlogs({
        page: parseInt(sp.page || '1', 10) || 1,
        perPage: 50, // 目录每页 50 篇（服务默认 200 是 /api/blogs 的契约，不动）
        categorySlug: sp.category ?? null,
        featured: featuredFilter,
        search: sp.search ?? null,
        sort: parseSortParam(effectiveSort),
        focusHiddenCategoryIds,
        // 公开目录页搜全部字段（含正文）。其余调用方（/api/blogs、引用弹窗）走默认的
        // 标题/简介/作者，别顺手放宽（见 ListParams.searchFields 的注释）。
        searchFields: ALL_SEARCH_FIELDS,
        personalScope: scope === 'all' ? undefined : { kind: scope, userId: viewer.id },
      });

  const categories = await prisma.category.findMany({
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
  });

  /** 专注模式下剪掉被屏蔽栏目：根在集合里 → 整组丢弃；子项在集合里 → 从父组剪掉（父组保留）。 */
  function pruneFocusCategories<T extends { id: number; children: { id: number }[] }>(
    list: T[],
    hidden: ReadonlySet<number>
  ): T[] {
    if (!hidden.size) return list;
    return list
      .filter((c) => !hidden.has(c.id))
      .map((c) => ({ ...c, children: c.children.filter((x) => !hidden.has(x.id)) }));
  }
  // 生效集合已由 focus-service 展开子栏目 —— 选中根栏目时其子项也在集合里，
  // 所以根整组丢弃、子项逐个过滤这两条判据不会互相漏掉。
  const focusHiddenSet = new Set(focusHiddenCategoryIds ?? []);

  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (scope !== 'all') p.set('scope', scope);
    if (sp.category) p.set('category', sp.category);
    if (sp.featured) p.set('featured', sp.featured);
    if (sp.search) p.set('search', sp.search);
    if (rawSort) p.set('sort', rawSort);
    p.set('page', String(page));
    return `?${p.toString()}`;
  };

  const clearHref = (() => {
    const p = new URLSearchParams();
    if (scope !== 'all') p.set('scope', scope);
    if (sp.category) p.set('category', sp.category);
    if (sp.featured) p.set('featured', sp.featured);
    if (rawSort) p.set('sort', rawSort);
    const s = p.toString();
    return s ? `/blog?${s}` : '/blog';
  })();
  const resetFiltersHref = (() => {
    const p = new URLSearchParams();
    if (scope !== 'all') p.set('scope', scope);
    if (rawSort) p.set('sort', rawSort);
    return p.size ? `/blog?${p}` : '/blog';
  })();

  return (
    <>
      <section className="blogs-hero">
        <div className="container">
          <h1>博客</h1>
          <p>分享思考与见解</p>
        </div>
      </section>

      {focusOn && (
        <div className="focus-banner" role="status">
          您已开启专注模式，点击 <Link href={FOCUS_MODE_SETTINGS_HREF}>此处</Link> 调整屏蔽范围
        </div>
      )}

      <div className="container">
        <div className="blog-layout blog-directory">
          <BlogPersonalSidebar
            user={{ id: viewer.id, username: viewer.username, frameUrl: frameUrlFor(viewer) }}
            summary={await summary}
            scope={scope}
          />

          <main className="blog-content">
            <BlogFilters>
              <SearchForm
                key={`${scope}:${currentSlug}:${sp.featured}:${sp.search}`}
                currentSlug={currentSlug}
                featured={featuredFilter === true}
                featuredValue={sp.featured === '0' || sp.featured === '1' ? sp.featured : undefined}
                scope={scope}
                search={sp.search ?? ''}
                clearHref={clearHref}
                sort={rawSort}
              />
              <BlogCategorySelect
                categories={pruneFocusCategories(categories, focusHiddenSet)}
                currentSlug={currentSlug}
                featured={sp.featured}
              />
              {/* 空结果页也挂载排序偏好的恢复 effect。 */}
              <BlogSort initialSort={effectiveSort} />
            </BlogFilters>
            {/* 列表与分页都依赖 result，故连同分页一起放进边界内 ——
                它们要么一起出现，要么一起等。fallback 用骨架，且**不复用 .blog-item**：
                专注模式的用例断言 `.blog-item` 计数为 0，骨架顶着同名类出现会污染它。 */}
            {/* 被限频时 result 是 null（promise 压根没创建），直接出提示，
                连 Suspense 都不进 —— 该分支不挂起，骨架不会闪。 */}
            {result === null ? (
              <SearchRateLimited />
            ) : (
              <Suspense fallback={<BlogListSkeleton />}>
                <BlogListSection key={`${scope}:${sp.category}:${sp.featured}:${sp.search}:${effectiveSort}:${sp.page}`} result={result} qs={qs} sort={effectiveSort} scopeLabel={scopeLabel} resetFiltersHref={resetFiltersHref} />
              </Suspense>
            )}
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
  sort,
  scopeLabel,
  resetFiltersHref,
}: {
  result: ReturnType<typeof listBlogs>;
  qs: (page: number) => string;
  sort: 'created' | 'updated';
  scopeLabel: string;
  resetFiltersHref: string;
}) {
  const result = await pending;

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
                    <span className="numeric">{b.likesCount ?? 0}</span>
                  </span>
                  <span className="blog-comments" title="评论数">
                    <span className="icon icon-chat-dots_new" aria-hidden="true"></span>
                    <span className="numeric">{b.commentsCount ?? 0}</span>
                  </span>
                  <span className="blog-fish" title="小鱼干">
                    <span className="icon icon-fish" aria-hidden="true"></span>
                    <span className="numeric">{b.fishCount ?? 0}</span>
                  </span>
                </div>
              </div>
              {/* 正文命中的片段优先于简介 —— 它回答「这篇为什么被搜出来」。
                  复用 .blog-description 的样式（同为两行截断的次要文本），不新增类名。
                  ⚠️ 纯文本插值：正文是原始 markdown 且含字面 HTML（库里实打实有
                  XSS 演示代码），这里绝不进 dangerouslySetInnerHTML。 */}
              <p className="blog-description">{b.snippet ?? b.description}</p>
              <div className="menu-blog-meta">
                <div className="blog-author">
                  <Link
                    href={`/u/${b.authorId}`}
                    className="blog-author-link"
                    title={b.author?.username ?? ''}
                  >
                    <Avatar
                      userId={b.authorId}
                      frameUrl={b.author?.frameUrl}
                      alt={b.author?.username ?? ''}
                    />
                    <span>{b.author?.username}</span>
                  </Link>
                  {b.category && (
                    <span className="blog-category-tag">{categoryFullPath(b.category)}</span>
                  )}
                  {/* 对外可见性标记 —— 给作者看「哪几篇已经对外了」。站内数千篇默认全是
                      private，作者要挑文章对外时没有这个标记就只能逐篇点进去看。

                      private 刻意**不标**：它是默认档，标记它等于满屏噪音，反而把
                      link/public 那两个淹没掉。

                      ⚠️ 两个分支刻意写死字面量类名，**不要**改成拼模板串 ——
                      tests/unit/css-tsx-classes.test.ts 只认字面量（模板串里 `${…}`
                      整段会被剥掉，剩下的 `blog-visibility-tag--` 会被判成「写了但
                      没有定义」）。代价是加第四档时这里不会自动长出来，由
                      tests/unit/blog-visibility-tag.test.ts 钉住三档一个都不能少。
                      文案取自 VISIBILITY_BADGE（零依赖模块），不在 JSX 里写死。 */}
                  {b.visibility === 'link' && (
                    <span className="blog-visibility-tag blog-visibility-tag--link">
                      {VISIBILITY_BADGE.link}
                    </span>
                  )}
                  {b.visibility === 'public' && (
                    <span className="blog-visibility-tag blog-visibility-tag--public">
                      {VISIBILITY_BADGE.public}
                    </span>
                  )}
                </div>
                <BlogTimestamps createdAt={b.createdAt} updatedAt={b.content?.updatedAt} sort={sort} />
              </div>
            </article>
          ))}
        </div>
      )}

      {result.blogs.length === 0 && (
        <div className="no-blogs">
          <i className="icon icon-journal-text" aria-hidden="true"></i>
          <p>「{scopeLabel}」中没有匹配的文章</p>
          <Link href={resetFiltersHref} className="button-primary">清掉筛选</Link>
        </div>
      )}

      <SitePager page={result.page} pages={result.pages} href={qs} />
    </>
  );
}

/**
 * 正文搜索被限频时的提示（见 page 组件里的 blogSearchMinute 闸）。
 *
 * 【为什么文案必须与空结果可区分】写成「暂无博客文章」就是在说谎 —— 用户会得出
 * 「没有搜到」的结论，而实际是请求压根没发出去。这种静默失效正是本仓库红线紧盯的
 * 那类错，所以宁可多一句解释。
 *
 * 复用 .no-blogs 的容器样式（居中 + 次要色，零新 CSS）；但**不带**它那个文档图标
 * —— 那个图标指向「这里没有内容」，与「请求被挡下了」是两回事。
 */
function SearchRateLimited() {
  return (
    <div className="no-blogs">
      <p>搜索太频繁了，请稍候一分钟再试。</p>
    </div>
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
          <div className="blog-skeleton-meta">
            <div className="blog-skeleton-line blog-skeleton-line--meta" />
            <div className="blog-skeleton-line blog-skeleton-line--time" />
          </div>
        </div>
      ))}
    </div>
  );
}
