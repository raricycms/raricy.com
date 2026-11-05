import { forbidden } from 'next/navigation';
import { isCurrentlyBanned } from '@/lib/auth';
import { requireCoreUser } from '@/lib/guard';
import { getTodayStatus, getCountLeaderboard } from '@/lib/checkin-service';
import CheckinCard, { CheckinLeaderboards } from '@/app/components/CheckinCard';
import Link from 'next/link';
import QuoteBlogRequired from '@/app/components/QuoteBlogRequired';
import PageHeader from '@/app/components/PageHeader';

// 签到 = 每日领鱼干，档位是 **core+**（与投喂、点赞、剪贴板同档）。
//
// 【为什么不是「登录即可」】鱼干在站内是 core+ 体系的报酬：赚取渠道（签到、投喂分成）
// 全在 core+ 门槛之后。放开签到等于给未认证账号开一条自助领鱼干的口子 —— 而它拿到
// 鱼干也没有出口（发文章、投喂、投票都要 core+），只会把「补偿/空投」的口子留在站内。
// 非核心用户在 UI 里仍看得到签到入口（与讨论、博客一致，见 Navbar），点进来是 403。
//
// 回跳地址显式传 `/checkin`（不让守卫从 referer 推）：签到从顶栏图标进来，直连 /
// 书签时没有 referer。`access-control.spec` 钉住了 `next=%2Fcheckin`。
export const dynamic = 'force-dynamic';

export default async function CheckinPage() {
  const user = await requireCoreUser('/checkin');
  if (isCurrentlyBanned(user)) forbidden();

  const [status, countLb] = await Promise.all([getTodayStatus(user.id), getCountLeaderboard()]);

  return (
    <div className="checkin-page">
      <PageHeader
        title="每日签到"
        actions={<Link href="/quotes" className="page-header__action">每日一言</Link>}
      />
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
        <div className="checkin-card checkin-card--guidance">
          <div className="checkin-card__header">
            <span className="checkin-card__greeting">你好，{user.username}</span>
            <span className="checkin-card__date numeric">{status.today}</span>
          </div>
          <QuoteBlogRequired embedded purpose="checkin" />
        </div>
      )}

      <CheckinLeaderboards countEntries={countLb} currentUserId={user.id} />
    </div>
  );
}
