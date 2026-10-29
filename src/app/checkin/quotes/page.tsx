import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listQuoteHistory } from '@/lib/daily-quote-service';
import SitePager from '@/app/components/SitePager';
import DailyQuoteNav from '@/app/components/DailyQuoteNav';
import QuoteHistory from './QuoteHistory';
import { hasPublishedBlog } from '@/lib/checkin-service';
import QuoteBlogRequired from '@/app/components/QuoteBlogRequired';

// 往期一言 = 系统实际选用过的日期，只读。它**不要求今天签到**，也**不会**为今天或
// 缺日补抽（历史查询不调用 selectEdition）；今日内容仍按签到规则在弹窗里给。
export const dynamic = 'force-dynamic';

export default async function QuoteHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireCoreUser();
  if (!(await hasPublishedBlog(user.id))) return <QuoteBlogRequired />;
  const { page } = await searchParams;
  const result = await listQuoteHistory(user.id, Number(page ?? 1));

  return (
    <div className="container daily-quote-page">
      <header className="daily-quote-page__header">
        <h1>往期一言</h1>
        <Link href="/checkin" className="read-btn">返回签到</Link>
      </header>

      <DailyQuoteNav current="history" />

      {/* 通用规则说明一次，每张卡不再重复长段规则；费用在操作行给出。 */}
      <p className="daily-quote-page__note">
        每人每句限一次；站友投稿可收款时投喂 1 条鱼干，无法收款时不扣鱼干，经典免费。
      </p>

      {result.total ? (
        <QuoteHistory entries={result.editions} />
      ) : (
        <div className="daily-quote-state">
          <p>还没有往期一言。</p>
          <Link href="/checkin" className="read-btn">返回签到</Link>
        </div>
      )}

      <SitePager page={result.page} pages={result.pages} href={(p) => `/checkin/quotes?page=${p}`} />
    </div>
  );
}
