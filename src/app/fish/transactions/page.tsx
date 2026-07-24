import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { loginUrlWithNext } from '@/lib/safe-url';
import { getTransactions } from '@/lib/fish-service';
import FishPageJump from '../FishPageJump';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  type?: string;
}

// 对齐 datetime_format('%Y-%m-%d %H:%M')
function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const FILTERS: { label: string; type: string | null }[] = [
  { label: '全部', type: null },
  { label: '签到', type: 'checkin' },
  { label: '投喂', type: 'feed_all' },
  { label: '赠送', type: 'admin_grant' },
  { label: '消费', type: 'purchase' },
];

// 小鱼干流水页 — Flask BEM
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

  const prevNum = data.hasPrev ? data.page - 1 : null;
  const nextNum = data.hasNext ? data.page + 1 : null;
  const WINDOW = 3;

  return (
    <div className="content-wrapper">
      <h1 className="page-title">🐟 小鱼干流水</h1>

      <div className="fish-filter-bar">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            className={`filter-btn${typeFilter === f.type ? ' active' : ''}`}
            href={filterHref(f.type)}
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
                    <span className="fish-transaction__time">{fmtDateTime(tx.createdAt)}</span>
                  </div>
                </div>
                <div
                  className={`fish-transaction__amount ${tx.amount > 0 ? 'fish-transaction__amount--in' : 'fish-transaction__amount--out'}`}
                >
                  {tx.amount > 0 ? '+' : ''}
                  {tx.amount}
                </div>
              </div>
            ))}
          </div>

          {data.pages > 1 && (
            <div className="pagination">
              {data.hasPrev && prevNum !== null && (
                <Link className="page-link" href={hrefFor(prevNum)}>
                  &laquo;
                </Link>
              )}

              {Array.from({ length: data.pages }, (_, i) => i + 1).map((p) => {
                if (
                  p === 1 ||
                  p === data.pages ||
                  (p >= data.page - WINDOW && p <= data.page + WINDOW)
                ) {
                  return (
                    <Link
                      key={p}
                      className={`page-link${p === data.page ? ' active' : ''}`}
                      href={hrefFor(p)}
                    >
                      {p}
                    </Link>
                  );
                }
                if (p === data.page - WINDOW - 1 || p === data.page + WINDOW + 1) {
                  return (
                    <span key={p} className="page-ellipsis">...</span>
                  );
                }
                return null;
              })}

              {data.hasNext && nextNum !== null && (
                <Link className="page-link" href={hrefFor(nextNum)}>
                  &raquo;
                </Link>
              )}

              <span className="page-jump">
                <FishPageJump totalPages={data.pages} current={data.page} />
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="empty-state">
          <div className="empty-state-icon">🐟</div>
          <h3>暂无流水</h3>
          <p>还没有小鱼干交易记录，快去签到赚取吧！</p>
        </div>
      )}
    </div>
  );
}