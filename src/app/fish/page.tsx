import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeftRight, ReceiptText, ShoppingBag, TrendingUp } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { isFocusFishTradeBlocked } from '@/lib/focus-mode';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance } from '@/lib/fish-service';
import { fmtFish } from '@/lib/fish-amount';
import PageHeader from '@/app/components/PageHeader';
import FishEntry from './FishEntry';
import PosterModal from '@/app/components/PosterModal';
export const dynamic = 'force-dynamic';

export default async function FishPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish'));
  const balance = await getBalance(user.id);
  // 练手盘入口按专注模式整段不渲染（见 CLAUDE.md「档位阶梯」的专注模式例外）。
  const showTrade = !isFocusFishTradeBlocked(user);
  return <div className="container fish-page">
    <PageHeader title="小鱼干" />
    <div className="fish-account">
      <section className="fish-card" aria-label="账户余额与操作">
        <div className="fish-card__balance"><span className="fish-card__balance-label">余额</span><span className="fish-card__balance-number numeric">{fmtFish(balance)}</span></div>
        <div className="fish-card__actions">
          <Link href="/fish/transfer" className="fish-card__link fish-card__link--primary"><ArrowLeftRight aria-hidden="true"/>转账</Link>
          <Link href="/fish/transactions" className="fish-card__link"><ReceiptText aria-hidden="true"/>流水</Link>
          <PosterModal triggerClassName="fish-card__link poster-trigger" label="收款码" src="/api/poster/collect" downloadName={`聪明山-${user.username}-收款码.png`} title="我的鱼干收款码" hint="扫码后填写金额并确认付款。" />
        </div>
      </section>
      <section className="fish-more" aria-labelledby="fish-more-title">
        <h2 className="fish-more__title" id="fish-more-title">更多</h2>
        <ul className="fish-more__list">
          <li><FishEntry slug="shop" href="/fish/shop" icon={<ShoppingBag />} name="商城" desc="租用头像框与聊天气泡" /></li>
          {showTrade && <li><FishEntry slug="trade" href="/fish/trade" icon={<TrendingUp />} name="鱼干练手盘" desc="用小鱼干做多或做空真实行情" /></li>}
        </ul>
      </section>
    </div>
  </div>;
}
