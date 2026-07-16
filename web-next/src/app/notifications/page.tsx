import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listNotifications, getUnreadCount } from '@/lib/notification-service';
import NotificationItems from '@/app/components/NotificationItems';
import PageJump from './PageJump';

export const dynamic = 'force-dynamic'; // 依赖登录态与查询参数

interface SearchParams {
  page?: string;
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // 对齐 Flask @authenticated_required：未登录/非核心用户直接跳转，不在页内渲染登录板块。
  const user = await requireCoreUser();

  const sp = await searchParams;
  const page = parseInt(sp.page || '1', 10);
  // getUnreadCount 保持调用（对齐原有数据获取），列表内未读计数由客户端组件自行推导。
  const [result] = await Promise.all([
    listNotifications(user.id, { page: Number.isNaN(page) ? 1 : page }),
    getUnreadCount(user.id),
  ]);

  const qs = (p: number) => `?page=${p}`;

  // 分页 window-of-3（对齐 blog 列表与 notifications.html：首末页恒显，
  // 当前页 ±3 展开，断档处以省略号占位）。
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
    <div className="pwrap pwrap--narrow">
      <h1 className="ptitle" style={{ margin: 0 }}>
        我的通知
      </h1>

      <NotificationItems initial={result.notifications} />

      {result.pages > 1 && (
        <div className="pagination">
          {result.hasPrev && (
            <Link className="page-link" href={qs(result.page - 1)}>
              &laquo;
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
                className={`page-link ${p === result.page ? 'active' : ''}`}
              >
                {p}
              </Link>
            )
          )}
          {result.hasNext && (
            <Link className="page-link" href={qs(result.page + 1)}>
              &raquo;
            </Link>
          )}
          <PageJump totalPages={result.pages} current={result.page} />
        </div>
      )}
    </div>
  );
}
