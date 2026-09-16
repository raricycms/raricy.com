import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ReceiptText } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance, getTodayCheckinFish } from '@/lib/fish-service';
import PosterModal from '@/app/components/PosterModal';

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
          <span className="fish-card__title"><span className="icon icon-fish" aria-hidden="true" style={{ marginRight: '0.5rem' }}></span>小鱼干</span>
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
            <Link href="/fish/transactions" className="fish-card__link">
              <ReceiptText aria-hidden="true" /> 查看流水
            </Link>
            <Link href="/fish/market" className="fish-card__link fish-card__link--primary">
              <span className="icon icon-market" aria-hidden="true"></span> 鱼干市场
            </Link>
            {/* 收款码：生成一张图，别人扫了就能给我投喂 */}
            <PosterModal
              triggerClassName="fish-card__link poster-trigger"
              label={
                <>
                  <span className="icon icon-fish" aria-hidden="true" /> 收款码
                </>
              }
              src="/api/poster/collect"
              downloadName={`聪明山-${user.username}-收款码.png`}
              title="我的鱼干收款码"
              hint="别人扫码后会打开收款页，由他自己填金额，再输密码确认付款。"
            />
          </div>
          <div className="fish-card__info">
            <p>每日签到可获得小鱼干，更多获取方式即将开放…</p>
          </div>
        </div>
      </div>
    </div>
  );
}