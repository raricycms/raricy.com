import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { listSubmissions } from '@/lib/daily-quote-service';
import { QUOTE_STATUS_LABELS } from '@/lib/daily-quote';
import { ymdhms } from '@/lib/format';
import DailyQuoteForm from '@/app/components/DailyQuoteForm';

export const dynamic = 'force-dynamic';

export default async function QuoteSubmissionsPage() {
  const user = await requireCoreUser();
  const submissions = await listSubmissions(user.id);
  return <div className="container daily-quote-page">
    <header className="daily-quote-page__header"><h1>我的一言投稿</h1><Link href="/checkin" className="read-btn">返回签到</Link></header>
    <section className="daily-quote-panel" aria-labelledby="new-quote-heading"><h2 id="new-quote-heading">提交一言</h2><DailyQuoteForm /></section>
    <section className="daily-quote-list" aria-labelledby="my-quotes-heading"><h2 id="my-quotes-heading">最近投稿</h2>
      {!submissions.length && <p>还没有投稿。</p>}
      {submissions.map((quote) => <article className="daily-quote-panel" key={quote.id}>
        <div className="daily-quote-card__meta"><span>{QUOTE_STATUS_LABELS[quote.status]}</span><span>{quote.category}</span><span>{quote.signature === 'anonymous' ? '匿名' : '昵称'}</span></div>
        <p className="daily-quote-submission-text">{quote.content}</p>
        <p className="daily-quote-card__hint">{quote.sourceType === 'original' ? '原创' : `引用自：${quote.sourceName}`}</p>
        <p className="daily-quote-card__hint numeric">{ymdhms(quote.createdAt)}</p>
        {quote.reviewReason && <p>审核说明：{quote.reviewReason}</p>}
      </article>)}
    </section>
  </div>;
}
