import { forbidden, notFound } from 'next/navigation';
import { redirectToLogin } from '@/lib/guard';
import { getBlogDetail } from '@/lib/blog-service';
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
