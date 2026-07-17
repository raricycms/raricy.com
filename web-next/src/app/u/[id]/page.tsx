import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { getPublicProfile } from '@/lib/user-service';
import { prisma } from '@/lib/db';
import { ymd } from '@/lib/format';
import ProfileTabs from './ProfileTabs';

export const dynamic = 'force-dynamic';

// 每页条数，对齐 Flask profile.py 的 per_page=20。
const PAGE_SIZE = 20;

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  core: '核心用户',
  admin: '管理员',
  owner: '站长',
};

const ROLE_BADGE: Record<string, string> = {
  user: 'role-badge--user',
  core: 'role-badge--core',
  admin: 'role-badge--admin',
  owner: 'role-badge--owner',
};

/** 解析页码查询参数（对齐 Flask request.args.get(..., 1, type=int)）：非法或 <1 归 1。 */
function parsePage(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export default async function PublicProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const profile = await getPublicProfile(id);
  if (!profile) notFound();

  // 查询参数（对齐 profile.py）：tab / blog_page / comment_page，两个 tab 的页码相互独立且并存于 URL。
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: 'blogs' | 'comments' = rawTab === 'comments' ? 'comments' : 'blogs';
  const blogPage = parsePage(sp.blog_page);
  const commentPage = parsePage(sp.comment_page);

  // 是否本人主页：邮箱与操作按钮仅本人可见（对齐 profile.html 的 user == current_user 判断）
  const currentUser = await getCurrentUser();
  const isOwnProfile = currentUser?.id === profile.id;
  const isCoreAuthenticated = isCoreUser(currentUser);

  // 隐私可见性：本人始终可见，他人受隐私设置控制（对齐 profile.py：is_owner or show_recent_*）。
  const showBlogs = isOwnProfile || profile.showRecentBlogs;
  const showComments = isOwnProfile || profile.showRecentComments;

  // 统计数字 + 最后登录（getPublicProfile 不含这些字段，故直接查 prisma 补齐，
  // 对齐 profile.html 的 blogs_count / likes_received / comments_count / 运势值）。
  const [blogsCount, commentsCount, likesAgg, extra] = await Promise.all([
    prisma.blog.count({ where: { authorId: profile.id, ignore: false } }),
    prisma.blogComment.count({
      where: { authorId: profile.id, isDeleted: false, blog: { ignore: false } },
    }),
    prisma.blog.aggregate({
      where: { authorId: profile.id, ignore: false },
      _sum: { likesCount: true },
    }),
    prisma.user.findUnique({
      where: { id: profile.id },
      select: { totalFortune: true, lastLogin: true },
    }),
  ]);
  const likesReceived = likesAgg._sum.likesCount ?? 0;
  const totalFortune = extra?.totalFortune ?? 0;
  const lastLogin = extra?.lastLogin ?? null;

  // 服务端真实分页（对齐 Flask 的 .paginate(page=..., per_page=20)）：按当前页码 skip/take 一整页数据，
  // 页码越界返回空条目（对齐 error_out=False）。翻页通过链接整页刷新（见 ProfileTabs 的分页条）。
  const blogsPages = Math.max(1, Math.ceil(blogsCount / PAGE_SIZE));
  const commentsPages = Math.max(1, Math.ceil(commentsCount / PAGE_SIZE));

  const blogRows = showBlogs
    ? await prisma.blog.findMany({
        where: { authorId: profile.id, ignore: false },
        orderBy: { createdAt: 'desc' },
        skip: (blogPage - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          title: true,
          createdAt: true,
          likesCount: true,
          description: true,
          commentsCount: true,
        },
      })
    : [];

  const commentRows = showComments
    ? await prisma.blogComment.findMany({
        where: { authorId: profile.id, isDeleted: false, blog: { ignore: false } },
        orderBy: { createdAt: 'desc' },
        skip: (commentPage - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          blogId: true,
          content: true,
          createdAt: true,
          blog: { select: { title: true } },
        },
      })
    : [];

  const blogItems = blogRows.map((b) => ({
    id: b.id,
    title: b.title,
    createdAt: b.createdAt ? b.createdAt.toISOString() : null,
    likesCount: b.likesCount ?? 0,
    description: b.description ?? '',
    commentsCount: b.commentsCount ?? 0,
  }));

  const commentItems = commentRows.map((c) => ({
    id: c.id,
    blogId: c.blogId,
    blogTitle: c.blog?.title ?? '',
    content: (c.content ?? '').slice(0, 120), // 对齐 Flask content[:120]
    createdAt: c.createdAt ? c.createdAt.toISOString() : null,
  }));

  return (
    <div className="wrap profile-page">
      <div className="card profile-hero">
        <div className="profile-hero__top">
          <div className="profile-hero__avatar">
            {/* 头像走 /api/avatar/[id]，由 id 确定性生成 SVG identicon */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/avatar/${profile.id}`} alt={profile.username} />
          </div>
          <div className="profile-hero__info">
            <div className="profile-name-row">
              <span className="profile-username">{profile.username}</span>
              <span className={`role-badge ${ROLE_BADGE[profile.role] ?? 'role-badge--user'}`}>
                {ROLE_LABEL[profile.role] ?? profile.role}
              </span>
            </div>

            <div className={`profile-bio ${profile.bio ? '' : 'profile-bio--empty'}`}>
              {profile.bio ? profile.bio : '这个人还没有写简介…'}
            </div>

            <div className="profile-meta">
              {profile.createdAt && (
                <span>
                  <span className="icon icon-person"></span>注册于 {ymd(new Date(profile.createdAt))}
                </span>
              )}
              {lastLogin && <span>最后登录 {ymd(new Date(lastLogin))}</span>}
              {/* 邮箱仅本人可见（隐私），取自当前登录用户而非公开 profile */}
              {isOwnProfile && currentUser?.email && (
                <span>
                  <span className="icon icon-envelope"></span>
                  {currentUser.email}
                </span>
              )}
            </div>

            <div className="profile-stats">
              <div className="profile-stats__item">
                <div className="profile-stats__number">{blogsCount}</div>
                <div className="profile-stats__label">文章</div>
              </div>
              <div className="profile-stats__item">
                <div className="profile-stats__number">{likesReceived}</div>
                <div className="profile-stats__label">获赞</div>
              </div>
              <div className="profile-stats__item">
                <div className="profile-stats__number">{commentsCount}</div>
                <div className="profile-stats__label">评论</div>
              </div>
              <div className="profile-stats__item">
                <div className="profile-stats__number">{totalFortune}</div>
                <div className="profile-stats__label">运势值</div>
              </div>
            </div>

            {/* 本人主页专属操作行（对齐 profile.html 的 profile-actions） */}
            {isOwnProfile && (
              <div className="profile-actions">
                <Link href="/settings" className="btn btn--ghost btn--sm">
                  <span className="icon icon-gear"></span>账号设置
                </Link>
                {/* 「去认证」对齐 Flask auth.authentic（专门的邀请码认证页），指向 /authentic */}
                {!isCoreAuthenticated && (
                  <Link href="/authentic" className="btn btn--primary btn--sm">
                    <span className="icon icon-person-circle"></span>去认证
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <ProfileTabs
        userId={profile.id}
        initialTab={tab}
        blogsCount={blogsCount}
        commentsCount={commentsCount}
        showBlogs={showBlogs}
        showComments={showComments}
        blogItems={blogItems}
        commentItems={commentItems}
        blogPage={blogPage}
        blogPages={blogsPages}
        commentPage={commentPage}
        commentPages={commentsPages}
      />
    </div>
  );
}
