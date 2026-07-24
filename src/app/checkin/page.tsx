import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import {
  getTodayStatus,
  getCountLeaderboard,
  getFortuneLeaderboard,
} from '@/lib/checkin-service';
import CheckinCard, { CheckinLeaderboards } from '@/app/components/CheckinCard';

export const dynamic = 'force-dynamic';

export default async function CheckinPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/checkin'));

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
        fortunePending={status.checkedIn && status.fortuneValue == null}
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
