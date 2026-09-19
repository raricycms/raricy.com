import { notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
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

export default async function BlogDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCoreUser();
  const { id } = await params;
  const [blog, user] = await Promise.all([getBlogDetail(id), getCurrentUser()]);
  if (!blog) notFound();

  const [feedStatus, likeRow, favorited] = await Promise.all([
    user ? getFeedStatus(blog.id, user.id) : Promise.resolve({ fed: 0 }),
    user
      ? prisma.blogLike.findUnique({
          where: { uq_blog_like_blog_user: { blogId: blog.id, userId: user.id } },
          select: { deleted: true },
        })
      : Promise.resolve(null),
    // 星标按钮的初始态。只查「有没有」—— 刻意**不查总数**：站内不显示被收藏数。
    user ? isBlogFavorited(user.id, blog.id) : Promise.resolve(false),
  ]);

  const isAuth = !!user;
  const isCore = isCoreUser(user);
  const isAdmin = hasAdminRights(user);
  const isAuthor = !!user && user.id === blog.authorId;
  const canManage = isAdmin || isAuthor;
  const isAdminDelete = isAdmin && !isAuthor;
  const liked = !!likeRow && !likeRow.deleted;

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
        <MarkdownRenderer content={blog.content?.content ?? ''} />

        <FeedButton
          blogId={blog.id}
          blogTitle={blog.title}
          initialFed={feedStatus.fed}
          initialFishCount={blog.fishCount ?? 0}
          isAuth={isAuth}
          isCore={isCore}
          initialLiked={liked}
          initialLikes={blog.likesCount ?? 0}
          canManage={canManage}
          canEdit={isAuthor}
          isAdminDelete={isAdminDelete}
          initialFavorited={favorited}
        />

        <CommentSection
          blogId={blog.id}
          currentUserId={user?.id ?? null}
          isAdmin={isAdmin}
          canComment={isCore}
        />
      </article>

      <FooterCopyOverride text={`作者：${blog.author?.username} | 版权归原作者所有`} />
    </>
  );
}