import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeftRight, ReceiptText, ShoppingBag, TrendingUp } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { isFocusFishTradeBlocked } from '@/lib/focus-mode';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import { fmtFish } from '@/lib/fish-amount';
import PosterModal from '@/app/components/PosterModal';
export const dynamic = 'force-dynamic';

export default async function FishPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish'));
  const balance = await getBalance(user.id);
  return <div className="container" style={{paddingTop:'2rem',paddingBottom:'2rem'}}>
    <div className="fish-card">
      <div className="fish-card__header"><h1 className="fish-card__title">小鱼干</h1></div>
      <div className="fish-card__body">
        <div className="fish-card__balance"><span className="fish-card__balance-number numeric">{fmtFish(balance)}</span><span className="fish-card__balance-label">小鱼干</span></div>
        <div className="fish-card__actions">
          <Link href="/fish/transfer" className="fish-card__link fish-card__link--primary"><ArrowLeftRight aria-hidden="true"/>转账</Link>
          <Link href="/fish/transactions" className="fish-card__link"><ReceiptText aria-hidden="true"/>流水</Link>
          <PosterModal triggerClassName="fish-card__link poster-trigger" label="收款码" src="/api/poster/collect" downloadName={`聪明山-${user.username}-收款码.png`} title="我的鱼干收款码" hint="扫码后填写金额并确认付款。" />
          <Link href="/fish/shop" className="fish-card__link"><ShoppingBag aria-hidden="true"/>商城</Link>
        </div>
        {!isFocusFishTradeBlocked(user) && <Link href="/fish/trade" className="fish-card__info-link"><TrendingUp aria-hidden="true"/>鱼干练手盘</Link>}
      </div>
    </div>
  </div>;
}
