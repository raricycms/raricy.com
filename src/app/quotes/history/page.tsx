import { requireCoreUser } from '@/lib/guard';
import { hasPublishedBlog } from '@/lib/checkin-service';
import { listQuoteHistory } from '@/lib/daily-quote-service';
import QuoteBlogRequired from '@/app/components/QuoteBlogRequired';
import SitePager from '@/app/components/SitePager';
import QuoteHistory from '@/app/checkin/quotes/QuoteHistory';
import QuotePageShell from '../QuotePageShell';
export const dynamic='force-dynamic';
export default async function HistoryPage({searchParams}:{searchParams:Promise<{page?:string}>}){
  const {page}=await searchParams;
  const user=await requireCoreUser('/quotes/history'+(page?'?page='+encodeURIComponent(page):''));
  const allowed=await hasPublishedBlog(user.id);
  const result=allowed?await listQuoteHistory(user.id,Number(page??1)):null;
  return <QuotePageShell title="往期一言" current="history">
    {!allowed?<QuoteBlogRequired embedded/>:result?.total?<QuoteHistory entries={result.editions}/>:<div className="daily-quote-state"><p>还没有往期一言。</p></div>}
    {result&&<SitePager page={result.page} pages={result.pages} href={p=>'/quotes/history?page='+p}/>}
  </QuotePageShell>;
}
