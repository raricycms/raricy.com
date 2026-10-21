import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listNotifications, getUnreadCount } from '@/lib/notification-service';
import { nowForDb } from '@/lib/db-time';
import NotificationItems from '@/app/components/NotificationItems';
import PageJump from './PageJump';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  filter?: string;
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireCoreUser();

  const sp = await searchParams;
  const page = parseInt(sp.page || '1', 10);
  // 未知取值一律落回「全部」：过滤参数是用户可改的 URL 片段，
  // 不认识的档位静默当成全部，比 400 更像站内列表页的一贯做法。
  const filter = sp.filter === 'unread' ? 'unread' : 'all';

  const [result, unread] = await Promise.all([
    listNotifications(user.id, {
      page: Number.isNaN(page) ? 1 : page,
      unreadOnly: filter === 'unread',
    }),
    getUnreadCount(user.id),
  ]);

  // 翻页链接带着筛选走 —— 丢掉 filter 会变成「在未读里翻到第 2 页，回来却是全部」。
  const qs = (p: number) =>
    filter === 'unread' ? `?filter=unread&page=${p}` : `?page=${p}`;

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
    <div className="content-wrapper notifications-page">
      <h1 className="page-title">我的通知</h1>

      {/*
        key 必须带 filter 与 page —— NotificationItems 用 useState(initial) 持有列表
        （标记已读/删除就地更新 UI 需要），而翻页 / 切筛选都是同路由软导航，
        组件**不重挂载**，新 props 进不了 state：URL 与 SSR 都换了，列表却纹丝不动。
        带 key 让每次换视图重挂载一次，state 随之重置。
        （别改成 useEffect 同步 props：那会和「就地更新」的 setItems 打架。）
      */}
      <NotificationItems
        key={`${filter}-${result.page}`}
        initial={result.notifications}
        filter={filter}
        initialTotal={result.total}
        initialUnread={unread}
        // 分组标题的「今天 / 昨天」按服务端墙钟算，避免 SSR 与客户端跨零点不一致。
        today={nowForDb().toISOString().slice(0, 10)}
      />

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
                className={`numeric page-link${p === result.page ? ' active' : ''}`}
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
