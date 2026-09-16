import { redirect, forbidden } from 'next/navigation';
import { getCurrentUser, isCoreUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import {
  getTodayStatus,
  getCountLeaderboard,
  getFortuneLeaderboard,
} from '@/lib/checkin-service';
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

export default async function CheckinPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/checkin'));
  if (!isCoreUser(user)) forbidden();

  const [status, countLb, fortuneLb] = await Promise.all([
    getTodayStatus(user.id),
    getCountLeaderboard(),
    getFortuneLeaderboard(),
  ]);

  return (
    <div className="checkin-page">
      <CheckinCard
        checkedIn={status.checkedIn}
        totalCount={status.totalCount}
        totalFortune={status.totalFortune}
        fortuneValue={status.fortuneValue}
        fortunePending={status.fortunePending}
        today={status.today}
        username={user.username}
      />

      <CheckinLeaderboards
        countEntries={countLb}
        fortuneEntries={fortuneLb}
        currentUserId={user.id}
      />
    </div>
  );
}
