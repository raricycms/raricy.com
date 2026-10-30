import Link from 'next/link';
import { requireCoreUser } from '@/lib/guard';
import { getTodayStatus } from '@/lib/checkin-service';
import { getTodayQuote } from '@/lib/daily-quote-service';
import QuoteBlogRequired from '@/app/components/QuoteBlogRequired';
import QuotePageShell from './QuotePageShell';
import TodayQuote from './TodayQuote';
export const dynamic='force-dynamic';
export const metadata={title:'每日一言',robots:{index:false,follow:false}};
export default async function QuotesPage(){
  const user=await requireCoreUser('/quotes');
  const status=await getTodayStatus(user.id);
  const result=status.canCheckIn&&status.checkedIn?await getTodayQuote(user.id):null;
  return <QuotePageShell title="每日一言" current="today">
    {!status.canCheckIn?<QuoteBlogRequired embedded/>:!status.checkedIn?
      <div className="daily-quote-state"><p>完成今日签到后查看今日一言。</p><Link className="read-btn" href="/checkin">去签到</Link></div>
      :result?.quote?<TodayQuote initial={result.quote}/>:<div className="daily-quote-state"><p>今日一言已下架。</p></div>}
  </QuotePageShell>;
}
