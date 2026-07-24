import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance, getTodayCheckinFish } from '@/lib/fish-service';

// 小鱼干余额页 — Flask BEM
export const dynamic = 'force-dynamic';

export default async function FishPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish'));

  const [driedFish, todayFish] = await Promise.all([
    getBalance(user.id),
    getTodayCheckinFish(user.id),
  ]);

  return (
    <div className="container" style={{ padding: '2rem 0' }}>
      <div className="fish-card">
        <div className="fish-card__header">
          <span className="fish-card__title">🐟 小鱼干</span>
        </div>
        <div className="fish-card__body">
          <div className="fish-card__balance">
            <span className="fish-card__balance-number">{driedFish.toFixed(4)}</span>
            <span className="fish-card__balance-label">小鱼干</span>
          </div>
          {todayFish > 0 && (
            <div className="fish-card__today">
              今日签到获得 <strong>+{todayFish}</strong> 小鱼干
            </div>
          )}
          <div className="fish-card__actions">
            <Link href="/fish/transactions" className="fish-card__link">📋 查看流水</Link>
          </div>
          <div className="fish-card__info">
            <p>每日签到可获得小鱼干，更多获取方式即将开放…</p>
          </div>
        </div>
      </div>
    </div>
  );
}