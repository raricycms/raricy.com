import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import {
  getTodayStatus,
  getCountLeaderboard,
  getFortuneLeaderboard,
} from '@/lib/checkin-service';
import CheckinCard, { CheckinLeaderboards } from '@/app/components/CheckinCard';

export const dynamic = 'force-dynamic'; // 依赖登录态与实时数据，禁用静态化

export default async function CheckinPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/checkin'));

  const [status, countLb, fortuneLb] = await Promise.all([
    getTodayStatus(user.id),
    getCountLeaderboard(),
    getFortuneLeaderboard(),
  ]);

  return (
    <main className="checkin-page container">
      <CheckinCard
        checkedIn={status.checkedIn}
        totalCount={status.totalCount}
        totalFortune={status.totalFortune}
        fortuneValue={status.fortuneValue}
        // 已签到但尚未翻牌 → 进页自动弹出运势卡（对齐 Flask today_status.fortune_pending）
        fortunePending={status.checkedIn && status.fortuneValue == null}
        today={status.today}
        username={user.username}
      />

      <CheckinLeaderboards
        countEntries={countLb}
        fortuneEntries={fortuneLb}
        currentUserId={user.id}
      />
    </main>
  );
}
