import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { redirectToLogin } from '@/lib/guard';
import {
  EXTERNAL_VISIBILITIES,
  INDEXABLE_VISIBILITIES,
  getBlogDetail,
  parseVisibility,
} from '@/lib/blog-service';
import { prisma } from '@/lib/db';
import MarkdownRenderer from '@/app/components/MarkdownRenderer';
import CommentSection from '@/app/components/CommentSection';
import FeedButton from '@/app/components/FeedButton';
import FooterCopyOverride from '@/app/components/FooterCopyOverride';
import ReadingProgress from '@/app/blog/ReadingProgress';
import { getCurrentUser, hasAdminRights, isCoreUser } from '@/lib/auth';
import { getFeedStatus } from '@/lib/feed-service';
import { isBlogFavorited } from '@/lib/favorite-service';
import { jsonLdScript } from '@/lib/json-ld';
import { isoWithOffset } from '@/lib/db-time';
import { siteBaseUrl } from '@/lib/site-url';

export const dynamic = 'force-dynamic';

/**
 * 标题 / 摘要 / robots / 分享卡片。
 *
 * ⚠️ metadata 与页面是**两个独立的渲染步** —— 页面那道可见性判定**管不到这里**。
 * 见 tests/e2e/access-control.spec.ts 那条钉子（`generateMetadata` 在守卫之前裸取数，
 * 于是 403 的响应里带走了文章标题）。所以这里**自己判一次**，而且判不过就返回中性
 * 标题，**绝不回显**。
 *
 * 【为什么不上 React.cache() 省掉这次重复查询】viewer 是每次渲染新建的对象字面量，
 * 而 `cache()` 按**引用**做键 —— 必然 miss，加了只是自欺。两次主键查询而已。
 * （`blog/[id]/edit/page.tsx` 现在也是各查一次的同款做法。）
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const blog = await getBlogDetail(id, user ? { id: user.id, isCore: isCoreUser(user) } : null);
  if (!blog) return { title: '文章 - Raricy.com' };

  const visibility = blog.visibility as string;
  const external = (EXTERNAL_VISIBILITIES as readonly string[]).includes(visibility);
  const indexable = (INDEXABLE_VISIBILITIES as readonly string[]).includes(visibility);

  return {
    title: `${blog.title} - 聪明山`,
    description: blog.description || undefined,
    // private（只有 core+ 看得到）也发 noindex：成员视图同样不该被索引。
    robots: indexable ? { index: true, follow: true } : { index: false, follow: false },
    // 分享卡片只给**对外可见**的文章挂：private 文章连 OG 图路由都是 404，
    // 挂上去只会让抓取器白跑一趟。link 与 public 都挂 —— 差别在索引，不在能不能分享。
    ...(external
      ? {
          openGraph: {
            type: 'article',
            title: blog.title,
            description: blog.description || undefined,
            url: `/blog/${blog.id}`,
            siteName: '聪明山',
            // 尺寸必须与 /api/og/blog/:id 的**实际字节**一致：逻辑 1200×630 按
            // density=144（2×）光栅化 → 2400×1260。声明 1200 却给 2400 的字节
            // 就是那种静默不一致。
            images: [{ url: `/api/og/blog/${blog.id}`, width: 2400, height: 1260, alt: blog.title }],
          },
          twitter: { card: 'summary_large_image' },
        }
      : {}),
  };
}

// 文章详情页 —— **两种视图**：
//
//   · 成员视图（core+）：与本站一直以来完全一致 —— 正文 + 点赞 / 投喂 / 收藏 /
//     编辑入口 + 评论区。
//   · 访客视图（未登录，或已登录但非 core）：只有标题、作者、正文。**没有任何站内
//     affordance** —— 不渲染 FeedButton（点赞、投喂、收藏、编辑、管理入口与三个计数
//     数字全挂在它身上），也不渲染 CommentSection（它是纯客户端拉取、首屏无 SSR，
//     所以「不渲染」= 首屏 payload 里连一条评论都没有，不存在「下发了再藏起来」）。
//
// 分叉判据是 **isCore，不是 visibility**：core+ 读一篇 public 文章看到的仍是完整成员
// 视图。若按 visibility 分叉，「作者把文章设为公开」会顺手夺走他自己和全站的互动能力
// —— 那会让人不敢用这个功能。对外视图是**访客的**视图，不是「公开文章的」视图。
//
// 【访客读不到时为什么不返回 404】private 的语义是「仅站内 core+ 可见」（本站一直
// 以来的样子），不是「不存在」。所以访客拿到登录页 —— 这对转型也是对的：告诉他
// 「这是站内内容，登录可看」，而不是一个冷冰冰的 404。已登录但非 core 才 403。
export default async function BlogDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const isCore = isCoreUser(user);

  const blog = await getBlogDetail(id, user ? { id: user.id, isCore } : null);
  if (!blog) {
    // 不存在 / 已软删 / 档位不够 —— 三者对外同形，不区分（不确认存在性）。
    // ⚠️ 显式传 next：从站外直接点进来的访客没有同源 referer，不传的话
    // getSafeNextPath() 会回落到 '/'，登录完掉回首页而不是这篇文章。
    if (!user) return redirectToLogin(`/blog/${id}`);
    if (!isCore) forbidden();
    notFound();
  }

  const isAdmin = hasAdminRights(user);
  const isAuthor = !!user && user.id === blog.authorId;

  // 结构化数据只给 public 档 —— 与 generateMetadata 的 robots 同一个判据。
  // link / private 的页面本来就 noindex，挂 JSON-LD 没有意义（搜索引擎不会读它），
  // 反而多一处要把可见性判对的地方。
  const indexable = (INDEXABLE_VISIBILITIES as readonly string[]).includes(blog.visibility);

  // 成员视图的查看者：与 `isCore` 同真值，但**是非空的 user** ——
  // `isCoreUser(null)` 为 false，所以 core+ 必然是登录用户；只是 TS 推不出这层关系，
  // 而 JSX 里要拿 `user.id`。（不用 `user!`：断言会把这个不变量藏起来。）
  const member = isCore && user ? user : null;

  // 这三项只有成员视图用得上；访客与非 core 的登录用户不必查（省钱，也少三个活口）。
  const [feedStatus, likeRow, favorited] = member
    ? await Promise.all([
        getFeedStatus(blog.id, member.id),
        prisma.blogLike.findUnique({
          where: { uq_blog_like_blog_user: { blogId: blog.id, userId: member.id } },
          select: { deleted: true },
        }),
        // 星标按钮的初始态。只查「有没有」—— 刻意**不查总数**：站内不显示被收藏数。
        isBlogFavorited(member.id, blog.id),
      ])
    : [{ fed: 0 }, null, false];

  return (
    <>
      {/* 结构化数据（schema.org 的 BlogPosting）—— 让 Google 能出富摘要。
          ⚠️ 必须过 jsonLdScript()：本站**没有任何 CSP** 兜底，一个含 `</script>` 的
          标题就能提前闭合这个脚本块（标题是用户输入，库里实打实有 XSS 演示内容）。
          序列化的转义规则全在 src/lib/json-ld.ts，别在这里手写。
          ⚠️ 时间戳必须过 isoWithOffset()：裸 toISOString() 会让机器以为它晚了 8 小时
          发布（datePublished 落在未来还可能让搜索引擎暂缓收录）。 */}
      {indexable && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: jsonLdScript({
              '@context': 'https://schema.org',
              '@type': 'BlogPosting',
              headline: blog.title,
              description: blog.description || undefined,
              datePublished: isoWithOffset(blog.createdAt) ?? undefined,
              dateModified: isoWithOffset(blog.content?.updatedAt ?? blog.createdAt) ?? undefined,
              author: blog.author?.username
                ? { '@type': 'Person', name: blog.author.username }
                : undefined,
              publisher: { '@type': 'Organization', name: '聪明山' },
              mainEntityOfPage: { '@type': 'WebPage', '@id': `${siteBaseUrl()}/blog/${blog.id}` },
              // 复用已有的分享卡片，不再为结构化数据单独渲染一张图（那是第二条出图管线）
              image: [`${siteBaseUrl()}/api/og/blog/${blog.id}`],
            }),
          }}
        />
      )}

      {/* 阅读进度条（页面顶部那条 .reading-progress） */}
      <div className="reading-progress" />
      {/* 客户端绑定 scroll → 进度条宽度 */}
      <ReadingProgress />

      <header className="read-hero">
        <h1>{blog.title}</h1>
        <div className="blog-meta" id="blog-meta">
          <span className="blog-author">
            <img src={`/api/avatar/${blog.authorId}`} alt={blog.author?.username ?? ''} />
            {blog.author?.username}
          </span>
        </div>
      </header>

      <article className="blog-detail" data-blog-id={blog.id}>
        {/* contentRefs 由**服务端**决定，不是客户端开关。'plain' 下正文里的 `[@…]`
            原样保留字面量、一次请求都不发 —— 这是匿名视图唯一的内容泄露面。 */}
        <MarkdownRenderer
          content={blog.content?.content ?? ''}
          contentRefs={member ? 'expand' : 'plain'}
        />

        {member && (
          <FeedButton
            blogId={blog.id}
            blogTitle={blog.title}
            initialFed={feedStatus.fed}
            initialFishCount={blog.fishCount ?? 0}
            isAuth
            isCore
            initialLiked={!!likeRow && !likeRow.deleted}
            initialLikes={blog.likesCount ?? 0}
            canManage={isAdmin || isAuthor}
            canEdit={isAuthor}
            isAdminDelete={isAdmin && !isAuthor}
            // 列是 TEXT、没有 CHECK 约束，所以归一化到白名单再下发 —— 脏值不该让弹窗
            // 里三个选项一个都不选中。
            initialVisibility={parseVisibility(blog.visibility) ?? 'private'}
            initialFavorited={favorited}
          />
        )}

        {member && (
          <CommentSection
            blogId={blog.id}
            currentUserId={member.id}
            isAdmin={isAdmin}
            canComment
          />
        )}

        {/* 访客视图的出口。第 1 期把这页对访客打开了，但读完就是死胡同 —— 而从站外
            点进来的人**没有经过本站导航**（他多半是从微信/QQ 直接落到这一页的），
            所以只补顶栏那条边等于没补。

            只给访客：成员视图本来就有顶栏、侧栏与完整的站内列表，多这一条反而碍事。
            刻意**不**用 .read-controls / #read-controls —— 那两处是「读者交互区」，
            tests/e2e/blog-visibility.spec.ts 按 id 断言访客视图上它计数为 0。
            「对外视图没有任何站内 affordance」这条不因这个链接而破 —— 它通向的是
            **另一个对外页面**，不是点赞/评论/编辑。 */}
        {!member && (
          <div className="mt-3">
            <Link href="/explore" className="read-btn">
              更多文章 →
            </Link>
          </div>
        )}
      </article>

      <FooterCopyOverride text={`作者：${blog.author?.username} | 版权归原作者所有`} />
    </>
  );
}
