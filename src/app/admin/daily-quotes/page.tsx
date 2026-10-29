import Link from 'next/link';
import { requireAdmin } from '@/lib/guard';
import { listReviewQuotes, quoteReviewVersion } from '@/lib/daily-quote-service';
import { QUOTE_STATUSES, QUOTE_STATUS_LABELS } from '@/lib/daily-quote';
import { ymdhms } from '@/lib/format';
import AdminPageHeader from '@/app/components/AdminPageHeader';
import AdminDailyQuoteReview from '@/app/components/AdminDailyQuoteReview';

export const dynamic = 'force-dynamic';

export default async function DailyQuoteAdminPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const result = await listReviewQuotes(params.status ?? 'pending', Number(params.page ?? 1));
  return <>
    <AdminPageHeader title="每日一言审核" />
    <nav className="daily-quote-pagination" aria-label="稿件状态">
      {QUOTE_STATUSES.map((status) => <Link key={status} href={`/admin/daily-quotes?status=${status}`}
        className="read-btn" aria-current={result.status === status ? 'page' : undefined}>{QUOTE_STATUS_LABELS[status]}</Link>)}
    </nav>
    <p>共 {result.total} 条</p>
    <div className="daily-quote-list">
      {result.quotes.map((quote) => <article key={quote.id} className="daily-quote-panel">
        <div className="daily-quote-card__meta"><span>{quote.category}</span><span>{quote.kind === 'builtin' ? '系统内置' : '用户投稿'}</span></div>
        <p className="daily-quote-submission-text">{quote.content}</p>
        <p>投稿人：{quote.submitter?.username ?? quote.authorName}；展示署名：{quote.signature === 'anonymous' ? '匿名' : '昵称'}</p>
        <p>{quote.sourceType === 'original' ? '原创' : `引用自：${quote.sourceName}`}</p>
        <p className="daily-quote-card__hint numeric">{ymdhms(quote.createdAt)}</p>
        {quote.reviewReason && <p>审核说明：{quote.reviewReason}</p>}
        <AdminDailyQuoteReview id={quote.id} status={quote.status} version={quoteReviewVersion(quote)} />
      </article>)}
      {!result.quotes.length && <p>当前没有这类稿件。</p>}
    </div>
    <nav className="daily-quote-pagination" aria-label="审核分页">
      {result.page > 1 && <Link href={`/admin/daily-quotes?status=${result.status}&page=${result.page - 1}`} className="read-btn">上一页</Link>}
      {result.page < result.pages && <Link href={`/admin/daily-quotes?status=${result.status}&page=${result.page + 1}`} className="read-btn">下一页</Link>}
    </nav>
  </>;
}
