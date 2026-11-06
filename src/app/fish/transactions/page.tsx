import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getTransactions } from '@/lib/fish-service';
import { signedFish } from '@/lib/fish-amount';
import { ymdhm } from '@/lib/format';
import PageHeader from '@/app/components/PageHeader';
import SitePager from '@/app/components/SitePager';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  type?: string;
}

const FILTERS: { label: string; type: string | null }[] = [
  { label: '全部', type: null },
  { label: '签到', type: 'checkin' },
  { label: '投喂', type: 'feed_all' },
  { label: '共鸣', type: 'quote_all' },
  { label: '转账', type: 'transfer_all' },
  { label: '练手盘', type: 'market_all' },
  // 商城合称由 fish-service.applyTypeFilter 合并头像框与气泡两种租赁支出。
  { label: '商城', type: 'shop_all' },
  { label: '赠送', type: 'admin_grant' },
];

// 小鱼干流水页 — content-wrapper / page-title / fish-filter-bar 一套类名
export default async function FishTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect(loginUrlWithNext('/fish/transactions'));
  const sp = await searchParams;
  const page = Number.parseInt(sp.page || '1', 10) || 1;
  const typeFilter = sp.type ?? null;

  const data = await getTransactions(user.id, page, 20, typeFilter);

  const hrefFor = (p: number) => {
    const params = new URLSearchParams();
    params.set('page', String(p));
    if (typeFilter) params.set('type', typeFilter);
    return `/fish/transactions?${params.toString()}`;
  };
  const filterHref = (type: string | null) =>
    type ? `/fish/transactions?type=${type}` : '/fish/transactions';

  return (
    <div className="content-wrapper fish-page">
      <PageHeader
        title="小鱼干流水"
        back={{ href: '/fish', label: '返回账户' }}
        description="余额的进出来源与时间。"
      />

      <div className="fish-filter-bar" role="group" aria-label="按类型筛选">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            className={`filter-btn${typeFilter === f.type ? ' is-active' : ''}`}
            href={filterHref(f.type)}
            aria-current={typeFilter === f.type ? 'page' : undefined}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {data.transactions.length > 0 ? (
        <>
          <div className="fish-transaction-list">
            {data.transactions.map((tx) => (
              <div key={tx.id} className="fish-transaction">
                <div className="fish-transaction__icon">
                  {tx.amount > 0 ? (
                    <span className="fish-transaction__icon-in fish-transaction__icon--in">+</span>
                  ) : (
                    <span className="fish-transaction__icon-out fish-transaction__icon--out">-</span>
                  )}
                </div>
                <div className="fish-transaction__info">
                  <div className="fish-transaction__desc">
                    {tx.description || tx.type}
                  </div>
                  <div className="fish-transaction__meta">
                    <span className={`fish-transaction__type-tag fish-transaction__type-tag--${tx.type}`}>
                      {tx.type}
                    </span>
                    <span className="fish-transaction__time numeric">{ymdhm(tx.createdAt)}</span>
                  </div>
                </div>
                <div
                  className={`numeric fish-transaction__amount ${tx.amount > 0 ? 'fish-transaction__amount--in' : 'fish-transaction__amount--out'}`}
                >
                  {signedFish(tx.amount)}
                </div>
              </div>
            ))}
          </div>

          <SitePager page={data.page} pages={data.pages} href={hrefFor} />
        </>
      ) : (
        <div className="empty-state">
          <div className="empty-state-icon"><span className="icon icon-fish" aria-hidden="true" style={{ width: '3rem', height: '3rem' }}></span></div>
          <h3>暂无流水</h3>
          <p>还没有小鱼干交易记录，快去签到赚取吧！</p>
        </div>
      )}
    </div>
  );
}
