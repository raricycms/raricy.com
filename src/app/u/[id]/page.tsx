import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { getPublicProfile } from '@/lib/user-service';
import { getProfilePageData } from '@/lib/profile-service';
import { ymd } from '@/lib/format';
import Avatar from '@/app/components/Avatar';
import PosterModal from '@/app/components/PosterModal';
import ProfileBoard from './ProfileBoard';

// 个人主页 —— 对外名片 + 可自由布置的「积木墙」。
//
// 【它现在是什么】一张匿名可达的名片：上半截是固定的身份条（头像 + 头像框、用户名、
// 简介、注册时间），下半截是用户自己挑、自己摆的积木网格。**旧的文章/评论标签页
// 已经删掉**：评论不能上公开主页（匿名承诺），文章列表改成了「作者亲手挑的精选」。
//
// 【为什么不再有 core+ 分档】旧页是「站内档案」，内容对 core+ 才开；新页是「对外
// 名片」，挂的东西全部本来就对外可读（public / link 档文章、isPublic 的图与音频）。
// 所以这里没有 canSeeContent —— 有的话反而会在某个分支漏挡。
//
// 【noindex】主页是可被二维码传播的个人名片，不进索引。这条同时保护 link 档
// 文章不被搜索引擎把题录带走（link 的语义是「可读、不列举、不索引」）。
export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  user: '用户',
  core: '核心用户',
  admin: '管理员',
  owner: '站长',
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 只取用户名，别为了一份 metadata 把整页数据拉一遍。
  const profile = await getPublicProfile(id, null);
  return {
    title: profile ? `${profile.username} 的主页` : '个人主页',
    robots: { index: false, follow: false },
  };
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

  // 先取登录态：本页匿名可达（主页画报的二维码把站外人引到这里），
  // 而 profile 里哪些字段给游客由 getPublicProfile 决定（role 对游客是 null）。
  const currentUser = await getCurrentUser();
  const profile = await getPublicProfile(
    id,
    currentUser ? { id: currentUser.id, isCore: isCoreUser(currentUser) } : null
  );
  if (!profile) notFound();

  const isOwnProfile = currentUser?.id === profile.id;
  // 「能不能布置」= 本人 + core。非核心用户照常能看自己的主页，只是不能编辑
  //（产品决定：2026-10 先只对 core+ 开）。
  const canEdit = isOwnProfile && isCoreUser(currentUser);
  const data = await getProfilePageData(profile.id, {
    isOwner: canEdit,
    // 默认布局（还没布置过）要不要自动挂最近文章，沿用设置页那个旧开关。
    showRecentBlogs: profile.showRecentBlogs,
  });

  const rawEdit = Array.isArray(sp.edit) ? sp.edit[0] : sp.edit;
  const startEditing = rawEdit === '1' && canEdit;

  return (
    <div className="profile-page">
      <div className="container">
        {/* 身份条：整页唯一不可定制的部分。二维码落地时第一眼必须知道这是谁。 */}
        <section className="profile-hero">
          <Avatar
            userId={profile.id}
            frameUrl={profile.frameUrl}
            alt={profile.username}
            className="profile-hero__avatar"
          />
          <div className="profile-hero__info">
            <div className="profile-hero__name-row">
              <h1 className="profile-hero__username">{profile.username}</h1>
              {profile.role && (
                <span className={`profile-hero__role-badge profile-hero__role-badge--${profile.role}`}>
                  {ROLE_LABEL[profile.role] ?? profile.role}
                </span>
              )}
            </div>
            <p className={`profile-hero__bio${!profile.bio ? ' profile-hero__bio--empty' : ''}`}>
              {profile.bio || '这个人还没有写简介…'}
            </p>
            <div className="profile-hero__meta">
              {profile.createdAt && (
                <span>
                  <span className="icon icon-person" aria-hidden="true" />
                  注册于 <span className="numeric">{ymd(new Date(profile.createdAt))}</span>
                </span>
              )}
            </div>
          </div>

          {isOwnProfile && (
            <div className="profile-hero__actions">
              {/* 全页唯一一颗「布置主页」（编辑态隐藏，否则会同时存在「正在布置」与
                  「去布置」两种入口）。页内的引导面板 / 空态只留文案，不再各放一颗。 */}
              {canEdit && !startEditing && (
                <Link
                  href={`/u/${profile.id}?edit=1`}
                  className="profile-actions__btn profile-actions__btn--edit"
                >
                  <span className="icon icon-add" aria-hidden="true" />
                  布置主页
                </Link>
              )}
              <Link href="/settings" className="profile-actions__btn">
                <span className="icon icon-gear" aria-hidden="true" />
                账号设置
              </Link>
              {/* 画报只有本人能生成（路由同样只放行本人），所以入口只挂在自己的主页上 */}
              <PosterModal
                triggerClassName="profile-actions__btn poster-trigger"
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
            </div>
          )}
        </section>

        <ProfileBoard
          profileId={profile.id}
          blocks={data.blocks}
          catalog={data.catalog}
          isDefault={data.isDefault}
          canEdit={canEdit}
          isOwner={isOwnProfile}
          startEditing={startEditing}
        />

        {isOwnProfile && !canEdit && (
          <p className="profile-tier-note">
            布置主页目前对核心用户开放。你仍然可以设置头像、简介与头像框。
          </p>
        )}
      </div>
    </div>
  );
}
