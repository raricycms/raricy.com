import { notFound } from 'next/navigation';
import { requireCoreUser } from '@/lib/guard';
import { getBlogDetail } from '@/lib/blog-service';
import { prisma } from '@/lib/db';
import MarkdownRenderer from '@/app/components/MarkdownRenderer';
import CommentSection from '@/app/components/CommentSection';
import FeedButton from '@/app/components/FeedButton';
import { getCurrentUser, hasAdminRights, isCoreUser } from '@/lib/auth';
import { getFeedStatus } from '@/lib/feed-service';

export const dynamic = 'force-dynamic';

export default async function BlogDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCoreUser();
  const { id } = await params;
  const [blog, user] = await Promise.all([getBlogDetail(id), getCurrentUser()]);
  if (!blog) notFound();

  const [feedStatus, likeRow] = await Promise.all([
    user ? getFeedStatus(blog.id, user.id) : Promise.resolve({ fed: 0 }),
    user
      ? prisma.blogLike.findUnique({
          where: { uq_blog_like_blog_user: { blogId: blog.id, userId: user.id } },
          select: { deleted: true },
        })
      : Promise.resolve(null),
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
      <header className="read-hero">
        <h1>{blog.title}</h1>
        <div className="blog-meta" id="blog-meta">
          <span className="blog-date" id="blog-date"></span>
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
          footerCopyright={`作者：${blog.author?.username} | 版权归原作者所有`}
        />

        <CommentSection
          blogId={blog.id}
          currentUserId={user?.id ?? null}
          isAdmin={isAdmin}
          canComment={isCore}
        />
      </article>
    </>
  );
}