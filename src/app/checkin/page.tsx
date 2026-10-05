import { redirect, forbidden } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getTodayStatus, getCountLeaderboard } from '@/lib/checkin-service';
import CheckinCard, { CheckinLeaderboards } from '@/app/components/CheckinCard';

// 签到 = 每日领鱼干，档位是 **core+**（与投喂、点赞、剪贴板同档）。
//
// 【为什么不是「登录即可」】鱼干在站内是 core+ 体系的报酬：赚取渠道（签到、投喂分成）
// 全在 core+ 门槛之后。放开签到等于给未认证账号开一条自助领鱼干的口子 —— 而它拿到
// 鱼干也没有出口（发文章、投喂、投票都要 core+），只会把「补偿/空投」的口子留在站内。
// 非核心用户在 UI 里仍看得到签到入口（与讨论、博客一致，见 Navbar），点进来是 403。
//
// 【为什么不用 guard.ts 的 requireCoreUser】那个门的 next 取自 referer（见 guard.ts
// 的说明），而签到是从顶栏那个图标进来的：直连 / 书签 / 无 referer 时它会退化成
// `next=/`，登录完被扔回首页而不是签到页。这里与 /fish/* 各页同款 —— 路径是已知的，
// 直接写死进 next。access-control.spec 把这条钉死了（`next=%2Fcheckin`）。
export const dynamic = 'force-dynamic';

// 引导态那条链的落点：博客目录 + 预填「自我介绍」的搜索。
// 不是 /blog/upload —— 新人还不知道该写什么，先让他看见别人怎么写；目录页右侧
// 就有「创建文章」入口。搜索词的编码必须与 SearchForm 的 GET 表单一致（`search`）。
const INTRO_SEARCH_HREF = `/blog?search=${encodeURIComponent('自我介绍')}`;

export default async function CheckinPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/checkin'));
  if (!isCoreUser(user)) forbidden();

  const [status, countLb] = await Promise.all([getTodayStatus(user.id), getCountLeaderboard()]);

  return (
    <div className="checkin-page">
      {status.canCheckIn ? (
        <CheckinCard
          checkedIn={status.checkedIn}
          totalCount={status.totalCount}
          todayFish={status.todayFish}
          rewardFish={status.rewardFish}
          today={status.today}
          username={user.username}
        />
      ) : (
        // 前置条件未满足（没发过未软删的文章）：渲染引导而不是签到按钮 ——
        // 留一个点了 403 的按钮比不给更糟（判据与档位入口相反：这里不是「档位不够、
        // 入口照给」，而是「这一步现在做不了、先去做另一件他能做的事」）。
        <div className="checkin-card">
          <div className="checkin-card__header">
            <span className="checkin-card__greeting">你好，{user.username}</span>
            <span className="checkin-card__date">{status.today}</span>
          </div>
          <div className="checkin-reward-hint" style={{ marginBottom: 16 }}>
            签到只对<b>发布过文章</b>的用户开放。你名下还没有未删除的文章（发过又全部删除
            也算没有）。不妨先发一篇<b>自我介绍</b> —— 让大家认识你，发完就能来签到，
            每天领 {status.rewardFish} 条小鱼干。
          </div>
          <Link href={INTRO_SEARCH_HREF} className="btn btn-primary">
            看看大家的「自我介绍」
          </Link>
        </div>
      )}

      <CheckinLeaderboards countEntries={countLb} currentUserId={user.id} />
    </div>
  );
}
