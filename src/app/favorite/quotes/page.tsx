import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listSavedQuotes } from '@/lib/daily-quote-service';
import SavedQuotes from './SavedQuotes';

export const dynamic = 'force-dynamic';

export default async function QuoteFavoritesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const user = await requireCoreUser();
  const { page } = await searchParams;
  const result = await listSavedQuotes(user.id, Number(page ?? 1));
  return <div className="container daily-quote-page">
    <header className="daily-quote-page__header"><h1>一言集</h1><Link href="/favorite" className="read-btn">返回我的收藏夹</Link></header>
    <p className="daily-quote-card__hint">仅自己可见，共 {result.total} 条。</p>
    {result.total ? <SavedQuotes rows={result.quotes} /> : <p>还没有收藏的一言。<Link href="/checkin">去签到看看今日一言</Link></p>}
    <nav className="daily-quote-pagination" aria-label="一言集分页">
      {result.page > 1 && <Link href={`/favorite/quotes?page=${result.page - 1}`} className="read-btn">上一页</Link>}
      {result.page < result.pages && <Link href={`/favorite/quotes?page=${result.page + 1}`} className="read-btn">下一页</Link>}
    </nav>
  </div>;
}
