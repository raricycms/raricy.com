import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ReceiptText } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance, getTodayCheckinFish } from '@/lib/fish-service';
import PosterModal from '@/app/components/PosterModal';

// 小鱼干余额页 — fish-card 一套类名
export const dynamic = 'force-dynamic';

export default async function FishPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish'));

  const [driedFish, todayFish] = await Promise.all([
    getBalance(user.id),
    getTodayCheckinFish(user.id),
  ]);

  return (
    <div className="container" style={{ paddingTop: '2rem', paddingBottom: '2rem' }}>
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
            {/* 文案拆成「前缀 + 正文」，前缀在窄屏由 CSS 隐藏（见 _fish.scss 的 480px 档）。
                ⚠️ 两段必须包在**同一个** <span> 里：.fish-card__link 是 inline-flex，
                散着写会让「查看」自己变成一个 flex 项，与「流水」之间吃一道 8px 的 gap ——
                桌面上就渲染成「查看 流水」（实测颗宽 120px，正常是 112px）。包起来之后整条
                文案是一个 flex 项，内部按行内文本连排，图标与文字之间只剩 flex 自己的 gap。
                图标与这段文案之间**不要留空格**（换行即可，JSX 会吃掉含换行的空白）。 */}
            <Link href="/fish/transactions" className="fish-card__link" aria-label="查看流水">
              <ReceiptText aria-hidden="true" />
              <span className="fish-card__link-label"><span className="fish-card__link-prefix">查看</span>流水</span>
            </Link>
            <Link href="/fish/market" className="fish-card__link fish-card__link--primary" aria-label="鱼干市场">
              <span className="icon icon-market" aria-hidden="true"></span>
              <span className="fish-card__link-label"><span className="fish-card__link-prefix">鱼干</span>市场</span>
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