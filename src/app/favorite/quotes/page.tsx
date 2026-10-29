import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listSavedQuotes } from '@/lib/daily-quote-service';
import SitePager from '@/app/components/SitePager';
import DailyQuoteNav from '@/app/components/DailyQuoteNav';
import SavedQuotes from './SavedQuotes';
import { hasPublishedBlog } from '@/lib/checkin-service';
import QuoteBlogRequired from '@/app/components/QuoteBlogRequired';

export const dynamic = 'force-dynamic';

export default async function QuoteFavoritesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireCoreUser();
  if (!(await hasPublishedBlog(user.id))) return <QuoteBlogRequired />;
  const { page } = await searchParams;
  const result = await listSavedQuotes(user.id, Number(page ?? 1));

  return (
    <div className="container daily-quote-page">
      <header className="daily-quote-page__header">
        <h1>一言集</h1>
        <Link href="/favorite" className="read-btn">返回我的收藏夹</Link>
      </header>

      <DailyQuoteNav current="saved" />

      <p className="daily-quote-page__note">
        仅自己可见，共 {result.total} 条。按收藏时间排序；内容下架后仅保留占位。
      </p>

      {result.total ? (
        <SavedQuotes rows={result.quotes} />
      ) : (
        <div className="daily-quote-state">
          <p>还没有收藏的一言。</p>
          {/* 不需要等下一次签到：往期里就有可以收藏的内容。 */}
          <Link href="/checkin/quotes" className="read-btn">去往期一言看看</Link>
        </div>
      )}

      <SitePager page={result.page} pages={result.pages} href={(p) => `/favorite/quotes?page=${p}`} />
    </div>
  );
}
