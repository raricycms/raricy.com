import { requireCoreUser } from '@/lib/guard';
import { listSubmissions } from '@/lib/daily-quote-service';
import { QUOTE_STATUS_LABELS } from '@/lib/daily-quote';
import { ymdhms } from '@/lib/format';
import DailyQuoteForm from '@/app/components/DailyQuoteForm';
import QuotePageShell from '../QuotePageShell';
import DailyQuoteSubmissionEditor from '@/app/components/DailyQuoteSubmissionEditor';
import { hasPublishedBlog } from '@/lib/checkin-service';
import { isCurrentlyBanned } from '@/lib/auth';
import QuoteBlogRequired from '@/app/components/QuoteBlogRequired';
import QuoteRevisionHistory from '@/app/components/QuoteRevisionHistory';

export const dynamic = 'force-dynamic';

export default async function QuoteSubmissionsPage() {
  const user = await requireCoreUser('/quotes/submissions');
  const allowed = await hasPublishedBlog(user.id);
  const readOnly = isCurrentlyBanned(user);
  const submissions = allowed ? await listSubmissions(user.id) : [];
  return <QuotePageShell title="我的投稿" current="submissions">
    {!allowed ? <QuoteBlogRequired embedded /> : <>
    {!readOnly && <section className="daily-quote-panel" aria-labelledby="new-quote-heading"><h2 id="new-quote-heading">提交一言</h2><DailyQuoteForm /></section>}
    {readOnly && <p>禁言期间只能查看投稿。</p>}
    <section className="daily-quote-list" aria-labelledby="my-quotes-heading"><h2 id="my-quotes-heading">最近投稿</h2>
      {!submissions.length && <p>还没有投稿。</p>}
      {submissions.map((quote) => <article className="daily-quote-panel" key={quote.id}>
        <div className="daily-quote-card__meta"><span>{QUOTE_STATUS_LABELS[quote.display_status]}</span><span>{quote.category}</span><span>{quote.signature === 'anonymous' ? '匿名' : '昵称'}</span></div>
        {quote.firstSelectedDay && <p className="daily-quote-card__hint numeric">选登于 {quote.firstSelectedDay}</p>}
        <DailyQuoteSubmissionEditor readOnly={readOnly} submission={{
          id: quote.id, content: quote.content, category: quote.category, signature: quote.signature,
          source_type: quote.sourceType, source_name: quote.sourceName, status: quote.status, version: quote.version,
        }}>
          <p className="daily-quote-submission-text">{quote.content}</p>
          <p className="daily-quote-card__hint">{quote.sourceType === 'original' ? '原创' : `引用自：${quote.sourceName}`}</p>
          <p className="daily-quote-card__hint numeric">{ymdhms(quote.createdAt)}</p>
          {quote.reviewReason && <p>审核说明：{quote.reviewReason}</p>}
        </DailyQuoteSubmissionEditor>
        <QuoteRevisionHistory revisions={quote.revisions} />
      </article>)}
    </section>
    </>}
  </QuotePageShell>;
}
