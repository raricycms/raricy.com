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

  // 当前用户对本文的状态：已投喂量 + 是否已点赞（对齐 blog.liked / blog.user_fed）
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
  const canManage = isAdmin || isAuthor; // 显示管理区（管理员 或 作者）
  const isAdminDelete = isAdmin && !isAuthor; // 管理员删他人文章 → 需填写原因
  const liked = !!likeRow && !likeRow.deleted;

  return (
    <div className="read-wrap">
      {/* 文章头部信息（对齐 blog.html 的 read-hero） */}
      <section className="read-hero">
        <h1>{blog.title}</h1>
        <div className="blog-meta">
          <span className="blog-author">
            <img src={`/api/avatar/${blog.authorId}`} alt={blog.author?.username ?? ''} />
            {blog.author?.username}
          </span>
        </div>
      </section>

      {/* Markdown 正文（含内容引用预处理 + 公式 + 高亮双主题）*/}
      <MarkdownRenderer content={blog.content?.content ?? ''} />

      {/* 读者交互区：点赞 + 投喂（弹窗）+ 返回 + 管理员控制 + 模态框 */}
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

      {/* 评论系统组件 */}
      <CommentSection
        blogId={blog.id}
        currentUserId={user?.id ?? null}
        isAdmin={isAdmin}
        canComment={isCore}
      />
      {/* 单篇文章版权声明由 FeedButton 注入页脚 .footer-copy（对齐 blog.html 的
          {% block copyright %}），不再在正文 read-wrap 内单独渲染。*/}
    </div>
  );
}
