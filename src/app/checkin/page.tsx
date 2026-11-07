import { forbidden } from 'next/navigation';
import { isCurrentlyBanned } from '@/lib/auth';
import { requireCoreUser } from '@/lib/guard';
import { getTodayStatus, getCountLeaderboard } from '@/lib/checkin-service';
import CheckinCard, { CheckinLeaderboards } from '@/app/components/CheckinCard';
import Link from 'next/link';
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
      {/* 资格已在服务端统一判过：未归档 core+、当前未禁言。2026-11-07 P01 起不再要求
          发过文章，所以这里不再有「先发文章」引导态（原 QuoteBlogRequired 分支已删）。 */}
      <CheckinCard
        checkedIn={status.checkedIn}
        totalCount={status.totalCount}
        todayFish={status.todayFish}
        rewardFish={status.rewardFish}
        today={status.today}
        username={user.username}
      />

      <CheckinLeaderboards countEntries={countLb} currentUserId={user.id} />
    </div>
  );
}
