import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { getPublicProfile } from '@/lib/user-service';
import { prisma } from '@/lib/db';
import { ymd } from '@/lib/format';
import ProfileTabs from './ProfileTabs';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  core: '核心用户',
  admin: '管理员',
  owner: '站长',
};

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

  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: 'blogs' | 'comments' = rawTab === 'comments' ? 'comments' : 'blogs';
  const blogPage = parsePage(sp.blog_page);
  const commentPage = parsePage(sp.comment_page);

  const currentUser = await getCurrentUser();
  const isOwnProfile = currentUser?.id === profile.id;
  const isCoreAuthenticated = isCoreUser(currentUser);

  const showBlogs = isOwnProfile || profile.showRecentBlogs;
  const showComments = isOwnProfile || profile.showRecentComments;

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
    content: (c.content ?? '').slice(0, 120),
    createdAt: c.createdAt ? c.createdAt.toISOString() : null,
  }));

  return (
    <div className="profile-page">
      <div className="container">
        <section className="profile-hero">
          <div className="profile-hero__top">
            <div className="profile-hero__avatar">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/avatar/${profile.id}`} alt={profile.username} />
            </div>
            <div className="profile-hero__info">
              <div className="profile-hero__name-row">
                <span className="profile-hero__username">{profile.username}</span>
                <span className={`profile-hero__role-badge profile-hero__role-badge--${profile.role}`}>
                  {ROLE_LABEL[profile.role] ?? profile.role}
                </span>
              </div>

              <p
                className={`profile-hero__bio${!profile.bio ? ' profile-hero__bio--empty' : ''}`}
              >
                {profile.bio || '这个人还没有写简介…'}
              </p>

              <div className="profile-hero__meta">
                {profile.createdAt && (
                  <span>
                    <span className="icon icon-person" aria-hidden="true" />
                    注册于 {ymd(new Date(profile.createdAt))}
                  </span>
                )}
                {lastLogin && (
                  <span>最后登录 {ymd(new Date(lastLogin))}</span>
                )}
                {isOwnProfile && currentUser?.email && (
                  <span>
                    <span className="icon icon-envelope" aria-hidden="true" />
                    {currentUser.email}
                  </span>
                )}
              </div>
            </div>
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

          {isOwnProfile && (
            <div className="profile-actions">
              <Link href="/settings" className="profile-actions__btn profile-actions__btn--edit">
                <span className="icon icon-gear" aria-hidden="true" />
                账号设置
              </Link>
              {!isCoreAuthenticated && (
                <Link href="/authentic" className="profile-actions__btn profile-actions__btn--auth">
                  <span className="icon icon-person-circle" aria-hidden="true" />
                  去认证
                </Link>
              )}
            </div>
          )}
        </section>

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
    </div>
  );
}
