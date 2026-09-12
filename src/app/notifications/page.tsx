import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listNotifications, getUnreadCount } from '@/lib/notification-service';
import NotificationItems from '@/app/components/NotificationItems';
import PageJump from './PageJump';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCoreUser();

  const sp = await searchParams;
  const page = parseInt(sp.page || '1', 10);
  const [result] = await Promise.all([
    listNotifications(user.id, { page: Number.isNaN(page) ? 1 : page }),
    getUnreadCount(user.id),
  ]);

  const qs = (p: number) => `?page=${p}`;

  const win = 3;
  const pageItems: (number | '...')[] = [];
  for (let p = 1; p <= result.pages; p++) {
    if (p === 1 || p === result.pages || (p >= result.page - win && p <= result.page + win)) {
      pageItems.push(p);
    } else if (p === result.page - win - 1 || p === result.page + win + 1) {
      pageItems.push('...');
    }
  }

  return (
    <div className="content-wrapper">
      <h1 className="page-title">我的通知</h1>

      {/*
        key 必须带 page —— NotificationItems 用 useState(initial) 持有列表
        （标记已读/删除就地更新 UI 需要），而翻页是同路由软导航，组件**不重挂载**，
        新 props 进不了 state：URL 变成 ?page=2、SSR 也吐了第 2 页的数据，
        列表却纹丝不动。带 page 的 key 让每次翻页重挂载一次，state 随之重置。
        （别改成 useEffect 同步 props：那会和「就地更新」的 setItems 打架。）
      */}
      <NotificationItems key={result.page} initial={result.notifications} />

      {result.pages > 1 && (
        <nav className="pagination" aria-label="分页">
          {result.hasPrev && (
            <Link className="page-link" href={qs(result.page - 1)}>
              ‹
            </Link>
          )}
          {pageItems.map((p, i) =>
            p === '...' ? (
              <span key={`e${i}`} className="page-ellipsis">
                …
              </span>
            ) : (
              <Link
                key={p}
                href={qs(p)}
                className={`page-link${p === result.page ? ' active' : ''}`}
                aria-current={p === result.page ? 'page' : undefined}
              >
                {p}
              </Link>
            )
          )}
          {result.hasNext && (
            <Link className="page-link" href={qs(result.page + 1)}>
              ›
            </Link>
          )}
          <PageJump totalPages={result.pages} current={result.page} />
        </nav>
      )}
    </div>
  );
}