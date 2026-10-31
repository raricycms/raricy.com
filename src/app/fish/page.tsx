import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeftRight, ChevronRight, ReceiptText, ShoppingBag, TrendingUp } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { isFocusFishTradeBlocked } from '@/lib/focus-mode';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getBalance, getTransactions } from '@/lib/fish-service';
import { fmtFish } from '@/lib/fish-amount';
import PageHeader from '@/app/components/PageHeader';
import FishEntry from './FishEntry';
import PosterModal from '@/app/components/PosterModal';
export const dynamic = 'force-dynamic';

// 展示用时间：库内是「UTC+8 墙上时间贴 Z」，一律 getUTC* 读（见 src/lib/db-time.ts）。
// 与 /fish/transactions 的格式化同口径，精确到分钟。
function fmtTxTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export default async function FishPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish'));
  const [balance, recent] = await Promise.all([
    getBalance(user.id),
    getTransactions(user.id, 1, 5),
  ]);
  // 练手盘入口按专注模式整段不渲染（见 CLAUDE.md「档位阶梯」的专注模式例外）。
  const showTrade = !isFocusFishTradeBlocked(user);

  return <div className="container fish-page">
    <PageHeader title="小鱼干" />

    <section className="fish-card fish-overview" aria-label="账户余额与操作">
      <div className="fish-card__balance">
        <span className="fish-card__balance-label">余额</span>
        <span className="fish-card__balance-value">
          <span className="fish-card__balance-number numeric">{fmtFish(balance)}</span>
          <span className="fish-card__balance-unit">小鱼干</span>
        </span>
      </div>
      <div className="fish-card__actions">
        <Link href="/fish/transfer" className="fish-card__link fish-card__link--primary"><ArrowLeftRight aria-hidden="true"/>转账</Link>
        <Link href="/fish/transactions" className="fish-card__link"><ReceiptText aria-hidden="true"/>流水</Link>
        <PosterModal triggerClassName="fish-card__link poster-trigger" label="收款码" src="/api/poster/collect" downloadName={`聪明山-${user.username}-收款码.png`} title="我的鱼干收款码" hint="扫码后填写金额并确认付款。" />
      </div>
    </section>

    <section className="fish-services" aria-label="鱼干服务">
      <ul className="fish-services__grid">
        <li className="fish-service"><FishEntry slug="shop" href="/fish/shop" icon={<ShoppingBag />} name="商城" desc="租用头像框与聊天气泡" /></li>
        {showTrade && <li className="fish-service"><FishEntry slug="trade" href="/fish/trade" icon={<TrendingUp />} name="鱼干练手盘" desc="用小鱼干做多或做空真实行情" /></li>}
      </ul>
    </section>

    <section className="fish-recent" aria-labelledby="fish-recent-title">
      <div className="fish-recent__head">
        <h2 className="fish-recent__title" id="fish-recent-title">最近流水</h2>
        <Link href="/fish/transactions" className="fish-recent__all">查看全部<ChevronRight aria-hidden="true" /></Link>
      </div>
      {recent.transactions.length > 0 ? (
        <div className="fish-recent__list">
          {recent.transactions.map((tx) => (
            <div className="fish-recent__row" key={tx.id}>
              <div className="fish-recent__text">
                <span className="fish-recent__desc">{tx.description || tx.type}</span>
                <span className="fish-recent__time numeric">{fmtTxTime(tx.createdAt)}</span>
              </div>
              <span className={`fish-recent__amount numeric ${tx.amount > 0 ? 'fish-recent__amount--in' : 'fish-recent__amount--out'}`}>
                {tx.amount > 0 ? '+' : ''}{fmtFish(tx.amount)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="fish-recent__empty">还没有小鱼干流水。</p>
      )}
    </section>
  </div>;
}
