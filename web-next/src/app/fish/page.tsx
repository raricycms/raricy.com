import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance, getTodayCheckinFish } from '@/lib/fish-service';

// 小鱼干余额页 — 对齐 Flask auth/fish.html（余额 + 今日签到获得 + 查看流水 + 说明）。
// 门控对齐 Flask @login_required：任意已登录用户可访问，未登录跳登录页。
export const dynamic = 'force-dynamic'; // 依赖登录态与实时余额，禁用静态化

export default async function FishPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish'));

  const [driedFish, todayFish] = await Promise.all([
    getBalance(user.id),
    getTodayCheckinFish(user.id),
  ]);

  return (
    <div className="container" style={{ padding: '2rem 0' }}>
      <div className="card fish-card">
        <div className="fish-eyebrow">🐟 小鱼干</div>
        <div className="fish-balance">
          <span className="fish-balance__num">{driedFish.toFixed(4)}</span>
          <span className="fish-balance__label">小鱼干</span>
        </div>
        {todayFish > 0 && (
          <div className="fish-today">
            今日签到获得 <strong>+{todayFish}</strong> 小鱼干
          </div>
        )}
        <div className="fish-info">
          <Link className="btn btn--ghost btn--sm" href="/fish/transactions">
            📋 查看流水
          </Link>
        </div>
        <div className="fish-info">
          <p>每日签到可获得小鱼干，更多获取方式即将开放…</p>
        </div>
      </div>
    </div>
  );
}
