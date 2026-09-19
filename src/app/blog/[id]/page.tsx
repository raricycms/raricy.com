import { forbidden, notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { redirectToLogin } from '@/lib/guard';
import { EXTERNAL_VISIBILITIES, INDEXABLE_VISIBILITIES, getBlogDetail } from '@/lib/blog-service';
import { prisma } from '@/lib/db';
import MarkdownRenderer from '@/app/components/MarkdownRenderer';
import CommentSection from '@/app/components/CommentSection';
import FeedButton from '@/app/components/FeedButton';
import FooterCopyOverride from '@/app/components/FooterCopyOverride';
import ReadingProgress from '@/app/blog/ReadingProgress';
import { getCurrentUser, hasAdminRights, isCoreUser } from '@/lib/auth';
import { getFeedStatus } from '@/lib/feed-service';
import { isBlogFavorited } from '@/lib/favorite-service';

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
      </article>

      <FooterCopyOverride text={`作者：${blog.author?.username} | 版权归原作者所有`} />
    </>
  );
}
