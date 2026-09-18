import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { getPublicProfile } from '@/lib/user-service';
import { prisma } from '@/lib/db';
import { ymd } from '@/lib/format';
import ProfileTabs from './ProfileTabs';
import PosterModal from '@/app/components/PosterModal';

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

  // 必须先取登录态：本页**匿名可达**（主页画报的二维码把站外人引到这里），
  // 而 profile 里哪些字段对游客可见由查看者决定 —— 见 getPublicProfile 的分档口径。
  const currentUser = await getCurrentUser();
  const profile = await getPublicProfile(
    id,
    currentUser ? { id: currentUser.id, isCore: isCoreUser(currentUser) } : null
  );
  if (!profile) notFound();

  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: 'blogs' | 'comments' = rawTab === 'comments' ? 'comments' : 'blogs';
  const blogPage = parsePage(sp.blog_page);
  const commentPage = parsePage(sp.comment_page);

  const isOwnProfile = currentUser?.id === profile.id;
  const isCoreAuthenticated = isCoreUser(currentUser);
  // 与 getPublicProfile 里那条同口径：本人 或 core+。**两处必须一致** —— 服务层把
  // recentBlogs 按它清空了，页面若还用「用户开关」单独判，游客就会拿到一个空标签页
  // 或者（更糟）从这里直接查出一份完整列表。见 `showBlogs`。
  const canSeeContent = isOwnProfile || isCoreAuthenticated;

  // 两个开关管「本人愿不愿意展示」，canSeeContent 管「查看者够不够格」，正交，都要过。
  // 档位不够时是「没有这个标签页」，不是「列表为空」—— 后者等于承认内容存在。
  const showBlogs = canSeeContent && (isOwnProfile || profile.showRecentBlogs);
  const showComments = canSeeContent && (isOwnProfile || profile.showRecentComments);

  // 计数与获赞同样是「内容」：档位不够时**连查都不查**（计数本身就是信息 ——
  // 「这篇有 40 条讨论」在熟人社区里可能就够了）。四项一律用 canSeeContent 收口。
  const [blogsCount, commentsCount, likesAgg, extra] = await Promise.all([
    canSeeContent ? prisma.blog.count({ where: { authorId: profile.id, ignore: false } }) : 0,
    canSeeContent
      ? prisma.blogComment.count({
          where: { authorId: profile.id, isDeleted: false, blog: { ignore: false } },
        })
      : 0,
    canSeeContent
      ? prisma.blog.aggregate({
          where: { authorId: profile.id, ignore: false },
          _sum: { likesCount: true },
        })
      : null,
    // 档位不够时**连查都不查**：不把这个值取进内存，就不存在「渲染时忘了挡」的活口。
    canSeeContent
      ? prisma.user.findUnique({
          where: { id: profile.id },
          select: { lastLogin: true },
        })
      : null,
  ]);
  const likesReceived = likesAgg?._sum.likesCount ?? 0;
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
                {/* role 为 null = 查看者档位不够（游客 / 非 core）。徽章整块不渲染 ——
                    别退化成「空字符串的徽章」，那会留下一个没有说明的空胶囊。 */}
                {profile.role && (
                  <span className={`profile-hero__role-badge profile-hero__role-badge--${profile.role}`}>
                    {ROLE_LABEL[profile.role] ?? profile.role}
                  </span>
                )}
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

          {/* 没有「运势值」格：站内不展示运势值总和（见 lib/checkin-service.ts 末尾） */}
          {/* 计数也是内容：档位不够时整块不渲染 —— 只留头像 / 用户名 / 简介 / 注册时间 */}
          {canSeeContent && (
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
            </div>
          )}

          {isOwnProfile && (
            <div className="profile-actions">
              <Link href="/settings" className="profile-actions__btn profile-actions__btn--edit">
                <span className="icon icon-gear" aria-hidden="true" />
                账号设置
              </Link>
              {/* 画报只有本人能生成（路由同样只放行本人），所以入口只挂在自己的主页上 */}
              <PosterModal
                triggerClassName="profile-actions__btn profile-actions__btn--poster poster-trigger"
                label={
                  <>
                    <span className="icon icon-link" aria-hidden="true" />
                    生成画报
                  </>
                }
                src={`/api/poster/profile/${profile.id}`}
                downloadName={`聪明山-${profile.username}-主页画报.png`}
                title="我的主页画报"
                hint="保存后可以发到任何地方，扫图上的二维码就能打开你的主页。"
              />
              {!isCoreAuthenticated && (
                <Link href="/authentic" className="profile-actions__btn profile-actions__btn--auth">
                  <span className="icon icon-person-circle" aria-hidden="true" />
                  去认证
                </Link>
              )}
            </div>
          )}
        </section>

        {/* 档位不够时整个标签区不渲染。别退化成「两个标签页 + 一句未公开提示」——
            标签上的计数本身就把内容量透出去了。 */}
        {canSeeContent && (
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
        )}
      </div>
    </div>
  );
}
